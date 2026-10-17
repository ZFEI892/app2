'use strict';

/**
 * API Key 安全：Key 不能出现在代码里、不能进数据文件、不能进备份包。
 * 这三条任何一条破掉，用户把项目文件夹或备份 zip 发给别人，Key 就跟着泄露了。
 *
 * 现在的规则：
 *   - 代码里零 Key（默认值就是空字符串）
 *   - Key 只写用户主目录下的私有配置文件（.paper-grading/config.local.json）
 *   - 数据库 settings 表里不留 Key，老版本留下的启动时清掉
 *   - 备份 zip 里只有试卷数据，不含 Key
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');

const { startApp, ok, tempDir, ROOT_DIR } = require('./helpers');
const { readZipEntry } = require('../server/lib/zipread');
const { createZip } = require('../server/lib/zip');
const { getDb } = require('../server/db');
const { loadFrontend, has } = require('./dom');

const KEY = 'sk-keysafe-1234567890abcdef';
const SETTINGS_PAGES = ['pages/settings.js'];

/** 数据库里还留着几条 ai_api_key */
function keyRowsInDb() {
  return getDb().prepare("SELECT COUNT(*) AS c FROM settings WHERE key = 'ai_api_key'").get().c;
}

/** 用手写 SQL 把 Key 塞进数据库（模拟老版本的行为） */
function plantKeyInDb(value) {
  getDb()
    .prepare("INSERT INTO settings(key, value) VALUES('ai_api_key', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value")
    .run(value);
}

function readConfig(configDir) {
  return JSON.parse(fs.readFileSync(path.join(configDir, 'config.local.json'), 'utf8'));
}

test('Key 安全 · 保存后只落在项目外的私有配置文件里，数据文件与项目目录都没有', async (t) => {
  const rootDir = tempDir('pgroot-');
  const configDir = tempDir('pgcfg-');
  const ctx = await startApp({ rootDir, configDir });
  t.after(() => ctx.close());

  ok(await ctx.api.put('/api/settings', { apiKey: KEY }));

  assert.strictEqual(readConfig(configDir).apiKey, KEY, 'Key 要写进私有配置文件');
  assert.ok(
    !fs.existsSync(path.join(rootDir, 'config.local.json')),
    '项目（这里是项目的替身目录）里不该出现配置文件'
  );
  assert.strictEqual(keyRowsInDb(), 0, 'Key 绝不能写进数据库');
  assert.ok(
    !fs.readFileSync(ctx.dbFile).includes(Buffer.from(KEY)),
    '数据文件里不该出现 Key 明文'
  );
});

test('Key 安全 · 接口只回打码值，并告知 Key 存在哪个文件', async (t) => {
  const configDir = tempDir('pgcfg-');
  const ctx = await startApp({ rootDir: tempDir('pgroot-'), configDir });
  t.after(() => ctx.close());
  ok(await ctx.api.put('/api/settings', { apiKey: KEY }));

  const s = ok(await ctx.api.get('/api/settings'));
  assert.strictEqual(s.apiKeySet, true);
  assert.strictEqual(s.apiKeyMasked, '****cdef');
  assert.ok(!JSON.stringify(s).includes(KEY), '任何响应里都不能出现明文 Key');
  assert.strictEqual(s.configFile, path.join(configDir, 'config.local.json'), '要能告诉用户 Key 存在哪');
});

test('Key 安全 · 备份包里不含 Key（整包、paper.db、库内表三处都验）', async (t) => {
  const configDir = tempDir('pgcfg-');
  const ctx = await startApp({ rootDir: tempDir('pgroot-'), configDir });
  t.after(() => ctx.close());
  ok(await ctx.api.put('/api/settings', { apiKey: KEY }));

  const res = ok(await ctx.api.post('/api/backups', { includeAttachments: true }));
  assert.strictEqual(res.manifest.apiKeyIncluded, false, '备份清单要写明不含 Key');

  const buf = fs.readFileSync(path.join(ctx.backupsDir, res.name));
  assert.ok(!buf.includes(Buffer.from(KEY)), '备份包整包里都不该有 Key');

  const dbBytes = readZipEntry(buf, 'paper.db');
  assert.ok(dbBytes && dbBytes.length, '备份包里要有数据文件');
  assert.ok(!dbBytes.includes(Buffer.from(KEY)), '备份包里的数据文件不该有 Key');

  // 把备份包里的数据库解出来单独打开，settings 表里也不能有
  const tmp = path.join(tempDir('pgunzip-'), 'paper.db');
  fs.writeFileSync(tmp, dbBytes);
  const db = new DatabaseSync(tmp);
  const c = db.prepare("SELECT COUNT(*) AS c FROM settings WHERE key = 'ai_api_key'").get().c;
  db.close();
  assert.strictEqual(c, 0, '备份里的数据库也不该存着 Key');
});

test('Key 安全 · 老版本写在项目目录里的配置文件会自动搬到私有目录并删掉原件', async (t) => {
  const rootDir = tempDir('pgroot-');
  const configDir = tempDir('pgcfg-');
  const legacy = path.join(rootDir, 'config.local.json');
  fs.writeFileSync(legacy, JSON.stringify({ apiKey: 'sk-legacy-abcd', model: 'legacy-model' }), 'utf8');

  const ctx = await startApp({ rootDir, configDir });
  t.after(() => ctx.close());

  assert.ok(!fs.existsSync(legacy), '搬完后项目目录里不能再留着 Key');
  assert.deepStrictEqual(
    readConfig(configDir),
    { apiKey: 'sk-legacy-abcd', model: 'legacy-model' },
    '旧配置要一字不差地搬到私有目录'
  );
  const s = ok(await ctx.api.get('/api/settings'));
  assert.strictEqual(s.apiKeyMasked, '****abcd');
  assert.strictEqual(s.model, 'legacy-model', '搬过来的配置要真的生效');
});

test('Key 安全 · 私有目录已有 Key 时不被旧文件覆盖，旧文件其余字段仍会补进来', async (t) => {
  const rootDir = tempDir('pgroot-');
  const configDir = tempDir('pgcfg-');
  fs.writeFileSync(
    path.join(configDir, 'config.local.json'),
    JSON.stringify({ apiKey: 'sk-current-wxyz' }),
    'utf8'
  );
  fs.writeFileSync(
    path.join(rootDir, 'config.local.json'),
    JSON.stringify({ apiKey: 'sk-stale-0000', dbFile: 'D:\\旧数据\\paper.db' }),
    'utf8'
  );

  const ctx = await startApp({ rootDir, configDir });
  t.after(() => ctx.close());

  const cfg = readConfig(configDir);
  assert.strictEqual(cfg.apiKey, 'sk-current-wxyz', '绝不能拿旧文件覆盖当前在用的 Key');
  assert.strictEqual(cfg.dbFile, 'D:\\旧数据\\paper.db', '旧文件里独有的设置要补进来，不能丢');
  assert.ok(!fs.existsSync(path.join(rootDir, 'config.local.json')), '旧文件搬完要删掉');
});

test('Key 安全 · 老版本留在数据库里的 Key，启动时会被清掉', async (t) => {
  const dir = tempDir('pgdata-');
  const configDir = tempDir('pgcfg-');
  const ctx1 = await startApp({ dir, configDir });
  plantKeyInDb('sk-legacy-in-db-9999');
  assert.strictEqual(keyRowsInDb(), 1);
  await ctx1.close();

  // 同一个数据文件再起一次 → 启动时清理
  const ctx2 = await startApp({ dir, configDir });
  t.after(() => ctx2.close());
  assert.strictEqual(keyRowsInDb(), 0, '启动时应把库里的 Key 清掉');
  assert.ok(
    !fs.readFileSync(ctx2.dbFile).includes(Buffer.from('sk-legacy-in-db-9999')),
    '清完还要回收数据页，别让文本工具还能从数据文件里捞出 Key'
  );
});

test('Key 安全 · 恢复带 Key 的老备份后，Key 也不会留在数据库里', async (t) => {
  const dir = tempDir('pgdata-');
  const configDir = tempDir('pgcfg-');
  const ctx = await startApp({ dir, configDir });
  t.after(() => ctx.close());

  // 造一个「老版本做的」备份：里面的 paper.db 存着 Key
  const legacyDb = path.join(tempDir('pglegacy-'), 'paper.db');
  fs.copyFileSync(ctx.dbFile, legacyDb);
  const raw = new DatabaseSync(legacyDb);
  raw
    .prepare("INSERT INTO settings(key, value) VALUES('ai_api_key', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value")
    .run('sk-inside-old-backup-7777');
  raw.close();

  const zip = createZip([
    { name: 'paper.db', data: fs.readFileSync(legacyDb) },
    {
      name: 'manifest.json',
      data: Buffer.from(JSON.stringify({ app: '试卷批改专属 App', includeAttachments: false }), 'utf8'),
    },
  ]);
  fs.mkdirSync(ctx.backupsDir, { recursive: true });
  fs.writeFileSync(path.join(ctx.backupsDir, 'backup-old-2020-01-01-0000.zip'), zip);

  const res = ok(await ctx.api.post('/api/backups/restore', { name: 'backup-old-2020-01-01-0000.zip' }));
  assert.strictEqual(res.ok, true);
  assert.strictEqual(keyRowsInDb(), 0, '恢复老备份后也要把 Key 清掉');
});

test('Key 安全 · 设置页把 Key 的存放位置写在明面上，且不出现明文', async (t) => {
  const configDir = tempDir('pgcfg-');
  const ctx = await startApp({ rootDir: tempDir('pgroot-'), configDir });
  t.after(() => ctx.close());
  ok(await ctx.api.put('/api/settings', { apiKey: KEY }));

  const { registry, root } = loadFrontend(ctx.base, SETTINGS_PAGES);
  await registry.settings.render(root, {});

  const html = root.innerHTML;
  has(html, ctx.configFile);
  has(html, '不会被打进备份包');
  has(html, '****cdef');
  assert.ok(!html.includes(KEY), '页面上绝不能出现明文 Key');
});

test('Key 安全 · 源码里没有任何硬编码的 Key', () => {
  const files = [];
  const walk = (dir) => {
    fs.readdirSync(dir, { withFileTypes: true }).forEach((e) => {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) return walk(p);
      if (/\.(js|css|html|sql|bat)$/.test(e.name)) files.push(p);
    });
  };
  [path.join(ROOT_DIR, 'server'), path.join(ROOT_DIR, 'web')].forEach(walk);
  assert.ok(files.length > 10, '应该扫到全部源码文件');

  const hits = [];
  files.forEach((f) => {
    const m = fs.readFileSync(f, 'utf8').match(/sk-[A-Za-z0-9._-]{12,}/g);
    if (m) hits.push(path.relative(ROOT_DIR, f) + ' → ' + m.join(' , '));
  });
  assert.deepStrictEqual(hits, [], '源码里出现了像 API Key 的字符串');
});

test('Key 安全 · 默认配置里 Key 就是空的', async (t) => {
  const { DEFAULTS, aiConfig } = require('../server/config');
  assert.strictEqual(DEFAULTS.apiKey, '', '默认值必须是空字符串，不能预置任何 Key');

  const ctx = await startApp({ rootDir: tempDir('pgroot-'), configDir: tempDir('pgcfg-') });
  t.after(() => ctx.close());
  const s = ok(await ctx.api.get('/api/settings'));
  assert.strictEqual(s.apiKeySet, false);
  assert.strictEqual(s.apiKeyMasked, '');
  assert.strictEqual(aiConfig(ctx.configDir).apiKey, '', '没配过就应该是空的');
});

test('Key 安全 · 测试装置不会碰真实项目目录（防回归）', async (t) => {
  // 启动时的配置迁移会搬走并删除项目目录里的 config.local.json。
  // 一旦测试把 rootDir 指向真实项目目录，就会把用户真实的 Key 搬走甚至覆盖掉。
  await assert.rejects(
    () => startApp({ rootDir: ROOT_DIR }),
    /不能把 rootDir 指向真实项目目录/,
    '把真实项目目录当 rootDir 必须直接报错，而不是悄悄动手'
  );

  const ctx = await startApp();
  t.after(() => ctx.close());
  assert.notStrictEqual(path.resolve(ctx.rootDir), path.resolve(ROOT_DIR), '默认就该用临时目录');
  assert.ok(
    !fs.existsSync(path.join(ROOT_DIR, 'config.local.json')),
    '跑完测试，真实项目目录里不该冒出配置文件'
  );
});

test('Key 安全 · 跑测试不会改动用户真实的私有配置文件', async (t) => {
  const { defaultConfigDir } = require('../server/config');
  const real = path.join(defaultConfigDir(), 'config.local.json');
  const before = fs.existsSync(real)
    ? { mtime: fs.statSync(real).mtimeMs, body: fs.readFileSync(real, 'utf8') }
    : null;

  const ctx = await startApp();          // 默认 rootDir / configDir 都该是临时目录
  t.after(() => ctx.close());
  ok(await ctx.api.put('/api/settings', { apiKey: KEY, model: 'should-not-touch-real-config' }));

  assert.notStrictEqual(path.resolve(ctx.configDir), path.resolve(defaultConfigDir()), '测试不能写进真实私有目录');
  if (before) {
    assert.strictEqual(fs.statSync(real).mtimeMs, before.mtime, '真实配置文件不该被测试改动');
    assert.strictEqual(fs.readFileSync(real, 'utf8'), before.body, '真实配置文件内容不该变');
  }
});
