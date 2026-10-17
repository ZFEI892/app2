'use strict';

const test = require('node:test');
const assert = require('node:assert');

const { getDb, nowIso } = require('../server/db');
const { startApp, ok } = require('./helpers');

const ITEM_QUESTION = {
  stem: '一物体从 45 m 高处自由下落，求落地时间。',
  refAnswer: 't = √(2h/g) = 3 s',
  rubricType: 'items',
  items: [
    { text: '正确选取研究对象，受力分析完整', points: 4 },
    { text: '列式与推导过程正确', points: 3 },
    { text: '结果与单位规范', points: 1 },
  ],
  subject: '物理',
  knowledge: '自由落体',
  qtype: '计算题',
  difficulty: '中',
};

test('M2 · 分项得分点：总分自动累加为各得分点之和', async (t) => {
  const ctx = await startApp();
  t.after(() => ctx.close());

  const created = ok(await ctx.api.post('/api/questions', ITEM_QUESTION)).question;
  assert.strictEqual(created.points, 8, '4 + 3 + 1 = 8');
  assert.strictEqual(created.items.length, 3);
  assert.deepStrictEqual(created.items.map((i) => i.seq), [1, 2, 3]);
  assert.strictEqual(created.rubricType, 'items');
});

test('M2 · 一段文字说明：分值取题目总分', async (t) => {
  const ctx = await startApp();
  t.after(() => ctx.close());

  const created = ok(await ctx.api.post('/api/questions', {
    stem: '简述牛顿第一定律。',
    refAnswer: '一切物体在没有受到外力作用时……',
    rubricType: 'text',
    rubricText: '答出"保持静止或匀速直线运动"得 4 分，答出"惯性"再得 2 分。',
    points: 6,
    subject: '物理',
  })).question;

  assert.strictEqual(created.points, 6);
  assert.strictEqual(created.rubricType, 'text');
  assert.strictEqual(created.items.length, 0);
});

test('M2 · 校验：题干为空 / 无得分点 / 分值非正 都应 400', async (t) => {
  const ctx = await startApp();
  t.after(() => ctx.close());

  assert.strictEqual((await ctx.api.post('/api/questions', { ...ITEM_QUESTION, stem: '   ' })).status, 400);
  assert.strictEqual((await ctx.api.post('/api/questions', { ...ITEM_QUESTION, items: [] })).status, 400);
  assert.strictEqual((await ctx.api.post('/api/questions', {
    ...ITEM_QUESTION, items: [{ text: '甲', points: 0 }],
  })).status, 400);
  assert.strictEqual((await ctx.api.post('/api/questions', {
    ...ITEM_QUESTION, items: [{ text: '', points: 3 }],
  })).status, 400);
  assert.strictEqual((await ctx.api.post('/api/questions', {
    stem: 'x', rubricType: 'text', rubricText: '', points: 5,
  })).status, 400);
  assert.strictEqual((await ctx.api.post('/api/questions', {
    stem: 'x', rubricType: 'text', rubricText: '说明', points: 0,
  })).status, 400);
  assert.strictEqual((await ctx.api.post('/api/questions', { ...ITEM_QUESTION, rubricType: 'unknown' })).status, 400);
  assert.strictEqual((await ctx.api.post('/api/questions', { ...ITEM_QUESTION, difficulty: '超难' })).status, 400);
});

test('M2 · 编辑：得分点整体替换，总分随新分值重算', async (t) => {
  const ctx = await startApp();
  t.after(() => ctx.close());

  const created = ok(await ctx.api.post('/api/questions', ITEM_QUESTION)).question;
  const updated = ok(await ctx.api.put('/api/questions/' + created.id, {
    ...ITEM_QUESTION,
    items: [
      { text: '受力分析', points: 5 },
      { text: '结果', points: 5 },
    ],
  })).question;

  assert.strictEqual(updated.points, 10);
  assert.strictEqual(updated.items.length, 2);

  const detail = ok(await ctx.api.get('/api/questions/' + created.id)).question;
  assert.strictEqual(detail.items.length, 2);
  assert.strictEqual(detail.items[0].text, '受力分析');
  assert.strictEqual(detail.points, 10);
});

test('M2 · 两种模式可互相切换', async (t) => {
  const ctx = await startApp();
  t.after(() => ctx.close());

  const created = ok(await ctx.api.post('/api/questions', ITEM_QUESTION)).question;
  const asText = ok(await ctx.api.put('/api/questions/' + created.id, {
    rubricType: 'text', rubricText: '整体给分 8 分。', points: 8,
  })).question;
  assert.strictEqual(asText.rubricType, 'text');
  assert.strictEqual(asText.items.length, 0);

  const backToItems = ok(await ctx.api.put('/api/questions/' + created.id, {
    rubricType: 'items', items: [{ text: '只看结果', points: 8 }],
  })).question;
  assert.strictEqual(backToItems.rubricType, 'items');
  assert.strictEqual(backToItems.points, 8);
  assert.strictEqual(backToItems.items.length, 1);
});

test('M2 · 筛选与搜索', async (t) => {
  const ctx = await startApp();
  t.after(() => ctx.close());

  ok(await ctx.api.post('/api/questions', ITEM_QUESTION));
  ok(await ctx.api.post('/api/questions', {
    stem: '配平方程式', rubricType: 'text', rubricText: '配平得 5 分', points: 5,
    subject: '化学', difficulty: '易',
  }));

  assert.strictEqual(ok(await ctx.api.get('/api/questions')).total, 2);
  assert.strictEqual(ok(await ctx.api.get('/api/questions?subject=' + encodeURIComponent('物理'))).total, 1);
  assert.strictEqual(ok(await ctx.api.get('/api/questions?difficulty=' + encodeURIComponent('易'))).total, 1);
  assert.strictEqual(ok(await ctx.api.get('/api/questions?q=' + encodeURIComponent('自由下落'))).total, 1);
  assert.strictEqual(ok(await ctx.api.get('/api/questions?q=' + encodeURIComponent('不存在的关键词'))).total, 0);

  const meta = ok(await ctx.api.get('/api/questions/meta'));
  assert.deepStrictEqual(meta.subjects.sort(), ['化学', '物理']);
  assert.deepStrictEqual(meta.difficulties, ['易', '中', '难']);
});

test('M2 · 复制为新题：内容一致、题干带副本、得分点独立', async (t) => {
  const ctx = await startApp();
  t.after(() => ctx.close());

  const created = ok(await ctx.api.post('/api/questions', ITEM_QUESTION)).question;
  const copy = ok(await ctx.api.post('/api/questions/' + created.id + '/duplicate', {})).question;

  assert.notStrictEqual(copy.id, created.id);
  assert.ok(copy.stem.includes('副本'));
  assert.strictEqual(copy.points, created.points);
  assert.strictEqual(copy.items.length, 3);

  ok(await ctx.api.put('/api/questions/' + copy.id, {
    rubricType: 'items', items: [{ text: '改过的', points: 1 }],
  }));
  const origin = ok(await ctx.api.get('/api/questions/' + created.id)).question;
  assert.strictEqual(origin.points, 8, '修改副本不应影响原题');
});

test('M2 · 删除：未被引用可直接删，被试卷引用时连带摘掉用题位置', async (t) => {
  const ctx = await startApp();
  t.after(() => ctx.close());

  const created = ok(await ctx.api.post('/api/questions', ITEM_QUESTION)).question;
  const removable = ok(await ctx.api.post('/api/questions', { ...ITEM_QUESTION, stem: '可删的题' })).question;

  ok(await ctx.api.del('/api/questions/' + removable.id));
  assert.strictEqual(ok(await ctx.api.get('/api/questions')).total, 1);

  const db = getDb();
  const now = nowIso();
  const paper = db.prepare(
    'INSERT INTO papers(name, status, pass_line, created_at, updated_at) VALUES(?,?,?,?,?)'
  ).run('引用测试卷', 'draft', 0, now, now);
  const paperId = Number(paper.lastInsertRowid);
  db.prepare(
    'INSERT INTO paper_questions(paper_id, question_id, seq, points) VALUES(?,?,?,?)'
  ).run(paperId, created.id, 1, null);

  const listed = ok(await ctx.api.get('/api/questions')).questions[0];
  assert.strictEqual(listed.usedInPapers, 1);

  // 删除时不再拦人：把用题位置、得分点一并摘干净，并如实回报删了什么
  const removed = ok(await ctx.api.del('/api/questions/' + created.id));
  assert.strictEqual(removed.usedInPapers, 1);
  assert.strictEqual(removed.removed.papers, 1);
  assert.strictEqual(removed.removed.paperQuestions, 1);
  assert.strictEqual(removed.removed.gradeItems, 0, '这道题没有任何评分明细，就不能虚报');

  assert.strictEqual(ok(await ctx.api.get('/api/questions')).total, 0);
  assert.strictEqual(
    db.prepare('SELECT COUNT(*) AS c FROM paper_questions WHERE paper_id = ?').get(paperId).c, 0
  );
  assert.strictEqual(
    db.prepare('SELECT COUNT(*) AS c FROM question_items WHERE question_id = ?').get(created.id).c, 0
  );
});

test('M2 · 持久化：题目与得分点重启后一字不差', async (t) => {
  const first = await startApp();
  const dbFile = first.dbFile;
  const dir = first.dir;
  const created = ok(await first.api.post('/api/questions', ITEM_QUESTION)).question;
  await first.close();

  const second = await startApp({ dir, dbFile });
  t.after(() => second.close());
  const detail = ok(await second.api.get('/api/questions/' + created.id)).question;

  assert.strictEqual(detail.stem, ITEM_QUESTION.stem);
  assert.strictEqual(detail.refAnswer, ITEM_QUESTION.refAnswer);
  assert.strictEqual(detail.points, 8);
  assert.deepStrictEqual(detail.items.map((i) => i.text), ITEM_QUESTION.items.map((i) => i.text));
});
