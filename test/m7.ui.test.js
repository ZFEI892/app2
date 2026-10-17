'use strict';

/** 设置页渲染测试：与 m6.ui.test.js 同套路，用 DOM 垫片 + 真实后端跑一遍 render() */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const { startApp, ok, tempDir } = require('./helpers');
const { loadFrontend, has } = require('./dom');

const PAGES = ['pages/settings.js'];

test('M7·前端 · 设置页把 AI、数据文件、备份、自动备份四块都渲染出来', async (t) => {
  const ctx = await startApp({ rootDir: tempDir('pgroot-') });
  t.after(() => ctx.close());

  const { registry, root } = loadFrontend(ctx.base, PAGES);
  assert.ok(registry.settings, '设置页脚本应注册到 App');
  await registry.settings.render(root, {});

  const html = root.innerHTML;
  ['AI 批改服务', '数据文件', '备份与恢复', '自动备份',
    '保存设置', '测试连接', '一键备份', '换位置'].forEach((k) => has(html, k));

  has(html, 'data-f="baseUrl"');
  has(html, 'data-f="model"');
  has(html, 'data-f="apiKey"');
  has(html, 'data-f="doubtThreshold"');
  has(html, 'data-f="autoBackup"');
  has(html, 'data-f="keepBackups"');

  // 数据文件的真实路径要显示出来，且能在磁盘上找到
  has(html, ctx.dbFile);
  assert.ok(fs.existsSync(ctx.dbFile));
  has(html, ctx.attachmentsDir);
  has(html, ctx.backupsDir);

  // 还没配 Key 时要说清楚
  has(html, '还没配置');
  // 默认模型要显示出来
  has(html, 'qwen3.8-max-0902');
  // 模拟模式下要老实说明
  has(html, '模拟');
  // 还没有备份 → 给引导，而不是空表
  has(html, '还没有备份');
});

test('M7·前端 · 设置页列出备份，并给出另存 / 恢复入口', async (t) => {
  const ctx = await startApp({ rootDir: tempDir('pgroot-') });
  t.after(() => ctx.close());

  const q = ok(await ctx.api.post('/api/questions', {
    stem: '题', rubricType: 'text', rubricText: '说明', points: 5,
  })).question;
  const paper = ok(await ctx.api.post('/api/papers', { name: '备份用卷' })).paper;
  ok(await ctx.api.put('/api/papers/' + paper.id + '/questions', { questions: [{ questionId: q.id }] }));

  const bak = ok(await ctx.api.post('/api/backups', {}));

  const { registry, root } = loadFrontend(ctx.base, PAGES);
  await registry.settings.render(root, {});

  const html = root.innerHTML;
  has(html, bak.name);
  has(html, '/backups/');
  has(html, 'download');
  has(html, 'data-restore="' + bak.name + '"');
  has(html, 'data-del="' + bak.name + '"');
  has(html, '另存');
  assert.ok(!html.includes('还没有备份'), '有备份时不该再显示空状态');
  assert.ok(!html.includes('sk-'), '页面上不能出现任何 Key 明文');
});

test('M7·前端 · 已配好 Key 时只显示打码值，且提示留空不覆盖', async (t) => {
  const ctx = await startApp({ rootDir: tempDir('pgroot-') });
  t.after(() => ctx.close());
  ok(await ctx.api.put('/api/settings', { apiKey: 'sk-secret-abcdefgh1234' }));

  const { registry, root } = loadFrontend(ctx.base, PAGES);
  await registry.settings.render(root, {});

  const html = root.innerHTML;
  has(html, '****1234');
  has(html, '留空则不覆盖');
  assert.ok(!html.includes('sk-secret-abcdefgh1234'), '明文 Key 绝不能出现在页面上');
});
