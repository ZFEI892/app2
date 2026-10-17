'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const net = require('node:net');
const path = require('node:path');

const { initDb, getDb, closeDb, tx, nowIso } = require('../server/db');
const { maskKey, publicSettings, effectiveConfig, DEFAULTS } = require('../server/config');
const { Router, HttpError } = require('../server/router');
const { tempDir, startApp, ok } = require('./helpers');

const EXPECTED_TABLES = [
  'questions', 'question_items', 'papers', 'paper_questions', 'students',
  'submissions', 'answers', 'grade_sheets', 'grade_items', 'batch_jobs',
  'todos', 'settings', 'audit_log',
];

test('M0 · 表结构：initDb 建出全部 13 张表', () => {
  const dir = tempDir();
  const file = path.join(dir, 'paper.db');
  initDb(file);
  const rows = getDb().prepare("SELECT name FROM sqlite_master WHERE type='table'").all();
  const names = rows.map((r) => r.name);
  EXPECTED_TABLES.forEach((t) => {
    assert.ok(names.includes(t), `缺少数据表：${t}`);
  });
  closeDb();
});

test('M0 · 持久化：关闭后重新打开，数据仍在（对应 PRD 验收 2 的存储前提）', () => {
  const dir = tempDir();
  const file = path.join(dir, 'paper.db');
  initDb(file);
  const now = nowIso();
  tx((db) => {
    db.prepare(
      'INSERT INTO questions(stem, rubric_type, rubric_text, points, created_at, updated_at) VALUES(?,?,?,?,?,?)'
    ).run('下落时间是多少？', 'text', '写出公式 6 分', 6, now, now);
  });
  closeDb();

  initDb(file);
  const row = getDb().prepare('SELECT * FROM questions').get();
  assert.strictEqual(row.stem, '下落时间是多少？');
  assert.strictEqual(row.rubric_type, 'text');
  assert.strictEqual(row.points, 6);
  closeDb();
});

test('M0 · 事务：抛错时回滚', () => {
  const dir = tempDir();
  initDb(path.join(dir, 'paper.db'));
  const now = nowIso();
  assert.throws(() => {
    tx((db) => {
      db.prepare('INSERT INTO students(name, created_at) VALUES(?,?)').run('临时', now);
      throw new Error('故意失败');
    });
  }, /故意失败/);
  const count = getDb().prepare('SELECT COUNT(*) AS c FROM students').get().c;
  assert.strictEqual(count, 0, '事务失败后应回滚，学生表应为空');
  closeDb();
});

test('M0 · 路由：路径参数解析与 405', () => {
  const router = new Router();
  router.get('/api/papers/:id/questions/:qid', (ctx) => ctx.params);
  const matched = router.match('GET', '/api/papers/12/questions/34');
  assert.deepStrictEqual(matched.params, { id: '12', qid: '34' });
  assert.throws(() => router.match('POST', '/api/papers/12/questions/34'), (e) => e instanceof HttpError && e.status === 405);
  assert.strictEqual(router.match('GET', '/api/nope'), null);
});

test('M0 · 配置：Key 只以打码形式对外暴露', () => {
  const dir = tempDir();
  initDb(path.join(dir, 'paper.db'));
  const fakeKey = 'sk-testkey-1234567890abcd';
  const fileCfgPath = path.join(dir, 'config.local.json');
  fs.writeFileSync(fileCfgPath, JSON.stringify({ apiKey: fakeKey, model: 'demo-model' }), 'utf8');

  assert.strictEqual(maskKey(fakeKey), '****abcd');
  assert.strictEqual(maskKey(''), '');

  const pub = publicSettings(dir);
  assert.strictEqual(pub.apiKeyMasked, '****abcd');
  assert.ok(!JSON.stringify(pub).includes(fakeKey), '对外设置中不得出现明文 Key');
  assert.strictEqual(pub.model, 'demo-model');

  const eff = effectiveConfig(dir);
  assert.strictEqual(eff.apiKey, fakeKey, '服务端内部配置仍可取到明文 Key');
  assert.strictEqual(eff.baseUrl, DEFAULTS.baseUrl);
  closeDb();
});

test('M0 · 服务：能启动、托管静态页、/api/health 可用', async (t) => {
  const ctx = await startApp();
  t.after(() => ctx.close());

  const health = ok(await ctx.api.get('/api/health'));
  assert.strictEqual(health.ok, true);
  assert.strictEqual(health.dbFile, ctx.dbFile);

  const page = await ctx.api.get('/');
  assert.strictEqual(page.status, 200);
  assert.ok(page.text.includes('试卷批改'), '首页应包含标题');

  const css = await ctx.api.get('/style.css');
  assert.strictEqual(css.status, 200);

  const missing = await ctx.api.get('/不存在.html');
  assert.strictEqual(missing.status, 404);
});

test('M0 · 服务：未知接口 404、方法不匹配 405', async (t) => {
  const ctx = await startApp();
  t.after(() => ctx.close());

  const notFound = await ctx.api.get('/api/definitely-not-here');
  assert.strictEqual(notFound.status, 404);
  assert.ok(notFound.data.error.includes('接口不存在'));

  const wrongMethod = await ctx.api.post('/api/health', {});
  assert.strictEqual(wrongMethod.status, 405);
});

test('M0 · 服务：端口被占用时自动顺延', async (t) => {
  const blocker = net.createServer();
  await new Promise((resolve) => blocker.listen(0, '127.0.0.1', resolve));
  const busyPort = blocker.address().port;
  t.after(() => new Promise((resolve) => blocker.close(resolve)));

  const ctx = await startApp({ port: busyPort });
  t.after(() => ctx.close());
  assert.notStrictEqual(ctx.port, busyPort, '端口被占用时应自动换端口');
  assert.ok(ctx.port > busyPort);
});

test('M0 · 数据文件：启动后自动创建 data 目录与数据库文件', async (t) => {
  const ctx = await startApp();
  t.after(() => ctx.close());
  assert.ok(fs.existsSync(ctx.dbFile), '数据库文件应已创建');
  assert.ok(fs.existsSync(path.join(path.dirname(ctx.dbFile), 'attachments')), 'attachments 目录应已创建');
});
