'use strict';

const fs = require('node:fs');
const path = require('node:path');

const { get, run, getDbFile, closeDb, initDb, nowIso } = require('../db');
const { HttpError } = require('../router');
const { createZip } = require('../lib/zip');
const { readZipEntry, listZipEntries } = require('../lib/zipread');
const { effectiveConfig, publicSettings, loadFileConfig, writeFileConfig, removeKeyFromDb, DATA_FILE_KEY } = require('../config');
const { recoverStaleJobs } = require('./batch');

const ZIP_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]*\.zip$/;

function pad(n) {
  return String(n).padStart(2, '0');
}

/** backup-2026-10-16-1730 这样的时间戳 */
function stamp(d) {
  const x = d || new Date();
  return `${x.getFullYear()}-${pad(x.getMonth() + 1)}-${pad(x.getDate())}-${pad(x.getHours())}${pad(x.getMinutes())}`;
}

function dateKey(d) {
  const x = d || new Date();
  return `${x.getFullYear()}-${pad(x.getMonth() + 1)}-${pad(x.getDate())}`;
}

function dirOf(ctx) {
  return path.join(ctx.storageDir, 'backups');
}

function assertName(name) {
  const s = String(name || '');
  if (!ZIP_NAME.test(s)) throw new HttpError(400, '备份文件名不合法');
  return s;
}

function resolveBackup(ctx, name) {
  const safe = assertName(name);
  const file = path.join(dirOf(ctx), safe);
  const base = path.resolve(dirOf(ctx));
  if (!path.resolve(file).startsWith(base)) throw new HttpError(400, '备份文件名不合法');
  if (!fs.existsSync(file)) throw new HttpError(404, '找不到这个备份文件');
  return file;
}

function listBackups(ctx) {
  const dir = dirOf(ctx);
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir)
    .filter((n) => n.toLowerCase().endsWith('.zip'))
    .map((n) => {
      const st = fs.statSync(path.join(dir, n));
      return {
        name: n,
        size: st.size,
        createdAt: st.mtime.toISOString(),
        kind: n.startsWith('backup-') ? 'backup' : 'pre-restore',
        url: '/backups/' + encodeURIComponent(n),
      };
    })
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt) || b.name.localeCompare(a.name));
}

function uniquePath(dir, baseName) {
  let name = baseName;
  let i = 2;
  while (fs.existsSync(path.join(dir, name))) {
    name = baseName.replace(/\.zip$/, '') + '-' + i + '.zip';
    i += 1;
  }
  return path.join(dir, name);
}

/** 把当前数据（+ 可选图片）打包成一个 zip */
function buildBackupBuffer(ctx, options) {
  const opts = options || {};
  const dbFile = getDbFile();
  const entries = [
    { name: 'paper.db', data: fs.readFileSync(dbFile) },
  ];
  let attachmentCount = 0;
  if (opts.includeAttachments !== false && fs.existsSync(ctx.attachmentsDir)) {
    fs.readdirSync(ctx.attachmentsDir).forEach((n) => {
      const p = path.join(ctx.attachmentsDir, n);
      if (fs.statSync(p).isFile()) {
        entries.push({ name: 'attachments/' + n, data: fs.readFileSync(p) });
        attachmentCount += 1;
      }
    });
  }
  const manifest = {
    app: '试卷批改专属 App',
    version: '1.0.0',
    createdAt: nowIso(),
    dbFile: path.basename(dbFile),
    includeAttachments: opts.includeAttachments !== false,
    attachmentCount,
    // 备份包里只有试卷数据，不含 API Key（Key 在用户主目录的私有配置文件里）
    apiKeyIncluded: false,
    counts: {
      questions: get('SELECT COUNT(*) AS c FROM questions').c,
      papers: get('SELECT COUNT(*) AS c FROM papers').c,
      students: get('SELECT COUNT(*) AS c FROM students').c,
      submissions: get('SELECT COUNT(*) AS c FROM submissions').c,
      gradeSheets: get('SELECT COUNT(*) AS c FROM grade_sheets').c,
    },
  };
  entries.push({ name: 'manifest.json', data: Buffer.from(JSON.stringify(manifest, null, 2), 'utf8') });
  return { buffer: createZip(entries), manifest };
}

function createBackup(ctx, options) {
  const dir = dirOf(ctx);
  fs.mkdirSync(dir, { recursive: true });
  const { buffer, manifest } = buildBackupBuffer(ctx, options);
  const target = uniquePath(dir, 'backup-' + stamp() + '.zip');
  fs.writeFileSync(target, buffer);
  return {
    name: path.basename(target),
    size: fs.statSync(target).size,
    url: '/backups/' + encodeURIComponent(path.basename(target)),
    manifest,
  };
}

function readManifest(file) {
  try {
    const raw = readZipEntry(fs.readFileSync(file), 'manifest.json');
    return raw ? JSON.parse(raw.toString('utf8')) : null;
  } catch (_) {
    return null;
  }
}

/**
 * 从备份恢复。顺序很重要：
 *   1) 把当前数据先另存一份（pre-restore），确保选错文件也能回头
 *   2) 关掉数据库连接，再覆盖数据文件（避免写一半）
 *   3) 重新打开，并把上次没跑完的批量任务置为暂停
 */
function restoreBackup(ctx, name) {
  const file = resolveBackup(ctx, name);
  const buf = fs.readFileSync(file);
  const dbBytes = readZipEntry(buf, 'paper.db');
  if (!dbBytes || !dbBytes.length) {
    throw new HttpError(400, '这个 zip 里没有 paper.db，不是本应用生成的备份');
  }

  const dir = dirOf(ctx);
  fs.mkdirSync(dir, { recursive: true });
  // 1) 恢复前自动另存当前数据
  const preTarget = uniquePath(dir, 'pre-restore-' + stamp() + '.zip');
  const { buffer: preBuf } = buildBackupBuffer(ctx, { includeAttachments: true });
  fs.writeFileSync(preTarget, preBuf);

  const dbFile = getDbFile();
  const manifest = readManifest(file);
  const wantedAttachments = (manifest && manifest.includeAttachments === false) ? null : 'auto';

  // 2) 关连接 → 覆盖文件 → 重开
  closeDb();
  try {
    fs.writeFileSync(dbFile, dbBytes);
    [dbFile + '-wal', dbFile + '-shm', dbFile + '-journal'].forEach((p) => {
      if (fs.existsSync(p)) fs.unlinkSync(p);
    });

    if (wantedAttachments) {
      const names = listZipEntries(buf).filter((n) => n.startsWith('attachments/') && !n.endsWith('/'));
      if (names.length) {
        fs.mkdirSync(ctx.attachmentsDir, { recursive: true });
        // 备份里带了附件，就以备份为准：先清空再铺开
        fs.readdirSync(ctx.attachmentsDir).forEach((n) => {
          const p = path.join(ctx.attachmentsDir, n);
          if (fs.statSync(p).isFile()) fs.unlinkSync(p);
        });
        names.forEach((n) => {
          const data = readZipEntry(buf, n);
          if (data) fs.writeFileSync(path.join(ctx.attachmentsDir, path.basename(n)), data);
        });
      }
    }
  } finally {
    initDb(dbFile);
  }

  recoverStaleJobs();
  // 老的备份包里可能带着 Key（早期版本把 Key 存进了数据库），恢复后立刻清掉
  removeKeyFromDb();

  return {
    ok: true,
    restored: path.basename(file),
    preRestore: path.basename(preTarget),
    manifest,
    attachmentsRestored: wantedAttachments ? 'from-backup' : 'kept',
  };
}

/** 自动备份：每天首次启动做一份，只保留最近 N 份 */
function runAutoBackup(ctx) {
  const cfg = effectiveConfig(ctx.configDir);
  if (cfg.autoBackup === false) return { created: false, reason: '未开启自动备份' };

  const today = dateKey();
  const existing = listBackups(ctx).filter((b) => b.kind === 'backup' && dateKey(new Date(b.createdAt)) === today);
  let created = false;
  let name = existing.length ? existing[0].name : null;

  if (!existing.length) {
    const res = createBackup(ctx, { includeAttachments: false });
    created = true;
    name = res.name;
  }

  const keep = Math.max(1, Number(cfg.keepBackups) || 7);
  const allBackups = listBackups(ctx).filter((b) => b.kind === 'backup');
  const removed = [];
  allBackups.slice(keep).forEach((b) => {
    try {
      fs.unlinkSync(path.join(dirOf(ctx), b.name));
      removed.push(b.name);
    } catch (_) { /* 删不掉就留着，不影响使用 */ }
  });

  return { created, name, kept: allBackups.length - removed.length, removed };
}

/**
 * 数据文件位置。它本身是数据库文件，不能存进数据库，
 * 所以只能写进私有配置文件，改完提示重启服务生效（K12）。
 */
function changeDataFile(ctx, target) {
  const raw = String(target || '').trim();
  if (!raw) throw new HttpError(400, '请填写新的数据文件路径');
  if (!path.isAbsolute(raw)) throw new HttpError(400, '请填写完整的绝对路径，例如 D:\\试卷数据\\paper.db');
  const resolved = path.resolve(raw);
  const parent = path.dirname(resolved);
  if (!fs.existsSync(parent) || !fs.statSync(parent).isDirectory()) {
    throw new HttpError(400, '这个文件夹还不存在，请先用文件管理器建好：' + parent);
  }
  try {
    fs.accessSync(parent, fs.constants.W_OK);
  } catch (_) {
    throw new HttpError(400, '这个文件夹写不进去，换一个试试：' + parent);
  }
  if (path.resolve(getDbFile()) === resolved) {
    return { ok: true, needRestart: false, dataFile: resolved, message: '数据文件位置没有变化。' };
  }
  writeFileConfig(ctx.configDir, { [DATA_FILE_KEY]: resolved });
  return {
    ok: true,
    needRestart: true,
    dataFile: resolved,
    parent,
    message: '新位置已记下，重启服务后生效。当前这次运行仍在使用原来的数据文件。',
  };
}

function register(router, shared) {
  const ctx = shared;

  router.get('/api/settings', () => {
    const dbFile = getDbFile();
    let dbSize = 0;
    try { dbSize = fs.statSync(dbFile).size; } catch (_) { dbSize = 0; }
    const dir = dirOf(ctx);
    let backupCount = 0;
    try { backupCount = listBackups(ctx).length; } catch (_) { backupCount = 0; }
    const fileCfg = loadFileConfig(ctx.configDir);
    return {
      ...publicSettings(ctx.configDir),
      aiMode: ctx.aiMode,
      dataFile: dbFile,
      storageDir: ctx.storageDir,
      attachmentsDir: ctx.attachmentsDir,
      backupDir: dir,
      dbSize,
      backupCount,
      dataFileConfigured: Boolean(fileCfg[DATA_FILE_KEY]),
    };
  });

  router.put('/api/settings', (ctx2) => {
    const body = ctx2.body || {};
    const errors = [];

    function put(key, value) {
      run(
        'INSERT INTO settings(key, value) VALUES(?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value',
        key, String(value)
      );
    }

    if (body.baseUrl !== undefined) {
      const v = String(body.baseUrl).trim();
      if (v && !/^https?:\/\//i.test(v)) errors.push('接口地址要以 http:// 或 https:// 开头');
      else if (v) put('ai_base_url', v.replace(/\/+$/, ''));
    }
    if (body.model !== undefined) {
      const v = String(body.model).trim();
      if (!v) errors.push('模型名不能为空');
      else put('ai_model', v);
    }
    if (body.apiKey !== undefined && String(body.apiKey).trim()) {
      // 留空表示不覆盖，避免打码显示后一保存就把 Key 抹掉。
      // Key 只写私有配置文件（用户主目录下），不写数据库：
      // 数据库文件会被打进备份包，Key 跟着备份跑出去就失控了。
      writeFileConfig(ctx.configDir, { apiKey: String(body.apiKey).trim() });
      removeKeyFromDb();
    }
    if (body.aiDelayMs !== undefined) {
      const n = Number(body.aiDelayMs);
      if (!Number.isFinite(n) || n < 0) errors.push('每次请求间隔必须是非负数字');
      else put('ai_delay_ms', Math.round(n));
    }
    if (body.doubtThreshold !== undefined) {
      const n = Number(body.doubtThreshold);
      if (!Number.isFinite(n) || n < 0 || n > 1) errors.push('存疑阈值要在 0 到 1 之间');
      else put('ai_doubt_threshold', n);
    }
    if (body.autoBackup !== undefined) put('backup_auto', body.autoBackup ? '1' : '0');
    if (body.keepBackups !== undefined) {
      const n = Number(body.keepBackups);
      if (!Number.isFinite(n) || n < 1 || n > 60) errors.push('保留份数要在 1 到 60 之间');
      else put('backup_keep', Math.round(n));
    }

    if (errors.length) throw new HttpError(400, errors.join('；'));
    return { ...publicSettings(ctx.configDir), aiMode: ctx.aiMode };
  });

  router.post('/api/settings/test-ai', async () => {
    const { testConnection } = require('../ai/qwen');
    if (ctx.aiMode === 'mock') {
      return { ok: false, mock: true, reason: '当前是「模拟 AI」模式（测试环境），不会真的联网调用。正式启动时会用真实接口。' };
    }
    const res = await testConnection(ctx.configDir);
    return { ...res, model: res.model || effectiveConfig(ctx.configDir).model };
  });

  router.put('/api/settings/data-file', (ctx2) => changeDataFile(ctx, (ctx2.body || {}).path));

  router.get('/api/backups', () => ({
    dir: dirOf(ctx),
    backups: listBackups(ctx),
  }));

  router.post('/api/backups', (ctx2) => {
    const body = ctx2.body || {};
    const started = Date.now();
    const res = createBackup(ctx, { includeAttachments: body.includeAttachments !== false });
    return { ...res, elapsedMs: Date.now() - started };
  });

  router.post('/api/backups/restore', (ctx2) => restoreBackup(ctx, (ctx2.body || {}).name));

  router.del('/api/backups/:name', (ctx2) => {
    const file = resolveBackup(ctx, ctx2.params.name);
    fs.unlinkSync(file);
    return { ok: true, deleted: path.basename(file) };
  });
}

module.exports = {
  register,
  createBackup,
  restoreBackup,
  listBackups,
  runAutoBackup,
  changeDataFile,
  dirOf,
  stamp,
};
