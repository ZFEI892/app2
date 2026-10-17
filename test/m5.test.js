'use strict';

const test = require('node:test');
const assert = require('node:assert');

const { getDb } = require('../server/db');
const { HttpError } = require('../server/router');
const { mockChat } = require('../server/ai/qwen');
const { startApp, ok } = require('./helpers');

/** 分项得分点题：4 分 + 2 分 = 6 分 */
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

/** 一段文字说明题：4 分 */
const TEXT_QUESTION = {
  stem: '简述牛顿第一定律。',
  refAnswer: '一切物体在没有受到外力作用时，总保持静止或匀速直线运动状态。',
  rubricType: 'text',
  rubricText: '答出「保持静止或匀速直线运动」得 3 分，答出「惯性」再得 1 分。',
  points: 4,
  subject: '物理',
  knowledge: '牛顿第一定律',
};

/** mock 判分规则：每条得分点给满分的 75%，confidence 0.9
 *  → 分项题 4 分得 3、2 分得 1.5（共 4.5）；文字题 4 分得 3。合计 7.5 / 10。 */
const MOCK_TOTAL = 7.5;

async function seedPaper(ctx) {
  const q1 = ok(await ctx.api.post('/api/questions', ITEM_QUESTION)).question;
  const q2 = ok(await ctx.api.post('/api/questions', TEXT_QUESTION)).question;
  const paper = ok(await ctx.api.post('/api/papers', { name: '第一次月考' })).paper;
  const saved = ok(await ctx.api.put('/api/papers/' + paper.id + '/questions', {
    questions: [{ questionId: q1.id }, { questionId: q2.id }],
  }));
  ok(await ctx.api.post('/api/papers/' + paper.id + '/publish', {}));
  return { paper, questions: saved.questions, q1, q2 };
}

async function seedStudent(ctx, name) {
  return ok(await ctx.api.post('/api/students', { name, className: '高一(1)班' })).student;
}

/** 建一名学生并交一份答卷，返回答卷 id */
async function seedSubmission(ctx, paper, questions, name, firstAnswerText) {
  const stu = await seedStudent(ctx, name);
  const sub = ok(await ctx.api.post('/api/papers/' + paper.id + '/submissions', {
    studentId: stu.id,
    source: 'manual',
    answers: [
      { paperQuestionId: questions[0].paperQuestionId, text: firstAnswerText || '由 h=½gt² 得 t=3 s' },
      { paperQuestionId: questions[1].paperQuestionId, text: '物体保持静止或匀速直线运动' },
    ],
  })).submission;
  return { stu, submissionId: sub.id };
}

async function waitJob(ctx, jobId, timeoutMs = 8000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const { job } = ok(await ctx.api.get('/api/batch/' + jobId));
    if (job.finished) return job;
    if (Date.now() > deadline) throw new Error('批量任务超时未结束：' + JSON.stringify(job));
    await new Promise((r) => setTimeout(r, 20));
  }
}

/** 让 mock 判分带上可控的 confidence，用于验证存疑阈值 */
function confidenceChat(holder) {
  return async (messages) => {
    const parsed = JSON.parse(await mockChat(messages));
    (parsed.items || []).forEach((it) => { it.confidence = holder.value; });
    return JSON.stringify(parsed);
  };
}

test('M5 · 逐项给分：不超满分，理由要引用对应的评分标准', async (t) => {
  const ctx = await startApp();
  t.after(() => ctx.close());
  const { paper, questions } = await seedPaper(ctx);
  const { submissionId } = await seedSubmission(ctx, paper, questions, '张三');

  const res = ok(await ctx.api.post('/api/submissions/' + submissionId + '/grade', {}));
  assert.strictEqual(res.status, 'ai_done');
  assert.strictEqual(res.aiTotal, MOCK_TOTAL);

  const detail = res.detail;
  assert.strictEqual(detail.fullMarks, 10, '4 + 2 + 4 = 10');
  assert.strictEqual(detail.questions.length, 2);
  assert.strictEqual(detail.gradeSheet.status, 'ai_done');
  assert.strictEqual(detail.gradeSheet.effectiveTotal, MOCK_TOTAL);

  const q1 = detail.questions[0];
  assert.strictEqual(q1.rubricType, 'items');
  assert.strictEqual(q1.items.length, 2, '分项题必须逐项给分');
  assert.deepStrictEqual(q1.items.map((i) => i.aiScore), [3, 1.5]);
  assert.ok(
    q1.items[0].aiReason.includes('正确选取研究对象并写出位移公式'),
    '第 1 项理由应引用第 1 条评分标准，实际：' + q1.items[0].aiReason
  );
  assert.ok(
    q1.items[1].aiReason.includes('结果与单位规范'),
    '第 2 项理由应引用第 2 条评分标准，实际：' + q1.items[1].aiReason
  );
  assert.strictEqual(q1.questionTotal, 4.5);

  const q2 = detail.questions[1];
  assert.strictEqual(q2.rubricType, 'text');
  assert.strictEqual(q2.items.length, 1);
  assert.strictEqual(q2.items[0].aiScore, 3);
  assert.ok(q2.items[0].aiReason.includes('惯性'), '文字题理由也要引到评分标准原文');

  detail.questions.forEach((q) => {
    q.items.forEach((it) => {
      const cap = q.rubricType === 'items'
        ? q.rubricItems.find((r) => r.id === it.questionItemId).points
        : q.points;
      assert.ok(it.aiScore <= cap + 1e-9, `得分 ${it.aiScore} 不应超过该项满分 ${cap}`);
      assert.ok(it.aiScore >= 0, '得分不应为负');
    });
  });

  const paperDetail = ok(await ctx.api.get('/api/papers/' + paper.id));
  assert.strictEqual(paperDetail.paper.status, 'grading', '批改后试卷应进入「批改中」');
});

test('M5 · 老师改分：总分、逐题分与队列同步更新', async (t) => {
  const ctx = await startApp();
  t.after(() => ctx.close());
  const { paper, questions } = await seedPaper(ctx);
  const { submissionId } = await seedSubmission(ctx, paper, questions, '张三');

  const graded = ok(await ctx.api.post('/api/submissions/' + submissionId + '/grade', {}));
  const q1 = graded.detail.questions[0];
  const q2 = graded.detail.questions[1];

  const r1 = ok(await ctx.api.put('/api/grade-items/' + q1.items[0].id, { finalScore: 4 }));
  assert.strictEqual(r1.effectiveTotal, 8.5, '3 → 4 后总分 7.5 + 1 = 8.5');

  const r2 = ok(await ctx.api.put('/api/grade-items/' + q1.items[1].id, { finalScore: 0 }));
  assert.strictEqual(r2.effectiveTotal, 7, '1.5 → 0 后总分 8.5 - 1.5 = 7');

  const after = ok(await ctx.api.get('/api/papers/' + paper.id + '/queue/1?filter=to_confirm'));
  assert.strictEqual(after.detail.gradeSheet.effectiveTotal, 7);
  assert.strictEqual(after.detail.questions[0].items[0].finalScore, 4);
  assert.strictEqual(after.detail.questions[0].items[0].effectiveScore, 4);
  assert.strictEqual(after.detail.questions[0].questionTotal, 4);
  assert.strictEqual(after.detail.questions[1].questionTotal, 3);
  assert.strictEqual(after.detail.gradeSheet.aiTotal, MOCK_TOTAL, 'AI 原始总分不应被覆盖');

  // 清空老师分 → 回到采用 AI 分
  const r3 = ok(await ctx.api.put('/api/grade-items/' + q1.items[0].id, { finalScore: null }));
  assert.strictEqual(r3.effectiveTotal, 6, '清空后该题回落到 AI 的 3 分：7 - 4 + 3 = 6');
});

test('M5 · 把握不足自动存疑，把握足了就不再存疑', async (t) => {
  const holder = { value: 0.5 };
  const ctx = await startApp({ aiMode: 'mock', aiChat: confidenceChat(holder) });
  t.after(() => ctx.close());
  const { paper, questions } = await seedPaper(ctx);
  const { submissionId } = await seedSubmission(ctx, paper, questions, '张三');

  const low = ok(await ctx.api.post('/api/submissions/' + submissionId + '/grade', {}));
  assert.ok(low.detail.questions[0].items.every((i) => i.doubt === true), 'confidence 0.5 < 阈值 0.75 应全部存疑');

  const doubtQueue = ok(await ctx.api.get('/api/papers/' + paper.id + '/queue?filter=doubt'));
  assert.strictEqual(doubtQueue.total, 1);
  assert.strictEqual(doubtQueue.items[0].doubtCount, 3, '分项 2 项 + 文字题 1 项');
  assert.strictEqual(doubtQueue.counts.doubt, 1);
  assert.strictEqual(doubtQueue.counts.toConfirm, 1, '存疑的答卷仍然算「待确认」');

  holder.value = 0.95;
  const high = ok(await ctx.api.post('/api/submissions/' + submissionId + '/grade', {}));
  assert.ok(high.detail.questions[0].items.every((i) => i.doubt === false), 'confidence 0.95 应不再存疑');
  assert.strictEqual(high.detail.questions[0].items.length, 2, '重批应整体替换明细，不叠加旧记录');

  const doubtAfter = ok(await ctx.api.get('/api/papers/' + paper.id + '/queue?filter=doubt'));
  assert.strictEqual(doubtAfter.total, 0);
  assert.strictEqual(getDb().prepare('SELECT COUNT(*) AS c FROM grade_items').get().c, 3, '重批后明细仍是 3 条');
});

test('M5 · 确认后才锁定并计入统计，解锁可回到待确认', async (t) => {
  const ctx = await startApp();
  t.after(() => ctx.close());
  const { paper, questions } = await seedPaper(ctx);
  const a = await seedSubmission(ctx, paper, questions, '张三');
  const b = await seedSubmission(ctx, paper, questions, '李四');

  const ungradedConfirm = await ctx.api.post('/api/grade-sheets/1/confirm', {});
  assert.strictEqual(ungradedConfirm.status, 409, '未批改不能确认');

  const graded = ok(await ctx.api.post('/api/submissions/' + a.submissionId + '/grade', {}));
  const sheetId = graded.detail.gradeSheet.id;

  let queue = ok(await ctx.api.get('/api/papers/' + paper.id + '/queue'));
  assert.strictEqual(queue.counts.toConfirm, 1);
  assert.strictEqual(queue.counts.confirmed, 0, '未确认不算已批改完成');
  assert.strictEqual(queue.items.find((i) => i.submissionId === a.submissionId).total, null, '未确认不给出总分');

  const confirmed = ok(await ctx.api.post('/api/grade-sheets/' + sheetId + '/confirm', { comment: '讲解后再收' }));
  assert.strictEqual(confirmed.status, 'confirmed');
  assert.strictEqual(confirmed.finalTotal, MOCK_TOTAL);
  assert.strictEqual(confirmed.paperStatus, 'grading', '还有一份未确认，试卷不应完成');

  queue = ok(await ctx.api.get('/api/papers/' + paper.id + '/queue'));
  assert.strictEqual(queue.counts.confirmed, 1);
  assert.strictEqual(queue.counts.toConfirm, 0);
  assert.strictEqual(queue.items.find((i) => i.submissionId === a.submissionId).total, MOCK_TOTAL, '确认后才给出总分');

  const editLocked = await ctx.api.put('/api/grade-items/' + graded.detail.questions[0].items[0].id, { finalScore: 1 });
  assert.strictEqual(editLocked.status, 409, '已确认的答卷不能再改分');
  const commentLocked = await ctx.api.put('/api/grade-sheets/' + sheetId, { comment: 'x' });
  assert.strictEqual(commentLocked.status, 409);
  const doubleConfirm = await ctx.api.post('/api/grade-sheets/' + sheetId + '/confirm', {});
  assert.strictEqual(doubleConfirm.status, 409, '不能重复确认');

  const unlocked = ok(await ctx.api.post('/api/grade-sheets/' + sheetId + '/unlock', { reason: '发现漏改' }));
  assert.strictEqual(unlocked.status, 'ai_done');
  const audit = getDb().prepare("SELECT * FROM audit_log WHERE action = 'unlock'").all();
  assert.strictEqual(audit.length, 1, '解锁要留审计记录');
  assert.strictEqual(audit[0].entity_id, sheetId);
  assert.strictEqual(audit[0].detail, '发现漏改');

  const reGraded = await ctx.api.post('/api/submissions/' + a.submissionId + '/grade', {});
  assert.strictEqual(reGraded.status, 200, '解锁后应能重新批改');
  void b;
});

test('M5 · 全部确认后试卷自动标记为「已完成」', async (t) => {
  const ctx = await startApp();
  t.after(() => ctx.close());
  const { paper, questions } = await seedPaper(ctx);
  const a = await seedSubmission(ctx, paper, questions, '张三');
  const b = await seedSubmission(ctx, paper, questions, '李四');

  const g1 = ok(await ctx.api.post('/api/submissions/' + a.submissionId + '/grade', {}));
  const g2 = ok(await ctx.api.post('/api/submissions/' + b.submissionId + '/grade', {}));

  ok(await ctx.api.post('/api/grade-sheets/' + g1.detail.gradeSheet.id + '/confirm', {}));
  assert.strictEqual(
    ok(await ctx.api.get('/api/papers/' + paper.id)).paper.status,
    'grading',
    '还有一份没确认'
  );

  const last = ok(await ctx.api.post('/api/grade-sheets/' + g2.detail.gradeSheet.id + '/confirm', {}));
  assert.strictEqual(last.paperStatus, 'done', '最后一份确认后试卷自动完成');

  // 完成后解锁，试卷应回到「批改中」
  ok(await ctx.api.post('/api/grade-sheets/' + g2.detail.gradeSheet.id + '/unlock', {}));
  assert.strictEqual(ok(await ctx.api.get('/api/papers/' + paper.id)).paper.status, 'grading');
});

test('M5 · 一键批量：只批未确认的，已确认的不重复批改', async (t) => {
  const ctx = await startApp();
  t.after(() => ctx.close());
  const { paper, questions } = await seedPaper(ctx);
  const a = await seedSubmission(ctx, paper, questions, '张三');
  const b = await seedSubmission(ctx, paper, questions, '李四');
  const c = await seedSubmission(ctx, paper, questions, '王五');

  const first = ok(await ctx.api.post('/api/submissions/' + a.submissionId + '/grade', {}));
  ok(await ctx.api.post('/api/grade-sheets/' + first.detail.gradeSheet.id + '/confirm', {}));
  const lockedTotal = first.detail.gradeSheet.effectiveTotal;

  const started = ok(await ctx.api.post('/api/papers/' + paper.id + '/grade-batch', {}));
  assert.strictEqual(started.job.targetCount, 2, '已确认的那份应被跳过');
  const job = await waitJob(ctx, started.job.id);
  assert.strictEqual(job.status, 'done');
  assert.strictEqual(job.done, 2);
  assert.strictEqual(job.failedCount, 0);

  const queue = ok(await ctx.api.get('/api/papers/' + paper.id + '/queue'));
  assert.strictEqual(queue.counts.confirmed, 1);
  assert.strictEqual(queue.counts.toConfirm, 2);
  assert.strictEqual(
    queue.items.find((i) => i.submissionId === a.submissionId).total,
    lockedTotal,
    '已确认的总分不能被批量任务改写'
  );
  const reGradedSheet = getDb().prepare(
    'SELECT status, final_total FROM grade_sheets WHERE submission_id = ?'
  ).get(a.submissionId);
  assert.strictEqual(reGradedSheet.status, 'confirmed');

  // 全部确认后再点批量，应明确拒绝
  ok(await ctx.api.post('/api/grade-sheets/' + getDb()
    .prepare('SELECT id FROM grade_sheets WHERE submission_id = ?').get(b.submissionId).id + '/confirm', {}));
  ok(await ctx.api.post('/api/grade-sheets/' + getDb()
    .prepare('SELECT id FROM grade_sheets WHERE submission_id = ?').get(c.submissionId).id + '/confirm', {}));
  const again = await ctx.api.post('/api/papers/' + paper.id + '/grade-batch', {});
  assert.strictEqual(again.status, 400);
  assert.ok(again.data.error.includes('没有需要批改的答卷'));
});

test('M5 · 批量失败隔离：单份失败不拖累其它，失败可单独重试', async (t) => {
  const state = { boom: true };
  const ctx = await startApp({
    aiMode: 'mock',
    aiChat: async (messages) => {
      if (state.boom && JSON.stringify(messages).includes('这份答案会让AI报错')) {
        throw new HttpError(502, '无法连接 AI 服务，请检查网络或 API Key');
      }
      return mockChat(messages);
    },
  });
  t.after(() => ctx.close());
  const { paper, questions } = await seedPaper(ctx);
  const a = await seedSubmission(ctx, paper, questions, '张三');
  const bad = await seedSubmission(ctx, paper, questions, '李四', '这份答案会让AI报错');
  const c = await seedSubmission(ctx, paper, questions, '王五');

  const started = ok(await ctx.api.post('/api/papers/' + paper.id + '/grade-batch', {}));
  const job = await waitJob(ctx, started.job.id);
  assert.strictEqual(job.status, 'done');
  assert.strictEqual(job.done, 3, '三份都要走到，不能因为中间失败就停住');
  assert.strictEqual(job.failedCount, 1);
  assert.strictEqual(job.failed[0].submissionId, bad.submissionId);
  assert.ok(job.failed[0].reason.includes('无法连接 AI 服务'));

  const queue = ok(await ctx.api.get('/api/papers/' + paper.id + '/queue'));
  assert.strictEqual(queue.counts.toConfirm, 2, '成功的两份已批改');
  assert.strictEqual(queue.counts.pending, 1, '失败的那份仍停在待批改');
  assert.ok(job.message.includes('失败'));

  // 修好之后重试失败的
  state.boom = false;
  const retry = ok(await ctx.api.post('/api/batch/' + job.id + '/retry-failed', {}));
  assert.strictEqual(retry.job.done, 0);
  assert.strictEqual(retry.job.total, 1);
  const retried = await waitJob(ctx, job.id);
  assert.strictEqual(retried.done, 1);
  assert.strictEqual(retried.failedCount, 0);

  const afterQueue = ok(await ctx.api.get('/api/papers/' + paper.id + '/queue'));
  assert.strictEqual(afterQueue.counts.toConfirm, 3);
  assert.strictEqual(afterQueue.counts.pending, 0);
  void a; void c;
});

test('M5 · 断网或没配 Key：报错清楚，且不留半份脏数据', async (t) => {
  const ctx = await startApp({
    aiMode: 'mock',
    aiChat: async () => { throw new HttpError(502, '无法连接 AI 服务，请检查网络或 API Key'); },
  });
  t.after(() => ctx.close());
  const { paper, questions } = await seedPaper(ctx);
  const { submissionId } = await seedSubmission(ctx, paper, questions, '张三');

  const res = await ctx.api.post('/api/submissions/' + submissionId + '/grade', {});
  assert.strictEqual(res.status, 502);
  assert.ok(res.data.error.includes('无法连接 AI 服务'));

  const sheet = getDb().prepare('SELECT * FROM grade_sheets WHERE submission_id = ?').get(submissionId);
  assert.ok(sheet, '评分单记录应存在，便于稍后重试');
  assert.strictEqual(sheet.status, 'ungraded', '失败了就不能算已批改');
  assert.strictEqual(sheet.ai_total, null);
  assert.strictEqual(getDb().prepare('SELECT COUNT(*) AS c FROM grade_items').get().c, 0, '不能写入半份评分明细');

  const queue = ok(await ctx.api.get('/api/papers/' + paper.id + '/queue'));
  assert.strictEqual(queue.counts.pending, 1);
  assert.strictEqual(queue.counts.toConfirm, 0);

  const sub = ok(await ctx.api.get('/api/submissions/' + submissionId));
  assert.strictEqual(sub.answers.length, 2, '学生的原始答案不能丢');
  assert.strictEqual(ok(await ctx.api.get('/api/papers/' + paper.id)).paper.status, 'collecting');
});

test('M5 · AI 返回不可解析的内容：502 并且不写脏数据', async (t) => {
  const ctx = await startApp({ aiMode: 'mock', aiChat: async () => '这不是 JSON，我也没看懂题目' });
  t.after(() => ctx.close());
  const { paper, questions } = await seedPaper(ctx);
  const { submissionId } = await seedSubmission(ctx, paper, questions, '张三');

  const res = await ctx.api.post('/api/submissions/' + submissionId + '/grade', {});
  assert.strictEqual(res.status, 502);
  assert.ok(res.data.error.includes('无法解析') || res.data.error.includes('没有返回可解析'));
  assert.strictEqual(getDb().prepare('SELECT COUNT(*) AS c FROM grade_items').get().c, 0);
  assert.strictEqual(
    getDb().prepare('SELECT status FROM grade_sheets WHERE submission_id = ?').get(submissionId).status,
    'ungraded'
  );
});

test('M5 · 改分上限校验：不得超单项满分，也不得为负', async (t) => {
  const ctx = await startApp();
  t.after(() => ctx.close());
  const { paper, questions } = await seedPaper(ctx);
  const { submissionId } = await seedSubmission(ctx, paper, questions, '张三');
  const graded = ok(await ctx.api.post('/api/submissions/' + submissionId + '/grade', {}));

  const itemId = graded.detail.questions[0].items[0].id;   // 分项题第 1 条，满分 4
  const textItemId = graded.detail.questions[1].items[0].id; // 文字题，满分 4

  const over = await ctx.api.put('/api/grade-items/' + itemId, { finalScore: 5 });
  assert.strictEqual(over.status, 400);
  assert.ok(over.data.error.includes('4'));

  const negative = await ctx.api.put('/api/grade-items/' + itemId, { finalScore: -1 });
  assert.strictEqual(negative.status, 400);

  const nan = await ctx.api.put('/api/grade-items/' + itemId, { finalScore: '四分' });
  assert.strictEqual(nan.status, 400);

  const overText = await ctx.api.put('/api/grade-items/' + textItemId, { finalScore: 4.5 });
  assert.strictEqual(overText.status, 400, '文字题也不能超过该题满分');

  const missing = await ctx.api.put('/api/grade-items/999999', { finalScore: 1 });
  assert.strictEqual(missing.status, 404);

  const badSheet = await ctx.api.put('/api/grade-sheets/999999', { comment: 'x' });
  assert.strictEqual(badSheet.status, 404);
});

test('M5 · 存疑标记可手工勾选与取消，并可写给学生的评语', async (t) => {
  const ctx = await startApp();
  t.after(() => ctx.close());
  const { paper, questions } = await seedPaper(ctx);
  const { submissionId } = await seedSubmission(ctx, paper, questions, '张三');
  const graded = ok(await ctx.api.post('/api/submissions/' + submissionId + '/grade', {}));
  const sheetId = graded.detail.gradeSheet.id;
  const itemId = graded.detail.questions[0].items[0].id;

  const flagged = ok(await ctx.api.put('/api/grade-items/' + itemId, { doubt: true, teacherNote: '步骤跳得太快' }));
  assert.strictEqual(flagged.itemId, itemId);
  let detail = ok(await ctx.api.get('/api/papers/' + paper.id + '/queue/1'));
  assert.strictEqual(detail.detail.questions[0].items[0].doubt, true);
  assert.strictEqual(detail.detail.questions[0].items[0].teacherNote, '步骤跳得太快');
  assert.strictEqual(ok(await ctx.api.get('/api/papers/' + paper.id + '/queue?filter=doubt')).total, 1);

  ok(await ctx.api.put('/api/grade-items/' + itemId, { doubt: false }));
  assert.strictEqual(ok(await ctx.api.get('/api/papers/' + paper.id + '/queue?filter=doubt')).total, 0);

  ok(await ctx.api.put('/api/grade-sheets/' + sheetId, { comment: '整体不错，注意单位' }));
  detail = ok(await ctx.api.get('/api/papers/' + paper.id + '/queue/1'));
  assert.strictEqual(detail.detail.gradeSheet.comment, '整体不错，注意单位');

  const confirmed = ok(await ctx.api.post('/api/grade-sheets/' + sheetId + '/confirm', { comment: '定稿评语' }));
  assert.strictEqual(confirmed.status, 'confirmed');
  assert.strictEqual(
    getDb().prepare('SELECT comment, final_total FROM grade_sheets WHERE id = ?').get(sheetId).comment,
    '定稿评语'
  );
});

test('M5 · 队列接口：按班号排序、seq 可定位、越界 404', async (t) => {
  const ctx = await startApp();
  t.after(() => ctx.close());
  const { paper, questions } = await seedPaper(ctx);
  await seedSubmission(ctx, paper, questions, '张三');
  await seedSubmission(ctx, paper, questions, '李四');

  const queue = ok(await ctx.api.get('/api/papers/' + paper.id + '/queue'));
  assert.strictEqual(queue.total, 2);
  assert.deepStrictEqual(queue.items.map((i) => i.seq), [1, 2]);
  assert.strictEqual(queue.filter, 'all');
  assert.strictEqual(queue.counts.pending, 2);
  assert.strictEqual(queue.counts.absent, 0);

  const second = ok(await ctx.api.get('/api/papers/' + paper.id + '/queue/2'));
  assert.strictEqual(second.entry.seq, 2);
  assert.ok(second.detail, '已批改/已建评分单的应带明细');
  assert.strictEqual(second.detail.questions.length, 2);

  const out = await ctx.api.get('/api/papers/' + paper.id + '/queue/99');
  assert.strictEqual(out.status, 404);
  assert.strictEqual((await ctx.api.get('/api/papers/9999/queue')).status, 404);

  const badFilter = ok(await ctx.api.get('/api/papers/' + paper.id + '/queue?filter=whatever'));
  assert.strictEqual(badFilter.filter, 'all', '非法筛选值回落到全部');
});

test('M5 · 缺考不批改；已确认的答卷重批要 409', async (t) => {
  const ctx = await startApp();
  t.after(() => ctx.close());
  const { paper, questions } = await seedPaper(ctx);
  const stu = await seedStudent(ctx, '缺考的甲');
  const absent = ok(await ctx.api.post('/api/papers/' + paper.id + '/submissions', {
    studentId: stu.id, status: 'absent', answers: [],
  })).submission;

  const res = await ctx.api.post('/api/submissions/' + absent.id + '/grade', {});
  assert.strictEqual(res.status, 409);
  assert.ok(res.data.error.includes('缺考'));

  const { submissionId } = await seedSubmission(ctx, paper, questions, '张三');
  const graded = ok(await ctx.api.post('/api/submissions/' + submissionId + '/grade', {}));
  ok(await ctx.api.post('/api/grade-sheets/' + graded.detail.gradeSheet.id + '/confirm', {}));

  const again = await ctx.api.post('/api/submissions/' + submissionId + '/grade', {});
  assert.strictEqual(again.status, 409, '已确认锁定，需先解锁');
  assert.ok(again.data.error.includes('解锁'));

  const forced = ok(await ctx.api.post('/api/submissions/' + submissionId + '/grade', { force: true }));
  assert.strictEqual(forced.status, 'ai_done', '带 force 可以强制重批');
});

test('M5 · 队列的「待你批改/待你确认」口径与首页四张卡一致', async (t) => {
  const ctx = await startApp();
  t.after(() => ctx.close());
  const { paper, questions } = await seedPaper(ctx);
  const a = await seedSubmission(ctx, paper, questions, '张三');
  const b = await seedSubmission(ctx, paper, questions, '李四');

  // 起始：两份都待批改
  let queue = ok(await ctx.api.get('/api/papers/' + paper.id + '/queue?filter=pending'));
  assert.strictEqual(queue.total, 2);

  const g1 = ok(await ctx.api.post('/api/submissions/' + a.submissionId + '/grade', {}));
  queue = ok(await ctx.api.get('/api/papers/' + paper.id + '/queue?filter=pending'));
  assert.strictEqual(queue.total, 1, '已批未确认的不再算待批改');
  queue = ok(await ctx.api.get('/api/papers/' + paper.id + '/queue?filter=to_confirm'));
  assert.strictEqual(queue.total, 1);

  // 手工勾一个存疑点
  ok(await ctx.api.put('/api/grade-items/' + g1.detail.questions[0].items[0].id, { doubt: true }));
  queue = ok(await ctx.api.get('/api/papers/' + paper.id + '/queue?filter=doubt'));
  assert.strictEqual(queue.total, 1, '需复核的存疑点应能被筛出来');
  assert.strictEqual(queue.items[0].doubtCount, 1);

  ok(await ctx.api.post('/api/submissions/' + b.submissionId + '/grade', {}));
  queue = ok(await ctx.api.get('/api/papers/' + paper.id + '/queue'));
  assert.strictEqual(queue.counts.pending, 0);
  assert.strictEqual(queue.counts.toConfirm, 2);
  assert.strictEqual(queue.counts.doubt, 1, '已确认的存疑点不再计入需复核');
  assert.strictEqual(queue.counts.confirmed, 0);
});
