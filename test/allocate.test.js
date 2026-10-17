'use strict';

/**
 * 「评分系统：老师给整卷总分，AI 分配权重到每道大题，再平均分到每小题」的回归测试。
 *
 * 规则：
 * 1. 老师给一个整卷总分（papers.whole_full_marks），有题目也生效；
 * 2. 挑好题保存时，若设了整卷总分且没手动指定大题分 → AI 自动把总分按权重分到每道大题；
 * 3. 每道大题的分数再**平均**分给它的得分点（小题），写到 paper_questions.item_points；
 * 4. 老师手改某题分值保存 → 尊重手改值，小题分值按平均重算；
 * 5. 批改时得分点满分用分配后的值（没分配过的老数据回退评分标准自带值）。
 */

const test = require('node:test');
const assert = require('node:assert');

const { distributeEvenly } = require('../server/lib/calc');
const { normalizeAllocation } = require('../server/lib/prompts');
const { startApp, ok } = require('./helpers');

async function addQuestion(ctx, body) {
  return ok(await ctx.api.post('/api/questions', body)).question;
}

/** 一道分项得分点题（两个得分点） */
function itemQuestion(points) {
  return {
    stem: '一物体从 45 m 高处自由下落，求落地时间。',
    refAnswer: 't = √(2h/g) = 3 s',
    rubricType: 'items',
    items: [
      { text: '正确选取研究对象并写出位移公式', points: Math.ceil(points / 2) },
      { text: '结果与单位规范', points: Math.floor(points / 2) },
    ],
  };
}

function textQuestion(points) {
  return {
    stem: '简述牛顿第一定律。',
    refAnswer: '一切物体在没有受到外力作用时，总保持静止或匀速直线运动状态。',
    rubricType: 'text',
    rubricText: '答出「保持静止或匀速直线运动」得满分。',
    points,
  };
}

function sum(arr) {
  return Math.round(arr.reduce((a, b) => a + b, 0) * 100) / 100;
}

/* --------------------------------- 分配主流程 --------------------------------- */

test('分配·设整卷总分再挑题保存，AI 按权重分到大题、平均分到小题，总和=总分', async (t) => {
  const ctx = await startApp();
  t.after(() => ctx.close());
  const q1 = await addQuestion(ctx, itemQuestion(10));
  const q2 = await addQuestion(ctx, textQuestion(10));

  const paper = ok(await ctx.api.post('/api/papers', { name: '分配卷', wholeFullMarks: 100 })).paper;

  // 挑题但不带 points → 触发自动分配（mock 权重 1:2 → 33.5 / 66.5）
  const saved = ok(await ctx.api.put('/api/papers/' + paper.id + '/questions', {
    questions: [{ questionId: q1.id }, { questionId: q2.id }],
  }));

  assert.strictEqual(saved.total, 100, '满分就是老师给的整卷总分');
  assert.strictEqual(saved.questions.length, 2);
  assert.strictEqual(saved.questions[0].points, 33.5, '第 1 题按权重分到 33.5');
  assert.strictEqual(saved.questions[1].points, 66.5, '第 2 题按权重分到 66.5');
  assert.strictEqual(sum(saved.questions.map((q) => q.points)), 100, '各题分值之和 = 整卷总分');

  // 第 1 题两个得分点平均各 16.75；第 2 题是文字说明题，没有小题
  assert.deepStrictEqual(saved.questions[0].itemPoints, [16.75, 16.75]);
  assert.deepStrictEqual(saved.questions[0].rubricItems.map((it) => it.points), [16.75, 16.75]);
  assert.strictEqual(saved.questions[1].itemPoints, null);
});

test('分配·老师手改某题分值后保存，尊重手改值，小题按平均重算', async (t) => {
  const ctx = await startApp();
  t.after(() => ctx.close());
  const q1 = await addQuestion(ctx, itemQuestion(10));
  const q2 = await addQuestion(ctx, textQuestion(10));
  const paper = ok(await ctx.api.post('/api/papers', { name: '手改卷', wholeFullMarks: 100 })).paper;
  ok(await ctx.api.put('/api/papers/' + paper.id + '/questions', {
    questions: [{ questionId: q1.id }, { questionId: q2.id }],
  }));

  // 手改：第 1 题 40、第 2 题 60（带了 points，就不该再被 AI 覆盖）
  const saved2 = ok(await ctx.api.put('/api/papers/' + paper.id + '/questions', {
    questions: [{ questionId: q1.id, points: 40 }, { questionId: q2.id, points: 60 }],
  }));
  assert.strictEqual(saved2.questions[0].points, 40, '手改值要原样尊重');
  assert.strictEqual(saved2.questions[1].points, 60);
  assert.deepStrictEqual(saved2.questions[0].itemPoints, [20, 20], '40 → 两个得分点各 20');
});

test('分配·一键重新分配：改完总分后让 AI 重新按权重分', async (t) => {
  const ctx = await startApp();
  t.after(() => ctx.close());
  const q1 = await addQuestion(ctx, itemQuestion(10));
  const q2 = await addQuestion(ctx, textQuestion(10));
  const paper = ok(await ctx.api.post('/api/papers', { name: '重分卷', wholeFullMarks: 100 })).paper;
  ok(await ctx.api.put('/api/papers/' + paper.id + '/questions', {
    questions: [{ questionId: q1.id }, { questionId: q2.id }],
  }));

  // 改总分 100 → 90，再点分配
  ok(await ctx.api.put('/api/papers/' + paper.id, { wholeFullMarks: 90 }));
  const re = ok(await ctx.api.post('/api/papers/' + paper.id + '/allocate', {}));
  assert.strictEqual(re.fullMarks, 90);
  assert.strictEqual(re.questions.find((q) => q.seq === 1).points, 30, '90 × 1/3');
  assert.strictEqual(re.questions.find((q) => q.seq === 2).points, 60, '90 × 2/3');
  assert.strictEqual(sum(re.questions.map((q) => q.points)), 90);
});

test('分配·没有题目时分配不报错（返回空列表）', async (t) => {
  const ctx = await startApp();
  t.after(() => ctx.close());
  const paper = ok(await ctx.api.post('/api/papers', { name: '空卷', wholeFullMarks: 120 })).paper;
  const re = ok(await ctx.api.post('/api/papers/' + paper.id + '/allocate', {}));
  assert.deepStrictEqual(re.questions, []);
  assert.strictEqual(re.fullMarks, 120);
});

/* ------------------------------ 批改用分配后的分值 ------------------------------ */

test('分配·批改时得分点满分用分配后的值，不是评分标准自带的', async (t) => {
  const ctx = await startApp();
  t.after(() => ctx.close());
  const q1 = await addQuestion(ctx, itemQuestion(10));   // 评分标准自带两得分点 5/5
  const paper = ok(await ctx.api.post('/api/papers', { name: '判分卷', wholeFullMarks: 100 })).paper;
  ok(await ctx.api.put('/api/papers/' + paper.id + '/questions', {
    questions: [{ questionId: q1.id }],   // 单题，自动分配 → 100 分，两得分点各 50
  }));
  ok(await ctx.api.post('/api/papers/' + paper.id + '/publish', {}));

  // 提交一份文字答卷 → 批改
  const saved = ok(await ctx.api.get('/api/papers/' + paper.id)).questions[0];
  const stu = ok(await ctx.api.post('/api/students', { name: '张三', className: '高一(1)班' })).student;
  const sub = ok(await ctx.api.post('/api/papers/' + paper.id + '/submissions', {
    studentId: stu.id, source: 'manual', status: 'submitted',
    answers: [{ paperQuestionId: saved.paperQuestionId, text: '由 h=½gt² 得 t=3s' }],
  })).submission;
  ok(await ctx.api.post('/api/submissions/' + sub.id + '/grade', {}));

  const detail = ok(await ctx.api.get('/api/papers/' + paper.id + '/queue/1')).detail;
  assert.strictEqual(detail.questions[0].points, 100, '大题满分 = 分配后的整卷总分');
  assert.deepStrictEqual(
    detail.questions[0].rubricItems.map((it) => it.points), [50, 50],
    '得分点满分 = 平均分配后的值，不是评分标准自带的 5/5'
  );
});

/* --------------------------------- 单元：分配算法 --------------------------------- */

test('distributeEvenly·平均分、各项和精确等于总分', () => {
  assert.deepStrictEqual(distributeEvenly(10, 3), [3.33, 3.33, 3.34]);
  assert.deepStrictEqual(distributeEvenly(9, 2), [4.5, 4.5]);
  assert.deepStrictEqual(distributeEvenly(1, 4), [0.25, 0.25, 0.25, 0.25]);
  assert.deepStrictEqual(distributeEvenly(5, 1), [5]);
  assert.deepStrictEqual(distributeEvenly(5, 0), []);

  [7, 100, 33.5, 0.01, 123.45].forEach((total) => {
    [1, 2, 3, 5, 7].forEach((n) => {
      const arr = distributeEvenly(total, n);
      assert.strictEqual(arr.length, n);
      assert.strictEqual(Math.round(sum(arr) * 100), Math.round(total * 100), `${total} / ${n}`);
    });
  });
});

test('normalizeAllocation·脏数据退化成平均、总和规整成整卷总分', () => {
  const qs = [{ seq: 1 }, { seq: 2 }, { seq: 3 }];

  // 完全没给 → 平均
  assert.deepStrictEqual(normalizeAllocation(null, 90, qs), [
    { seq: 1, points: 30 }, { seq: 2, points: 30 }, { seq: 3, points: 30 },
  ]);
  assert.deepStrictEqual(normalizeAllocation({ allocations: '不是数组' }, 90, qs), [
    { seq: 1, points: 30 }, { seq: 2, points: 30 }, { seq: 3, points: 30 },
  ]);

  // 全 0 → 平均
  assert.deepStrictEqual(
    normalizeAllocation({ allocations: [{ seq: 1, points: 0 }, { seq: 2, points: 0 }, { seq: 3, points: 0 }] }, 90, qs),
    [{ seq: 1, points: 30 }, { seq: 2, points: 30 }, { seq: 3, points: 30 }]
  );

  // 缺一道 → 那一道 0，其余缩放；总和仍 = 总分
  const partial = normalizeAllocation({ allocations: [{ seq: 1, points: 10 }, { seq: 2, points: 10 }] }, 90, qs);
  assert.strictEqual(partial.find((a) => a.seq === 3).points, 0);
  assert.strictEqual(sum(partial.map((a) => a.points)), 90);

  // 总和不对 → 按比例缩放，保证总和 = 总分
  const scaled = normalizeAllocation(
    { allocations: [{ seq: 1, points: 10 }, { seq: 2, points: 10 }, { seq: 3, points: 10 }] },
    90,
    qs
  );
  assert.strictEqual(sum(scaled.map((a) => a.points)), 90);
});
