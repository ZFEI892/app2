'use strict';

const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const { initDb, getDb, getDbFile, closeDb } = require('./db');
const { Router, HttpError } = require('./router');
const { defaultConfigDir, migrateLegacyConfig, removeKeyFromDb } = require('./config');

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
};

/** 里程碑推进时在这里挂载新的路由模块 */
const ROUTE_MODULES = [
  './routes/students',
  './routes/questions',
  './routes/papers',
  './routes/submissions',
  './routes/grading',
  './routes/batch',
  './routes/stats',
  './routes/todos',
  './routes/settings',
  './routes/backup',
];

function sendJson(res, status, payload) {
  const text = JSON.stringify(payload, null, 0);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
  });
  res.end(text);
}

function readBody(req, limitBytes) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > limitBytes) {
        reject(new HttpError(413, '请求体过大'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

function safeJoin(base, relative) {
  const target = path.resolve(base, '.' + path.sep + relative.replace(/^[/\\]+/, ''));
  if (!target.startsWith(path.resolve(base))) return null;
  return target;
}

function createApp(options = {}) {
  const rootDir = options.rootDir || path.join(__dirname, '..');
  const dbFile = options.dbFile || path.join(rootDir, 'data', 'paper.db');
  const webDir = options.webDir || path.join(rootDir, 'web');
  const bodyLimit = options.bodyLimit || 32 * 1024 * 1024;
  // 私有配置（含 API Key）默认放在用户主目录下，跟项目文件夹彻底分开
  const configDir = options.configDir || defaultConfigDir();

  // 老版本写在项目目录里的 config.local.json：搬去私有目录后再读配置
  const migration = migrateLegacyConfig(rootDir, configDir);

  initDb(dbFile);
  // 老版本可能把 Key 存进过数据库，而备份包会把数据文件整个打包 → 清掉
  const keyPurged = removeKeyFromDb();

  const storageDir = dbFile === ':memory:' ? path.join(rootDir, 'data') : path.dirname(path.resolve(dbFile));
  const attachmentsDir = path.join(storageDir, 'attachments');
  const backupsDir = path.join(storageDir, 'backups');
  fs.mkdirSync(attachmentsDir, { recursive: true });
  fs.mkdirSync(backupsDir, { recursive: true });

  const router = new Router();

  const shared = {
    rootDir,
    configDir,
    storageDir,
    attachmentsDir,
    backupsDir,
    dbFile,
    configMigration: migration,
    keyPurged,
    aiMode: options.aiMode || process.env.APP_AI_MODE || 'live',
    aiChat: options.aiChat || null,
  };

  router.get('/api/health', () => ({
    ok: true,
    name: '试卷批改专属 App',
    version: '1.0.0',
    dbFile: getDbFile(),
    aiMode: shared.aiMode,
    time: new Date().toISOString(),
  }));

  for (const mod of ROUTE_MODULES) {
    let moduleRef;
    try {
      moduleRef = require(mod);
    } catch (err) {
      if (err && err.code === 'MODULE_NOT_FOUND' && String(err.message).includes(mod)) continue;
      throw err;
    }
    if (typeof moduleRef.register === 'function') moduleRef.register(router, shared);
  }

  async function handleApi(req, res, url) {
    const matched = router.match(req.method, url.pathname);
    if (!matched) throw new HttpError(404, `接口不存在：${url.pathname}`);
    const raw = await readBody(req, bodyLimit);
    let body = null;
    if (raw.length > 0) {
      try {
        body = JSON.parse(raw.toString('utf8'));
      } catch (_) {
        throw new HttpError(400, '请求体不是合法 JSON');
      }
    }
    const ctx = {
      req,
      res,
      params: matched.params,
      query: Object.fromEntries(url.searchParams),
      body,
      rootDir,
      configDir,
      storageDir,
      attachmentsDir,
      dbFile,
      aiMode: shared.aiMode,
      aiChat: shared.aiChat,
      getDb,
    };
    const result = await matched.handler(ctx);
    if (res.writableEnded) return;
    sendJson(res, 200, result === undefined ? { ok: true } : result);
  }

  function serveStatic(req, res, url) {
    let relative = decodeURIComponent(url.pathname);
    let baseDir = webDir;
    if (relative.startsWith('/files/')) {
      baseDir = attachmentsDir;
      relative = relative.slice('/files/'.length);
    } else if (relative.startsWith('/backups/')) {
      baseDir = backupsDir;
      relative = relative.slice('/backups/'.length);
    } else if (relative === '/' || relative === '') {
      relative = '/index.html';
    }
    const filePath = safeJoin(baseDir, relative);
    if (!filePath || !fs.existsSync(filePath) || !fs.statSync(filePath).isFile()) {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('404 找不到页面');
      return;
    }
    const ext = path.extname(filePath).toLowerCase();
    const isZip = ext === '.zip';
    res.writeHead(200, {
      'Content-Type': isZip ? 'application/zip' : (MIME[ext] || 'application/octet-stream'),
      'Cache-Control': 'no-store',
      ...(isZip ? { 'Content-Disposition': 'attachment; filename="' + path.basename(filePath) + '"' } : {}),
    });
    fs.createReadStream(filePath).pipe(res);
  }

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://127.0.0.1');
    try {
      if (url.pathname.startsWith('/api/')) {
        await handleApi(req, res, url);
      } else {
        serveStatic(req, res, url);
      }
    } catch (err) {
      if (res.writableEnded) return;
      if (err instanceof HttpError) {
        sendJson(res, err.status, { error: err.message, detail: err.detail || null });
      } else {
        sendJson(res, 500, { error: '服务器内部错误', detail: String(err && err.message ? err.message : err) });
      }
    }
  });

  function listen(port = 0, host = '127.0.0.1') {
    return new Promise((resolve, reject) => {
      const tryListen = (candidate, attemptsLeft) => {
        const onError = (err) => {
          server.removeListener('listening', onListening);
          if (err.code === 'EADDRINUSE' && candidate !== 0 && attemptsLeft > 0) {
            tryListen(candidate + 1, attemptsLeft - 1);
          } else {
            reject(err);
          }
        };
        const onListening = () => {
          server.removeListener('error', onError);
          resolve(server.address().port);
        };
        server.once('error', onError);
        server.once('listening', onListening);
        server.listen(candidate, host);
      };
      tryListen(port, 20);
    });
  }

  function close() {
    return new Promise((resolve) => {
      server.close(() => {
        closeDb();
        resolve();
      });
    });
  }

  return {
    server, router, listen, close, shared,
    rootDir, configDir, storageDir, attachmentsDir, backupsDir, dbFile,
    configMigration: migration,
  };
}

module.exports = { createApp, HttpError, sendJson, safeJoin };
