'use strict';

const test = require('node:test');
const assert = require('node:assert');

const { getDb } = require('../server/db');
const { startApp, ok } = require('./helpers');

/** 分项题：4 + 2 = 6 分 */
const ITEM_QUESTION = {
  stem: '一物体从 45 m 高处自由下落，求落地时间。',
  refAnswer: 't = √(2h/g) = 3 s',
  rubricType: 'items',
  items: [
    { text: '正确选取研究对象并写出位移公式', points: 4 },
    { text: '结果与单位规范', points: 2 },
  ],
  subject: '物理',
  knowledge: '自由落体',
};

/** 文字题：4 分 */
const TEXT_QUESTION = {
  stem: '简述牛顿第一定律。',
  refAnswer: '一切物体在没有受到外力作用时，总保持静止或匀速直线运动状态。',
  rubricType: 'text',
  rubricText: '答出「保持静止或匀速直线运动」得 3 分，答出「惯性」再得 1 分。',
  points: 4,
  subject: '物理',
  knowledge: '牛顿第一定律',
};

/** 全卷满分 10，默认及格线 6 */
const FULL_MARKS = 10;
const PASS_LINE = 6;

async function setup(ctx) {
  const q1 = ok(await ctx.api.post('/api/questions', ITEM_QUESTION)).question;
  const q2 = ok(await ctx.api.post('/api/questions', TEXT_QUESTION)).question;
  const paper = ok(await ctx.api.post('/api/papers', { name: '第一次月考' })).paper;
  const saved = ok(await ctx.api.put('/api/papers/' + paper.id + '/questions', {
    questions: [{ questionId: q1.id }, { questionId: q2.id }],
  }));
  ok(await ctx.api.post('/api/papers/' + paper.id + '/publish', {}));
  return { paper, questions: saved.questions, q1, q2 };
}

/** 建一名学生并交一份答卷；学生已存在则复用（同班同名不允许重复创建） */
async function newSubmission(ctx, paper, questions, name) {
  const list = ok(await ctx.api.get('/api/students')).students;
  let stu = list.find((s) => s.name === name);
  if (!stu) {
    stu = ok(await ctx.api.post('/api/students', { name, className: '高一(1)班' })).student;
  }
  const sub = ok(await ctx.api.post('/api/papers/' + paper.id + '/submissions', {
    studentId: stu.id,
    source: 'manual',
    answers: [
      { paperQuestionId: questions[0].paperQuestionId, text: '由 h=½gt² 得 t=3 s' },
      { paperQuestionId: questions[1].paperQuestionId, text: '物体保持静止或匀速直线运动' },
    ],
  })).submission;
  return { stu, submissionId: sub.id };
}

/**
 * 完整走一遍「收卷 → AI 批改 → 老师改分 → 确认」。
 * targets = { q1: [第1项, 第2项], q2: 分数 }；传 null 表示沿用 AI 分。
 */
async function gradeAndConfirm(ctx, paper, questions, name, targets) {
  const { stu, submissionId } = await newSubmission(ctx, paper, questions, name);
  const graded = ok(await ctx.api.post('/api/submissions/' + submissionId + '/grade', {}));
  const detail = graded.detail;

  const q1Items = detail.questions[0].items;
  for (let i = 0; i < (targets.q1 || []).length; i += 1) {
    if (targets.q1[i] !== null && targets.q1[i] !== undefined) {
      ok(await ctx.api.put('/api/grade-items/' + q1Items[i].id, { finalScore: targets.q1[i] }));
    }
  }
  if (targets.q2 !== null && targets.q2 !== undefined) {
    ok(await ctx.api.put('/api/grade-items/' + detail.questions[1].items[0].id, { finalScore: targets.q2 }));
  }
  if (!targets.skipConfirm) {
    ok(await ctx.api.post('/api/grade-sheets/' + detail.gradeSheet.id + '/confirm', {}));
  }
  return {
    stu,
    submissionId,
    gradeSheetId: detail.gradeSheet.id,
    q1GradeItemIds: q1Items.map((i) => i.id),
    q2GradeItemId: detail.questions[1].items[0].id,
  };
}

/** 目标分数：甲 10（满分）、乙 3、丙 7 */
const TARGETS_JIA = { q1: [4, 2], q2: 4 };
const TARGETS_YI = { q1: [2, 1], q2: 0 };
const TARGETS_BING = { q1: [4, 2], q2: 1 };

test('M6 · 统计只算已确认的答卷：没确认的不进统计', async (t) => {
  const ctx = await startApp();
  t.after(() => ctx.close());
  const { paper, questions } = await setup(ctx);

  await gradeAndConfirm(ctx, paper, questions, '甲', { ...TARGETS_JIA, skipConfirm: true });

  let stats = ok(await ctx.api.get('/api/stats/paper/' + paper.id));
  assert.strictEqual(stats.fullMarks, FULL_MARKS);
  assert.strictEqual(stats.passLine, PASS_LINE, '没设及格线时按总分 60% 算');
  assert.strictEqual(stats.overview.count, 0, '还没确认，班级里应一个人都没有');
  assert.strictEqual(stats.overview.average, null);
  assert.strictEqual(stats.students.length, 0);
  stats.questions.forEach((q) => {
    assert.strictEqual(q.sheetCount, 0);
    assert.strictEqual(q.rate, null);
  });

  const sheetId = getDb().prepare('SELECT id FROM grade_sheets').get().id;
  ok(await ctx.api.post('/api/grade-sheets/' + sheetId + '/confirm', {}));

  stats = ok(await ctx.api.get('/api/stats/paper/' + paper.id));
  assert.strictEqual(stats.overview.count, 1, '确认后才进统计');
  assert.strictEqual(stats.overview.average, 10);
});

test('M6 · 班级概览：平均 / 最高 / 最低 / 及格率与手算一致', async (t) => {
  const ctx = await startApp();
  t.after(() => ctx.close());
  const { paper, questions } = await setup(ctx);

  await gradeAndConfirm(ctx, paper, questions, '甲', TARGETS_JIA);
  await gradeAndConfirm(ctx, paper, questions, '乙', TARGETS_YI);
  await gradeAndConfirm(ctx, paper, questions, '丙', TARGETS_BING);

  const stats = ok(await ctx.api.get('/api/stats/paper/' + paper.id));
  const o = stats.overview;
  assert.strictEqual(o.count, 3);
  assert.strictEqual(o.average, 6.67, '(10 + 3 + 7) / 3 = 6.666… → 6.67');
  assert.strictEqual(o.highest, 10);
  assert.strictEqual(o.lowest, 3);
  assert.strictEqual(o.passLine, 6);
  assert.strictEqual(o.passCount, 2, '甲 10、丙 7 及格；乙 3 不及格');
  assert.strictEqual(o.passRate, 0.67, '2 / 3 = 0.666… → 0.67');
  assert.strictEqual(o.submitted, 3);
  assert.strictEqual(o.confirmed, 3);

  const totals = stats.students.map((s) => s.total).sort((a, b) => b - a);
  assert.deepStrictEqual(totals, [10, 7, 3], '每份答卷的总分 = 各项得分之和');
});

test('M6 · 每题得分率 = 该题得分总和 ÷ 满分总和，并给出排行与失分人数', async (t) => {
  const ctx = await startApp();
  t.after(() => ctx.close());
  const { paper, questions } = await setup(ctx);

  await gradeAndConfirm(ctx, paper, questions, '甲', TARGETS_JIA);
  await gradeAndConfirm(ctx, paper, questions, '乙', TARGETS_YI);
  await gradeAndConfirm(ctx, paper, questions, '丙', TARGETS_BING);

  const stats = ok(await ctx.api.get('/api/stats/paper/' + paper.id));
  const q1 = stats.questions.find((q) => q.seq === 1);
  const q2 = stats.questions.find((q) => q.seq === 2);

  // 第 1 题（6 分）：甲 6、乙 3、丙 6 → 15 / 18
  assert.strictEqual(q1.points, 6);
  assert.strictEqual(q1.sheetCount, 3);
  assert.strictEqual(q1.scoreSum, 15);
  assert.strictEqual(q1.fullSum, 18);
  assert.strictEqual(q1.rate, 0.83, '15 / 18 = 0.8333… → 0.83');
  assert.strictEqual(q1.average, 5);
  assert.strictEqual(q1.lostCount, 1, '只有乙在这题失分');

  // 第 2 题（4 分）：甲 4、乙 0、丙 1 → 5 / 12
  assert.strictEqual(q2.points, 4);
  assert.strictEqual(q2.scoreSum, 5);
  assert.strictEqual(q2.fullSum, 12);
  assert.strictEqual(q2.rate, 0.42, '5 / 12 = 0.4166… → 0.42');
  assert.strictEqual(q2.average, 1.67);
  assert.strictEqual(q2.lostCount, 2, '乙与丙都在这题失分');
  assert.strictEqual(q2.zeroCount, 1, '乙拿了 0 分');

  // 默认排序：得分率低的排前面（最需要讲）
  assert.deepStrictEqual(stats.ranking.map((q) => q.seq), [2, 1], 'ranking 应按得分率升序');
  assert.deepStrictEqual(stats.questions.map((q) => q.seq), [1, 2], 'questions 保持题号顺序');
});

test('M6 · 学生排名：同分并列，名次跳号', async (t) => {
  const ctx = await startApp();
  t.after(() => ctx.close());
  const { paper, questions } = await setup(ctx);

  await gradeAndConfirm(ctx, paper, questions, '甲', TARGETS_JIA);          // 10
  await gradeAndConfirm(ctx, paper, questions, '乙', TARGETS_BING);         // 7
  await gradeAndConfirm(ctx, paper, questions, '丙', TARGETS_BING);         // 7
  await gradeAndConfirm(ctx, paper, questions, '丁', TARGETS_YI);           // 3

  const stats = ok(await ctx.api.get('/api/stats/paper/' + paper.id));
  assert.deepStrictEqual(
    stats.students.map((s) => [s.name, s.total, s.rank]),
    [['甲', 10, 1], ['乙', 7, 2], ['丙', 7, 2], ['丁', 3, 4]],
    '7 分的两人并列第 2，丁跳到第 4'
  );
  assert.deepStrictEqual(stats.students.map((s) => s.passed), [true, true, true, false]);
  assert.strictEqual(stats.students[1].percent, 0.7);
  assert.strictEqual(stats.overview.average, 6.75, '(10 + 7 + 7 + 3) / 4 = 6.75');
});

test('M6 · 点某道题：列出该题失分学生名单，按失分多少排序', async (t) => {
  const ctx = await startApp();
  t.after(() => ctx.close());
  const { paper, questions } = await setup(ctx);
  await gradeAndConfirm(ctx, paper, questions, '甲', TARGETS_JIA);
  await gradeAndConfirm(ctx, paper, questions, '乙', TARGETS_YI);
  await gradeAndConfirm(ctx, paper, questions, '丙', TARGETS_BING);

  const pq2 = questions[1].paperQuestionId;
  const detail = ok(await ctx.api.get('/api/stats/paper/' + paper.id + '/question/' + pq2));
  assert.strictEqual(detail.seq, 2);
  assert.strictEqual(detail.points, 4);
  assert.strictEqual(detail.rubricType, 'text');
  assert.strictEqual(detail.scoreSum, 5);
  assert.strictEqual(detail.fullSum, 12);
  assert.strictEqual(detail.rate, 0.42);
  assert.strictEqual(detail.lostCount, 2);
  assert.deepStrictEqual(detail.students.map((s) => [s.name, s.score, s.lost]), [['乙', 0, 4], ['丙', 1, 3]]);
  assert.strictEqual(detail.students[0].items[0].criterion, '整体给分', '文字题的明细项应叫「整体给分」');
  assert.strictEqual(detail.students[0].items[0].max, 4);
  assert.ok(detail.students[0].items[0].reason.length > 0, '失分处要能看到 AI 给的理由');

  // 分项题：明细按得分点列出
  const pq1 = questions[0].paperQuestionId;
  const d1 = ok(await ctx.api.get('/api/stats/paper/' + paper.id + '/question/' + pq1));
  assert.strictEqual(d1.lostCount, 1);
  assert.strictEqual(d1.students[0].name, '乙');
  assert.strictEqual(d1.students[0].lost, 3);
  assert.strictEqual(d1.students[0].items.length, 2);
  assert.deepStrictEqual(d1.students[0].items.map((i) => i.criterion), ['正确选取研究对象并写出位移公式', '结果与单位规范']);
  assert.deepStrictEqual(d1.students[0].items.map((i) => [i.score, i.max]), [[2, 4], [1, 2]]);
  assert.deepStrictEqual(d1.rubricItems.map((r) => r.points), [4, 2]);

  const missing = await ctx.api.get('/api/stats/paper/' + paper.id + '/question/999999');
  assert.strictEqual(missing.status, 404);
  const badPaper = await ctx.api.get('/api/stats/paper/999999');
  assert.strictEqual(badPaper.status, 404);
});

test('M6 · 首页四张卡：口径正确，且各自指向最该去的那份试卷', async (t) => {
  const ctx = await startApp();
  t.after(() => ctx.close());
  const { paper, questions } = await setup(ctx);

  let home = ok(await ctx.api.get('/api/stats/home'));
  assert.strictEqual(home.cards.toGrade.count, 0);
  assert.strictEqual(home.cards.toConfirm.count, 0);
  assert.strictEqual(home.cards.doubt.count, 0);
  assert.strictEqual(home.cards.toReview.count, 0);
  assert.strictEqual(home.cards.toGrade.focus, null, '没数据时不给下钻目标');
  assert.match(home.date, /^\d{4}-\d{2}-\d{2}$/);

  // 收 3 份答案 → 待你批改 = 3
  await newSubmission(ctx, paper, questions, '乙');
  await newSubmission(ctx, paper, questions, '丙');

  home = ok(await ctx.api.get('/api/stats/home'));
  assert.strictEqual(home.cards.toGrade.count, 2);
  assert.deepStrictEqual(home.cards.toGrade.focus, { paperId: paper.id, paperName: '第一次月考', count: 2 });
  assert.strictEqual(home.cards.toConfirm.count, 0);

  // 批完甲（暂不确认）→ 待你批改 2、待你确认 1
  const first = await gradeAndConfirm(ctx, paper, questions, '甲', { ...TARGETS_JIA, skipConfirm: true });
  await ctx.api.put('/api/grade-items/' + first.q1GradeItemIds[0], { doubt: true });

  home = ok(await ctx.api.get('/api/stats/home'));
  assert.strictEqual(home.cards.toGrade.count, 2);
  assert.strictEqual(home.cards.toConfirm.count, 1);
  assert.strictEqual(home.cards.doubt.count, 1, 'AI 存疑点应被统计');
  assert.strictEqual(home.cards.toReview.count, 0, '未确认的答卷不参与「待讲评」计算');

  // 左栏：需要你处理
  assert.strictEqual(home.left.sheets.length, 1);
  assert.strictEqual(home.left.sheets[0].studentName, '甲');
  assert.strictEqual(home.left.sheets[0].fullMarks, FULL_MARKS);
  assert.strictEqual(home.left.sheets[0].doubtCount, 1);
  assert.strictEqual(home.left.doubts.length, 1);
  assert.strictEqual(home.left.doubts[0].seq, 1);
  assert.ok(home.left.doubts[0].reason.length > 0);

  // 确认 → 待你确认归零，存疑点不再计入
  ok(await ctx.api.post('/api/grade-sheets/' + first.gradeSheetId + '/confirm', {}));

  home = ok(await ctx.api.get('/api/stats/home'));
  assert.strictEqual(home.cards.toConfirm.count, 0);
  assert.strictEqual(home.cards.doubt.count, 0, '确认后就不算待复核的存疑点了');
  assert.strictEqual(home.cards.toReview.count, 0, '只有一个人且是满分，还没有值得讲的题');

  // 把剩下两份也批完确认，第 2 题得分率 5/12 = 0.42 < 0.5，这才出现「待讲评的题」
  await gradeAndConfirm(ctx, paper, questions, '乙', TARGETS_YI);
  await gradeAndConfirm(ctx, paper, questions, '丙', TARGETS_BING);

  home = ok(await ctx.api.get('/api/stats/home'));
  assert.strictEqual(home.cards.toReview.count, 1, '只算得分率低于 50% 的题');
  assert.deepStrictEqual(home.cards.toReview.focus, { paperId: paper.id, paperName: '第一次月考', count: 1 });
  assert.strictEqual(home.right.lowRateTotal, 1);
  assert.strictEqual(home.right.lowRateQuestions.length, 1);
  assert.strictEqual(home.right.lowRateQuestions[0].seq, 2);
  assert.strictEqual(home.right.lowRateQuestions[0].rate, 0.42);
  assert.strictEqual(home.right.lowRateQuestions[0].lostCount, 2, '两个人都在这题失分');
  assert.strictEqual(
    home.right.lowRateQuestions[0].paperQuestionId,
    questions[1].paperQuestionId
  );
  assert.ok(home.right.lowRateQuestions[0].stem.includes('牛顿第一定律'));
});

test('M6 · 首页「进行中的试卷」带进度与当前平均分', async (t) => {
  const ctx = await startApp();
  t.after(() => ctx.close());
  const { paper, questions } = await setup(ctx);

  await newSubmission(ctx, paper, questions, '乙');
  await gradeAndConfirm(ctx, paper, questions, '甲', TARGETS_JIA);

  const home = ok(await ctx.api.get('/api/stats/home'));
  assert.strictEqual(home.papers.length, 1);
  const p = home.papers[0];
  assert.strictEqual(p.id, paper.id);
  assert.strictEqual(p.status, 'grading', '还有一份没批完，试卷仍在批改中');
  assert.strictEqual(p.fullMarks, FULL_MARKS);
  assert.strictEqual(p.average, 10, '当前平均分只算已确认的');
  assert.strictEqual(p.progress.submissionCount, 2);
  assert.strictEqual(p.progress.ungraded, 1);
  assert.strictEqual(p.progress.confirmed, 1);

  // 草稿状态的试卷不算「进行中」
  const draft = ok(await ctx.api.post('/api/papers', { name: '还没发布的卷' })).paper;
  const home2 = ok(await ctx.api.get('/api/stats/home'));
  assert.ok(!home2.papers.some((x) => x.id === draft.id));

  // 迟交的答卷进来后，已标记完成的试卷会回到「收卷中」，不会就此从首页消失
  await gradeAndConfirm(ctx, paper, questions, '乙', TARGETS_YI);
  await gradeAndConfirm(ctx, paper, questions, '丙', TARGETS_BING);
  assert.strictEqual(ok(await ctx.api.get('/api/papers/' + paper.id)).paper.status, 'done');
  await newSubmission(ctx, paper, questions, '丁');
  assert.strictEqual(ok(await ctx.api.get('/api/papers/' + paper.id)).paper.status, 'collecting');
  const home3 = ok(await ctx.api.get('/api/stats/home'));
  assert.ok(home3.papers.some((x) => x.id === paper.id), '又有人交卷，试卷应重新出现在首页');
  assert.strictEqual(home3.cards.toGrade.count, 1);
});

test('M6 · 今日计划：新收的答案进来，批完确认后条目自动消失', async (t) => {
  const ctx = await startApp();
  t.after(() => ctx.close());
  const { paper, questions } = await setup(ctx);

  const keyOf = (list) => list.map((i) => i.key);
  const find = (list, key) => list.find((i) => i.key === key);

  // 刚发布、还没人交
  let todos = ok(await ctx.api.get('/api/todos'));
  assert.match(todos.date, /^\d{4}-\d{2}-\d{2}$/);
  assert.deepStrictEqual(keyOf(todos.auto), ['idle_paper:' + paper.id]);
  assert.strictEqual(todos.auto[0].page, 'submissions');
  assert.strictEqual(todos.auto[0].query.paper, paper.id);

  // 新收一份答案 → 出现「今天新收」与「待你批改」
  await newSubmission(ctx, paper, questions, '甲');
  todos = ok(await ctx.api.get('/api/todos'));
  assert.ok(keyOf(todos.auto).includes('today_received:' + paper.id));
  assert.strictEqual(find(todos.auto, 'today_received:' + paper.id).count, 1);
  assert.strictEqual(find(todos.auto, 'today_received:' + paper.id).page, 'grading');
  assert.strictEqual(find(todos.auto, 'to_grade').count, 1);
  assert.ok(!keyOf(todos.auto).includes('idle_paper:' + paper.id), '有人交卷后「还没人交」应消失');

  // 批完 → 「待你批改」消失，出现「待你确认」
  const first = await gradeAndConfirm(ctx, paper, questions, '甲', { ...TARGETS_JIA, skipConfirm: true });
  todos = ok(await ctx.api.get('/api/todos'));
  assert.ok(!keyOf(todos.auto).includes('to_grade'), '批完后这条待办理应消失');
  assert.strictEqual(find(todos.auto, 'to_confirm').count, 1);
  assert.strictEqual(find(todos.auto, 'today_received:' + paper.id).count, 1, '还没确认，所以还没做完');

  // 标一处存疑 → 出现复核条目
  ok(await ctx.api.put('/api/grade-items/' + first.q1GradeItemIds[1], { doubt: true }));
  todos = ok(await ctx.api.get('/api/todos'));
  assert.strictEqual(find(todos.auto, 'doubt').count, 1);
  assert.strictEqual(find(todos.auto, 'doubt').query.filter, 'doubt');

  // 确认 → 今日计划里关于这份答卷的条目全部消失
  ok(await ctx.api.post('/api/grade-sheets/' + first.gradeSheetId + '/confirm', {}));
  todos = ok(await ctx.api.get('/api/todos'));
  assert.deepStrictEqual(todos.auto, [], '今天的事都做完了，计划应为空');
});

test('M6 · 今日计划：缺考会出现提醒，处理掉就消失', async (t) => {
  const ctx = await startApp();
  t.after(() => ctx.close());
  const { paper, questions } = await setup(ctx);
  const stu = ok(await ctx.api.post('/api/students', { name: '张三', className: '高一(1)班' })).student;

  ok(await ctx.api.post('/api/papers/' + paper.id + '/submissions', {
    studentId: stu.id, status: 'absent', answers: [],
  }));
  let todos = ok(await ctx.api.get('/api/todos'));
  const absent = todos.auto.find((i) => i.key === 'absent:' + paper.id);
  assert.ok(absent, '缺考应出现在今日计划里');
  assert.strictEqual(absent.count, 1);
  assert.strictEqual(absent.page, 'submissions');

  // 改成正常提交（补交）后，缺考条目消失
  ok(await ctx.api.put('/api/submissions/' + getDb().prepare('SELECT id FROM submissions').get().id, {
    status: 'submitted',
    answers: [{ paperQuestionId: questions[0].paperQuestionId, text: '补交的答案' }],
  }));
  todos = ok(await ctx.api.get('/api/todos'));
  assert.ok(!todos.auto.some((i) => i.key === 'absent:' + paper.id));
});

test('M6 · 今日计划：手动提醒的增、改、勾、删', async (t) => {
  const ctx = await startApp();
  t.after(() => ctx.close());

  assert.strictEqual((await ctx.api.post('/api/todos', { text: '   ' })).status, 400);
  assert.strictEqual((await ctx.api.post('/api/todos', { text: 'x'.repeat(201) })).status, 400);

  const created = ok(await ctx.api.post('/api/todos', { text: '下午找张老师对答案' })).todo;
  assert.strictEqual(created.text, '下午找张老师对答案');
  assert.strictEqual(created.done, false);

  let todos = ok(await ctx.api.get('/api/todos'));
  assert.strictEqual(todos.manual.length, 1);
  assert.strictEqual(todos.manualDone.length, 0);

  const renamed = ok(await ctx.api.put('/api/todos/' + created.id, { text: '下午找张老师对一下第 2 题' })).todo;
  assert.strictEqual(renamed.text, '下午找张老师对一下第 2 题');

  const done = ok(await ctx.api.put('/api/todos/' + created.id, { done: true })).todo;
  assert.strictEqual(done.done, true);
  assert.ok(done.doneAt, '勾掉时应记下时间');

  todos = ok(await ctx.api.get('/api/todos'));
  assert.strictEqual(todos.manual.length, 0, '勾掉的不再出现在待办里');
  assert.strictEqual(todos.manualDone.length, 1);

  const back = ok(await ctx.api.put('/api/todos/' + created.id, { done: false })).todo;
  assert.strictEqual(back.done, false);
  assert.strictEqual(back.doneAt, null, '取消勾选应清掉完成时间');

  assert.strictEqual((await ctx.api.put('/api/todos/999999', { done: true })).status, 404);
  assert.strictEqual((await ctx.api.del('/api/todos/999999')).status, 404);

  ok(await ctx.api.put('/api/todos/' + created.id, { done: true }));
  ok(await ctx.api.post('/api/todos', { text: '另一条' }));
  const cleared = ok(await ctx.api.post('/api/todos/clear-done', {}));
  assert.strictEqual(cleared.removed, 1);
  todos = ok(await ctx.api.get('/api/todos'));
  assert.strictEqual(todos.manual.length, 1);
  assert.strictEqual(todos.manual[0].text, '另一条');
  assert.strictEqual(todos.manualDone.length, 0, '勾掉的那条已被清掉');

  ok(await ctx.api.del('/api/todos/' + todos.manual[0].id));
  assert.strictEqual(ok(await ctx.api.get('/api/todos')).manual.length, 0);
});

test('M6 · 首页概览与统计页面对同一份数据给出一致的数字', async (t) => {
  const ctx = await startApp();
  t.after(() => ctx.close());
  const { paper, questions } = await setup(ctx);

  await gradeAndConfirm(ctx, paper, questions, '甲', TARGETS_JIA);
  await gradeAndConfirm(ctx, paper, questions, '乙', TARGETS_YI);
  await newSubmission(ctx, paper, questions, '丙');  // 留着不批，试卷仍在进行中

  const home = ok(await ctx.api.get('/api/stats/home'));
  const stats = ok(await ctx.api.get('/api/stats/paper/' + paper.id));
  const p = home.papers.find((x) => x.id === paper.id);
  assert.ok(p, '试卷应出现在首页的进行中列表里');

  assert.strictEqual(p.average, stats.overview.average);
  assert.strictEqual(p.progress.confirmed, stats.overview.confirmed);
  assert.strictEqual(home.cards.toReview.count, stats.ranking.filter((q) => q.rate < 0.5).length);

  const plan = ok(await ctx.api.get('/api/todos'));
  const keys = plan.auto.map((i) => i.key);
  assert.strictEqual(plan.auto.find((i) => i.key === 'to_grade').count, 1, '还剩丙没批');
  assert.ok(!keys.includes('to_confirm'), '两份都已确认，不该再有待确认');
  assert.ok(!keys.includes('doubt'));
});

test('M6 · 确认后答案被改动：原确认结果作废，不再污染统计', async (t) => {
  const ctx = await startApp();
  t.after(() => ctx.close());
  const { paper, questions } = await setup(ctx);

  const jia = await gradeAndConfirm(ctx, paper, questions, '甲', TARGETS_JIA);
  let stats = ok(await ctx.api.get('/api/stats/paper/' + paper.id));
  assert.strictEqual(stats.overview.average, 10);

  // 原样重存一次：不应动到已确认的成绩
  const sub = ok(await ctx.api.get('/api/submissions/' + jia.submissionId));
  ok(await ctx.api.put('/api/submissions/' + jia.submissionId, {
    answers: sub.answers.map((a) => ({ paperQuestionId: a.paperQuestionId, text: a.text })),
  }));
  assert.strictEqual(
    getDb().prepare('SELECT status FROM grade_sheets WHERE id = ?').get(jia.gradeSheetId).status,
    'confirmed',
    '内容没改写，不该作废确认结果'
  );

  // 真改了答案：确认结果必须作废，否则统计会用错分
  ok(await ctx.api.put('/api/submissions/' + jia.submissionId, {
    answers: [{ paperQuestionId: questions[0].paperQuestionId, text: '重新提交的答案' }],
  }));
  assert.strictEqual(
    getDb().prepare('SELECT status FROM grade_sheets WHERE id = ?').get(jia.gradeSheetId).status,
    'ungraded',
    '答案改了，原来的确认就得作废'
  );
  assert.strictEqual(getDb().prepare('SELECT COUNT(*) AS c FROM grade_items').get().c, 0);
  const audit = getDb().prepare("SELECT * FROM audit_log WHERE action = 'reset_on_resubmit'").all();
  assert.strictEqual(audit.length, 1);

  stats = ok(await ctx.api.get('/api/stats/paper/' + paper.id));
  assert.strictEqual(stats.overview.count, 0, '作废后不再计入统计');
  assert.strictEqual(stats.overview.average, null);

  const home = ok(await ctx.api.get('/api/stats/home'));
  assert.strictEqual(home.cards.toGrade.count, 1, '这份答卷回到「待你批改」');
  assert.strictEqual(home.cards.toReview.count, 0);
});
