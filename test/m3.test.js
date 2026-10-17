'use strict';

const test = require('node:test');
const assert = require('node:assert');

const { getDb, nowIso } = require('../server/db');
const { startApp, ok } = require('./helpers');
const { progressOf } = require('../server/routes/papers');

async function makeQuestion(ctx, stem, points) {
  return ok(await ctx.api.post('/api/questions', {
    stem,
    rubricType: 'text',
    rubricText: '说明',
    points,
  })).question;
}

function seedStudent(name) {
  const now = nowIso();
  const info = getDb().prepare('INSERT INTO students(name, created_at) VALUES(?,?)').run(name, now);
  return Number(info.lastInsertRowid);
}

function seedSubmission(paperId, studentId) {
  const now = nowIso();
  const info = getDb().prepare(
    'INSERT INTO submissions(paper_id, student_id, source, status, submitted_at, updated_at) VALUES(?,?,?,?,?,?)'
  ).run(paperId, studentId, 'manual', 'submitted', now, now);
  const id = Number(info.lastInsertRowid);
  getDb().prepare(
    'INSERT INTO grade_sheets(submission_id, status, created_at, updated_at) VALUES(?,?,?,?)'
  ).run(id, 'ungraded', now, now);
  return id;
}

test('M3 · 组卷：总分 = 各题生效分值之和', async (t) => {
  const ctx = await startApp();
  t.after(() => ctx.close());

  const q1 = await makeQuestion(ctx, '第一题', 4);
  const q2 = await makeQuestion(ctx, '第二题', 6);

  const paper = ok(await ctx.api.post('/api/papers', { name: '高一物理 · 第一次月考' })).paper;
  assert.strictEqual(paper.status, 'draft');

  const saved = ok(await ctx.api.put('/api/papers/' + paper.id + '/questions', {
    questions: [{ questionId: q1.id }, { questionId: q2.id }],
  }));
  assert.strictEqual(saved.total, 10, '4 + 6 = 10');

  const detail = ok(await ctx.api.get('/api/papers/' + paper.id));
  assert.strictEqual(detail.questions.length, 2);
  assert.deepStrictEqual(detail.questions.map((q) => q.seq), [1, 2]);
  assert.strictEqual(detail.paper.progress.questionCount, 2);
  assert.strictEqual(detail.paper.progress.passLine, 6, '未设及格线时按总分 60%');
});

test('M3 · 分值覆盖：试卷可覆盖题目自带分值', async (t) => {
  const ctx = await startApp();
  t.after(() => ctx.close());
  const q1 = await makeQuestion(ctx, '甲', 4);
  const paper = ok(await ctx.api.post('/api/papers', { name: '覆盖测试' })).paper;

  const saved = ok(await ctx.api.put('/api/papers/' + paper.id + '/questions', {
    questions: [{ questionId: q1.id, points: 7.5 }],
  }));
  assert.strictEqual(saved.total, 7.5);
  assert.strictEqual(saved.questions[0].points, 7.5);
  assert.strictEqual(saved.questions[0].pointsOverridden, true);

  const detail = ok(await ctx.api.get('/api/papers/' + paper.id));
  const cleared = ok(await ctx.api.put('/api/papers/' + paper.id + '/questions', {
    questions: [{ questionId: q1.id, points: null }],
  }));
  assert.strictEqual(cleared.total, 4, '清空覆盖后回到题目自带分值');
  void detail;
});

test('M3 · 组卷校验：题目必须存在、不可重复、分值必须为正', async (t) => {
  const ctx = await startApp();
  t.after(() => ctx.close());
  const q1 = await makeQuestion(ctx, '甲', 4);
  const paper = ok(await ctx.api.post('/api/papers', { name: '校验卷' })).paper;

  assert.strictEqual((await ctx.api.put('/api/papers/' + paper.id + '/questions', {
    questions: [{ questionId: 99999 }],
  })).status, 400);

  assert.strictEqual((await ctx.api.put('/api/papers/' + paper.id + '/questions', {
    questions: [{ questionId: q1.id }, { questionId: q1.id }],
  })).status, 400);

  assert.strictEqual((await ctx.api.put('/api/papers/' + paper.id + '/questions', {
    questions: [{ questionId: q1.id, points: 0 }],
  })).status, 400);

  assert.strictEqual((await ctx.api.put('/api/papers/' + paper.id + '/questions', {
    questions: 'not-an-array',
  })).status, 400);
});

test('M3 · 状态流转：草稿才能改题目，发布后锁定', async (t) => {
  const ctx = await startApp();
  t.after(() => ctx.close());
  const q1 = await makeQuestion(ctx, '甲', 5);
  const paper = ok(await ctx.api.post('/api/papers', { name: '流转卷' })).paper;

  // 无题卷也能发布：它是专门用来收「图片答卷」的卷子 —— 老师不用出题，
  // 直接收整卷照片让 AI 给一个总分，满分走卷上的 whole_full_marks。
  const emptyPublished = ok(await ctx.api.post('/api/papers/' + paper.id + '/publish', {})).paper;
  assert.strictEqual(emptyPublished.status, 'open', '没有题目的卷子也要能发布（图片答卷用）');
  ok(await ctx.api.post('/api/papers/' + paper.id + '/withdraw', {}));

  ok(await ctx.api.put('/api/papers/' + paper.id + '/questions', { questions: [{ questionId: q1.id }] }));
  const published = ok(await ctx.api.post('/api/papers/' + paper.id + '/publish', {})).paper;
  assert.strictEqual(published.status, 'open');

  const editBlocked = await ctx.api.put('/api/papers/' + paper.id + '/questions', { questions: [] });
  assert.strictEqual(editBlocked.status, 409);
  assert.ok(editBlocked.data.error.includes('锁定'));

  assert.strictEqual((await ctx.api.post('/api/papers/' + paper.id + '/publish', {})).status, 409, '不能重复发布');

  const withdrawn = ok(await ctx.api.post('/api/papers/' + paper.id + '/withdraw', {})).paper;
  assert.strictEqual(withdrawn.status, 'draft');
  ok(await ctx.api.put('/api/papers/' + paper.id + '/questions', { questions: [{ questionId: q1.id, points: 6 }] }));
});

test('M3 · 状态流转：非法操作被拒', async (t) => {
  const ctx = await startApp();
  t.after(() => ctx.close());
  const q1 = await makeQuestion(ctx, '甲', 5);
  const paper = ok(await ctx.api.post('/api/papers', { name: '非法流转' })).paper;
  ok(await ctx.api.put('/api/papers/' + paper.id + '/questions', { questions: [{ questionId: q1.id }] }));

  assert.strictEqual((await ctx.api.post('/api/papers/' + paper.id + '/withdraw', {})).status, 409, '草稿不能撤回');
  assert.strictEqual((await ctx.api.post('/api/papers/' + paper.id + '/reopen', {})).status, 409, '未完成的卷不能重开');
  assert.strictEqual((await ctx.api.post('/api/papers/' + paper.id + '/不存在的动作', {})).status, 404);
});

test('M3 · 有答卷后：不能撤回；删除则连带清掉答卷与评分', async (t) => {
  const ctx = await startApp();
  t.after(() => ctx.close());
  const q1 = await makeQuestion(ctx, '甲', 10);
  const paper = ok(await ctx.api.post('/api/papers', { name: '保护卷' })).paper;
  ok(await ctx.api.put('/api/papers/' + paper.id + '/questions', { questions: [{ questionId: q1.id }] }));
  ok(await ctx.api.post('/api/papers/' + paper.id + '/publish', {}));

  const stu = seedStudent('张三');
  seedSubmission(paper.id, stu);

  const withdraw = await ctx.api.post('/api/papers/' + paper.id + '/withdraw', {});
  assert.strictEqual(withdraw.status, 409);
  assert.ok(withdraw.data.error.includes('答卷'));

  // 删除不再被拦：答卷、作答、评分、题目编排一起清掉，并如实回报
  const removed = ok(await ctx.api.del('/api/papers/' + paper.id));
  assert.strictEqual(removed.removed.submissions, 1);
  assert.strictEqual(removed.removed.gradeSheets, 1);
  assert.strictEqual(removed.removed.paperQuestions, 1);

  assert.strictEqual((await ctx.api.get('/api/papers/' + paper.id)).status, 404);
  assert.strictEqual(ok(await ctx.api.get('/api/papers')).papers.length, 0);
  const db = getDb();
  assert.strictEqual(db.prepare('SELECT COUNT(*) AS c FROM submissions WHERE paper_id = ?').get(paper.id).c, 0);
  assert.strictEqual(db.prepare('SELECT COUNT(*) AS c FROM paper_questions WHERE paper_id = ?').get(paper.id).c, 0);
  assert.strictEqual(db.prepare('SELECT COUNT(*) AS c FROM grade_sheets').get().c, 0);
});

test('M3 · 进度统计：已交 / 缺考 / 待批改 / 待确认 / 存疑', async (t) => {
  const ctx = await startApp();
  t.after(() => ctx.close());
  const q1 = await makeQuestion(ctx, '甲', 10);
  const paper = ok(await ctx.api.post('/api/papers', { name: '进度卷' })).paper;
  ok(await ctx.api.put('/api/papers/' + paper.id + '/questions', { questions: [{ questionId: q1.id }] }));
  ok(await ctx.api.post('/api/papers/' + paper.id + '/publish', {}));

  const s1 = seedStudent('张三');
  const s2 = seedStudent('李四');
  seedStudent('王五');
  const sub1 = seedSubmission(paper.id, s1);
  seedSubmission(paper.id, s2);

  const db = getDb();
  const now = nowIso();
  db.prepare("UPDATE grade_sheets SET status = 'ai_done', ai_total = 8 WHERE submission_id = ?").run(sub1);
  db.prepare('INSERT INTO grade_items(grade_sheet_id, paper_question_id, ai_score, doubt) VALUES((SELECT id FROM grade_sheets WHERE submission_id = ?), 1, 8, 1)').run(sub1);
  db.prepare('INSERT INTO submissions(paper_id, student_id, source, status, updated_at) VALUES(?,?,?,?,?)')
    .run(paper.id, 3, 'manual', 'absent', now);

  const p = progressOf(paper.id);
  assert.strictEqual(p.studentCount, 3);
  assert.strictEqual(p.submissionCount, 2);
  assert.strictEqual(p.absentCount, 1);
  assert.strictEqual(p.ungraded, 1);
  assert.strictEqual(p.toConfirm, 1);
  assert.strictEqual(p.confirmed, 0);
  assert.strictEqual(p.doubt, 1);
  assert.strictEqual(p.progressPercent, 33);
});

test('M3 · 待确认未清空时不能标记完成', async (t) => {
  const ctx = await startApp();
  t.after(() => ctx.close());
  const q1 = await makeQuestion(ctx, '甲', 10);
  const paper = ok(await ctx.api.post('/api/papers', { name: '完成校验' })).paper;
  ok(await ctx.api.put('/api/papers/' + paper.id + '/questions', { questions: [{ questionId: q1.id }] }));
  ok(await ctx.api.post('/api/papers/' + paper.id + '/publish', {}));

  const stu = seedStudent('张三');
  const sub = seedSubmission(paper.id, stu);
  getDb().prepare("UPDATE grade_sheets SET status = 'ai_done' WHERE submission_id = ?").run(sub);

  const blocked = await ctx.api.post('/api/papers/' + paper.id + '/complete', {});
  assert.strictEqual(blocked.status, 409);
  assert.ok(blocked.data.error.includes('待确认'));

  getDb().prepare("UPDATE grade_sheets SET status = 'confirmed' WHERE submission_id = ?").run(sub);
  const donePaper = ok(await ctx.api.post('/api/papers/' + paper.id + '/complete', {})).paper;
  assert.strictEqual(donePaper.status, 'done');

  const reopened = ok(await ctx.api.post('/api/papers/' + paper.id + '/reopen', {})).paper;
  assert.strictEqual(reopened.status, 'grading');
});

test('M3 · 修改试卷名称与及格线', async (t) => {
  const ctx = await startApp();
  t.after(() => ctx.close());
  const paper = ok(await ctx.api.post('/api/papers', { name: '原名' })).paper;
  const renamed = ok(await ctx.api.put('/api/papers/' + paper.id, { name: '新名字', passLine: 42 })).paper;
  assert.strictEqual(renamed.name, '新名字');
  assert.strictEqual(renamed.passLine, 42);
  assert.strictEqual(renamed.progress.passLine, 42);
  assert.strictEqual((await ctx.api.put('/api/papers/' + paper.id, { name: '  ' })).status, 400);
  assert.strictEqual((await ctx.api.post('/api/papers', { name: '' })).status, 400);
});
