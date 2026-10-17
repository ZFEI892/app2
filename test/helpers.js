'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createApp } = require('../server/app');

const ROOT_DIR = path.join(__dirname, '..');

function tempDir(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix || 'pgapp-'));
}

function makeApi(base) {
  async function call(method, p, body) {
    const headers = {};
    let payload;
    if (body !== undefined) {
      headers['Content-Type'] = 'application/json';
      payload = JSON.stringify(body);
    }
    const res = await fetch(base + p, { method, headers, body: payload });
    const text = await res.text();
    let data = null;
    if (text) {
      try { data = JSON.parse(text); } catch (_) { data = { raw: text }; }
    }
    return { status: res.status, data, text };
  }
  return {
    call,
    get: (p) => call('GET', p),
    post: (p, b) => call('POST', p, b),
    put: (p, b) => call('PUT', p, b),
    del: (p) => call('DELETE', p),
  };
}

async function startApp(options = {}) {
  const dir = options.dir || tempDir();
  // rootDir 是「应用以为的项目目录」。测试里绝不能指向真实项目目录：
  // 启动时会做配置迁移，指错了就会把用户真实的 config.local.json 搬走甚至覆盖掉。
  const rootDir = options.rootDir || tempDir('pgroot-');
  if (path.resolve(rootDir) === path.resolve(ROOT_DIR)) {
    throw new Error('测试不能把 rootDir 指向真实项目目录：' + rootDir);
  }
  const dbFile = options.dbFile || path.join(dir, 'paper.db');
  // 私有配置（含 API Key）默认放在用户主目录，测试里必须换成独立临时目录，
  // 否则多个用例会互相覆盖配置、也会污染真实用户目录。
  const configDir = options.configDir || tempDir('pgcfg-');
  const app = createApp({
    rootDir,
    dbFile,
    configDir,
    // 前端资源始终从真实项目目录提供，这样测试可以放心把 rootDir 指到临时目录
    webDir: options.webDir || path.join(ROOT_DIR, 'web'),
    aiMode: options.aiMode || 'mock',
    aiChat: options.aiChat || null,
  });
  const port = await app.listen(options.port === undefined ? 0 : options.port);
  const base = `http://127.0.0.1:${port}`;
  return {
    app,
    port,
    base,
    dir,
    rootDir,
    configDir,
    configFile: path.join(configDir, 'config.local.json'),
    dbFile,
    storageDir: app.storageDir,
    attachmentsDir: app.attachmentsDir,
    backupsDir: app.backupsDir,
    api: makeApi(base),
    close: () => app.close(),
  };
}

/** 断言成功响应（2xx）并直接返回 data */
function ok(res) {
  if (res.status < 200 || res.status >= 300) {
    throw new Error(`预期成功，实际 ${res.status}：${JSON.stringify(res.data)}`);
  }
  return res.data;
}

module.exports = { ROOT_DIR, tempDir, startApp, makeApi, ok };
