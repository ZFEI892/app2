'use strict';

/**
 * 「图片答卷」这条路（不用出题、整卷给分）的回归测试。
 *
 * 需求原话先是「给提交图片答案单独做一个按钮，不提交到原有题目中」，
 * 后来进一步收敛为「提交图片不需要出题目，可以直接提交」——
 * 于是提交页的主路径合并成一条：填个卷名 + 整卷满分、选学生、交一组照片就成，
 * 卷名对不上就自动建一份**没有题目**的卷子。照片挂在答卷上（submissions.images），
 * 不挂到任何题目上；批改时 AI 看整组照片按整卷给一个总分 + 一份错题清单
 * （grade_sheets.whole_*），不产生逐题明细。
 *
 * 覆盖：
 * 1. 提交：一步交多张、不调识别接口，同名卷复用，与逐题作答互斥、有张数上限；
 * 2. 批改：AI 看整组照片给一个总分、不产生逐题明细、分数夹在 0~整卷满分；
 * 3. 改分与确认：整卷只有一处可改、一处可标存疑，确认后按整卷分落定；
 * 4. 统计与首页：整卷分进平均分/及格率，不进每题得分率；整卷存疑出现在首页；
 * 5. 形态切换：整卷与逐题互改时，旧的批改结果作废；
 * 6. 前端：批改页按整卷渲染（图 + 一个可改的总分 + 「图片评判」区块）；
 * 7. 错题清单：AI 必须报题号与错处、不给每题分，老师可删可补；
 * 8. 无题卷：不用出题就能收图片答卷，满分走卷上的整卷满分；
 * 9. 老数据文件的迁移安全。
 */

const test = require('node:test');
const assert = require('node:assert');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');

const { getDb } = require('../server/db');
const { mockChat } = require('../server/ai/qwen');
const { paperStats, cardCounts, homeStats, focusPaper } = require('../server/routes/stats');
const { progressOf } = require('../server/routes/papers');
const { startApp, ok, tempDir } = require('./helpers');
const { loadFrontend, has, metricCards } = require('./dom');

/* ---------------------------------- 公共部分 ---------------------------------- */

/** 一道文字说明题，默认 10 分（总分 10、及格线 6，数好算） */
function textQuestion(points) {
  return {
    stem: '简述牛顿第一定律。',
    refAnswer: '一切物体在没有受到外力作用时，总保持静止或匀速直线运动状态。',
    rubricType: 'text',
    rubricText: '答出「保持静止或匀速直线运动」得 7 分，答出「惯性」再得 3 分。',
    points: points === undefined ? 10 : points,
  };
}

async function addQuestion(ctx, body) {
  return ok(await ctx.api.post('/api/questions', body)).question;
}

async function addPaper(ctx, name, questionIds) {
  const paper = ok(await ctx.api.post('/api/papers', { name })).paper;
  const saved = ok(await ctx.api.put('/api/papers/' + paper.id + '/questions', {
    questions: questionIds.map((id) => ({ questionId: id })),
  }));
  ok(await ctx.api.post('/api/papers/' + paper.id + '/publish', {}));
  return { paper, questions: saved.questions };
}

async function addStudent(ctx, name, className) {
  return ok(await ctx.api.post('/api/students', { name, className: className || '高一(1)班' })).student;
}

/** 交一份「整份图片作答」（走的就是前端那个新页签发的那一份请求） */
async function submitWhole(ctx, paperId, studentId, images) {
  return ok(await ctx.api.post('/api/papers/' + paperId + '/submissions', {
    studentId, source: 'import', status: 'submitted', images, answers: [],
  })).submission;
}

/** 交一份逐题作答（纯文字） */
async function submitText(ctx, paperId, studentId, paperQuestionId, text) {
  return ok(await ctx.api.post('/api/papers/' + paperId + '/submissions', {
    studentId, source: 'manual', status: 'submitted',
    answers: [{ paperQuestionId, text: text || '保持静止或匀速直线运动，因为有惯性', images: [] }],
  })).submission;
}

function countRows(sql, ...params) {
  return getDb().prepare(sql).get(...params).c;
}

function gradeSheetOf(submissionId) {
  return getDb().prepare('SELECT * FROM grade_sheets WHERE submission_id = ?').get(submissionId);
}

/** 真落一张图片到附件目录，拿回可用的路径（批改时要把图片读成 data URL 送出去） */
async function uploadShot(ctx, marker) {
  const data = 'data:image/jpeg;base64,' + Buffer.from(marker || 'one-page').toString('base64');
  return ok(await ctx.api.post('/api/uploads', { data, ext: 'jpg' })).path;
}

/** 把多模态消息压成一段纯文本，便于断言提示词里有什么、没有什么 */
function promptText(messages) {
  return (Array.isArray(messages) ? messages : []).map((m) => {
    if (typeof m.content === 'string') return m.content;
    if (Array.isArray(m.content)) {
      return m.content.map((p) => (p.type === 'text' ? p.text : p.image_url.url)).join('\n');
    }
    return '';
  }).join('\n');
}

/** 记下提示词、再交给 mock 回包：既能断言送出去什么，又保住确定性分数 */
function captureMock(seen) {
  return async (messages) => {
    seen.push(promptText(messages));
    return mockChat(messages);
  };
}

function fakeShot(name, marker) {
  return { name, type: 'image/jpeg', __dataUrl: 'data:image/jpeg;base64,' + marker };
}

function tabHost(root) {
  return root.querySelector('[data-tab-host]');
}

/* --------------------------- 1 · 提交：不用出题，一步交 --------------------------- */

test('图片答卷·一步提交（接口层）：不建卷也能交，同名卷会复用', async (t) => {
  const ctx = await startApp();
  t.after(() => ctx.close());
  const stu = await addStudent(ctx, '张三');

  // 没照片 → 拦下
  assert.strictEqual((await ctx.api.post('/api/whole-submissions', {
    studentId: stu.id, paperName: '随手一卷', images: [],
  })).status, 400);
  // 没卷名 → 拦下（不然这份卷子没法归类）
  assert.strictEqual((await ctx.api.post('/api/whole-submissions', {
    studentId: stu.id, images: ['2026/01/a.jpg'],
  })).status, 400);
  assert.strictEqual(countRows('SELECT COUNT(*) AS c FROM papers'), 0, '被拦下就不该建卷');

  // 正常提交：卷名对不上已有卷子 → 自动建一份**没有题目**的卷子，满分按填的算
  const made = ok(await ctx.api.post('/api/whole-submissions', {
    studentId: stu.id,
    paperName: '随手一卷',
    wholeFullMarks: 80,
    images: ['2026/01/a.jpg', '2026/01/b.jpg'],
  }));
  assert.strictEqual(made.paper.name, '随手一卷');
  assert.strictEqual(made.fullMarks, 80);
  assert.strictEqual(made.passLine, 48, '没设及格线时按整卷满分的 60%');
  assert.strictEqual(
    countRows('SELECT COUNT(*) AS c FROM paper_questions WHERE paper_id = ?', made.paper.id), 0,
    '这份卷子不用出题，一道题都没有'
  );

  // 同名再来一份（另一个学生）→ 复用同一份卷子，不再新建
  const stu2 = await addStudent(ctx, '李四');
  const again = ok(await ctx.api.post('/api/whole-submissions', {
    studentId: stu2.id, paperName: '随手一卷', images: ['2026/01/c.jpg'],
  }));
  assert.strictEqual(again.paper.id, made.paper.id, '同名卷子要复用，别越交越多');
  assert.strictEqual(countRows('SELECT COUNT(*) AS c FROM papers'), 1);

  // 两份都是整份图片作答，题目上一条答案都没有
  const list = ok(await ctx.api.get('/api/papers/' + made.paper.id + '/submissions'));
  const row1 = list.students.find((s) => s.studentId === stu.id);
  const row2 = list.students.find((s) => s.studentId === stu2.id);
  assert.strictEqual(row1.imageCount, 2);
  assert.strictEqual(row2.imageCount, 1);
  assert.ok(list.students.every((s) => s.answerCount === 0), '一张照片都不该挂到题目上');
  const detail = ok(await ctx.api.get('/api/submissions/' + row1.submissionId));
  assert.strictEqual(detail.submission.wholeMode, true);
  assert.strictEqual(detail.images.length, 2);
  assert.ok(detail.answers.every((a) => a.images.length === 0 && a.text === ''), '题目上一条答案都没有');
});

test('图片答卷·与逐题作答互斥：两边一起交会被拦下，且不留下脏数据', async (t) => {
  const ctx = await startApp();
  t.after(() => ctx.close());
  const q1 = await addQuestion(ctx, textQuestion());
  const { paper, questions } = await addPaper(ctx, '月考', [q1.id]);
  const stu = await addStudent(ctx, '张三');

  const bad = await ctx.api.post('/api/papers/' + paper.id + '/submissions', {
    studentId: stu.id, status: 'submitted',
    images: ['2026/01/a.jpg'],
    answers: [{ paperQuestionId: questions[0].paperQuestionId, text: '我也交一份文字答案' }],
  });
  assert.strictEqual(bad.status, 400);
  has(String(bad.data.error), '二选一');
  assert.strictEqual(countRows('SELECT COUNT(*) AS c FROM submissions'), 0, '拦下就不该写库');

  // 张数上限：一次误选整个相册要被挡住
  const tooMany = await ctx.api.post('/api/papers/' + paper.id + '/submissions', {
    studentId: stu.id, status: 'submitted',
    images: Array.from({ length: 31 }, (_, i) => '2026/01/' + i + '.jpg'),
  });
  assert.strictEqual(tooMany.status, 400);
  has(String(tooMany.data.error), '最多 30 张');
  assert.strictEqual(countRows('SELECT COUNT(*) AS c FROM submissions'), 0);
});

test('图片答卷·从整卷换成逐题作答时，答卷上的照片会被清掉', async (t) => {
  const ctx = await startApp();
  t.after(() => ctx.close());
  const q1 = await addQuestion(ctx, textQuestion());
  const { paper, questions } = await addPaper(ctx, '月考', [q1.id]);
  const stu = await addStudent(ctx, '张三');

  const sub = await submitWhole(ctx, paper.id, stu.id, ['2026/01/a.jpg', '2026/01/b.jpg']);
  assert.strictEqual(sub.wholeMode, true);

  const after = ok(await ctx.api.post('/api/papers/' + paper.id + '/submissions', {
    studentId: stu.id, source: 'manual', status: 'submitted',
    answers: [{ paperQuestionId: questions[0].paperQuestionId, text: '改成逐题交', images: [] }],
  })).submission;
  assert.strictEqual(after.wholeMode, false);
  assert.strictEqual(after.imageCount, 0, '换了形态，整卷照片不能再留着');

  const detail = ok(await ctx.api.get('/api/submissions/' + sub.id));
  assert.deepStrictEqual(detail.images, []);
  assert.strictEqual(detail.answers[0].text, '改成逐题交');
});

/* ------------------------- 2 · 批改：整卷一个总分，不拆题 ------------------------- */

test('整卷批改·AI 看整组照片给一个总分，不产生任何逐题明细', async (t) => {
  const seen = [];
  const ctx = await startApp({ aiMode: 'mock', aiChat: captureMock(seen) });
  t.after(() => ctx.close());
  const q1 = await addQuestion(ctx, textQuestion());   // 10 分
  const { paper } = await addPaper(ctx, '月考', [q1.id]);
  const stu = await addStudent(ctx, '张三');

  const up = ok(await ctx.api.post('/api/uploads', {
    data: 'data:image/jpeg;base64,' + Buffer.from('page-1-bytes').toString('base64'), ext: 'jpg',
  }));
  const sub = await submitWhole(ctx, paper.id, stu.id, [up.path]);

  const res = ok(await ctx.api.post('/api/submissions/' + sub.id + '/grade', {}));
  assert.strictEqual(res.whole, true, '回报里要说明这是整卷批的');
  assert.strictEqual(res.aiTotal, 7.5, 'mock 按整卷满分的 75% 给：10 × 0.75');
  assert.strictEqual(res.imageCount, 1);
  assert.strictEqual(res.comments.length, 0, '整卷没有逐题评语');

  const sheet = gradeSheetOf(sub.id);
  assert.strictEqual(sheet.status, 'ai_done');
  assert.strictEqual(sheet.whole_mode, 'auto');
  assert.strictEqual(sheet.whole_ai_score, 7.5);
  assert.strictEqual(sheet.ai_total, 7.5);
  assert.ok(String(sheet.whole_reason).length > 0, '整卷要给一个理由');
  assert.strictEqual(
    countRows('SELECT COUNT(*) AS c FROM grade_items WHERE grade_sheet_id = ?', sheet.id), 0,
    '整卷批改不能编造题号去逐条列分'
  );

  // 提示词：认的是「整卷」，照片以图片形式送进去，且不摆评分标准
  const prompt = seen[0];
  assert.ok(prompt.includes('"task":"grade_whole"'), '要按整卷这个任务送');
  assert.ok(prompt.includes('data:image/jpeg;base64,'), '照片要以图片形式送进 AI');
  assert.ok(prompt.includes('没有按题目切分'), '提示词要说清作答没拆题');
  assert.ok(!prompt.includes('答出「惯性」再得 3 分'), '整卷不看逐条评分标准');

  // 批改详情：kind 是 whole，整卷分在 whole 里
  const detail = ok(await ctx.api.get('/api/papers/' + paper.id + '/queue/1'));
  assert.strictEqual(detail.detail.kind, 'whole');
  assert.strictEqual(detail.detail.whole.imageCount, 1);
  assert.strictEqual(detail.detail.whole.aiScore, 7.5);
  assert.strictEqual(detail.detail.whole.effectiveScore, 7.5);
  assert.strictEqual(detail.detail.gradeSheet.effectiveTotal, 7.5);
  assert.strictEqual(detail.entry.whole, true);
});

test('整卷批改·扣分参与总分：总分=满分−扣分之和，扣分超界会被夹住', async (t) => {
  const over = await startApp({
    aiMode: 'mock',
    aiChat: async () => JSON.stringify({
      score: 999, reason: '乱给', confidence: 0.5, comment: '',
      wrong: [
        { no: '1', deduct: 999, where: '错在这', issue: '错成了这个' },
        { no: '2', deduct: 999, where: '错在这', issue: '错成了这个' },
      ],
    }),
  });
  t.after(() => over.close());
  const q1 = await addQuestion(over, textQuestion());
  const { paper, questions: pq } = await addPaper(over, '月考', [q1.id]);
  const stu = await addStudent(over, '张三');
  const sub = await submitWhole(over, paper.id, stu.id, [await uploadShot(over, 'over-page')]);

  const res = ok(await over.api.post('/api/submissions/' + sub.id + '/grade', {}));
  assert.strictEqual(res.aiTotal, 0, '扣分总和超过满分要夹到满分，总分归 0');
  assert.strictEqual(res.doubt, true, '把握 0.5 低于阈值 0.75，要标存疑');

  const sheet = gradeSheetOf(sub.id);
  assert.strictEqual(sheet.whole_ai_score, 0);
  assert.strictEqual(sheet.whole_doubt, 1);
  assert.strictEqual(
    countRows('SELECT COUNT(*) AS c FROM grade_items WHERE grade_sheet_id = ?', sheet.id), 0
  );
  assert.strictEqual(pq.length, 1);

  // 没有错题 → 不扣分，总分就是满分
  const clean = await startApp({
    aiMode: 'mock',
    aiChat: async () => JSON.stringify({ score: 0, reason: '全对', confidence: 1, wrong: [] }),
  });
  t.after(() => clean.close());
  const q2 = await addQuestion(clean, textQuestion());
  const p2 = await addPaper(clean, '月考', [q2.id]);
  const stu2 = await addStudent(clean, '李四');
  const sub2 = await submitWhole(clean, p2.paper.id, stu2.id, [await uploadShot(clean, 'clean-page')]);
  const res2 = ok(await clean.api.post('/api/submissions/' + sub2.id + '/grade', {}));
  assert.strictEqual(res2.aiTotal, 10, '没有错题就不扣分，总分是满分 10');
  assert.strictEqual(res2.doubt, false);
});

/* ---------------------------- 3 · 改分、存疑与确认 ---------------------------- */

test('整卷改分·只改这一个总分：不超满分，确认后按整卷分落定', async (t) => {
  const ctx = await startApp();
  t.after(() => ctx.close());
  const q1 = await addQuestion(ctx, textQuestion());   // 10 分
  const { paper, questions } = await addPaper(ctx, '月考', [q1.id]);
  const stu = await addStudent(ctx, '张三');
  const sub = await submitWhole(ctx, paper.id, stu.id, [await uploadShot(ctx, 'grade-page')]);
  ok(await ctx.api.post('/api/submissions/' + sub.id + '/grade', {}));
  const sheet = gradeSheetOf(sub.id);

  // 超过满分 → 挡住，并说清满分是多少
  const tooHigh = await ctx.api.put('/api/grade-sheets/' + sheet.id + '/whole', { finalScore: 12 });
  assert.strictEqual(tooHigh.status, 400);
  has(String(tooHigh.data.error), '10');

  // 负数 → 挡住
  assert.strictEqual(
    (await ctx.api.put('/api/grade-sheets/' + sheet.id + '/whole', { finalScore: -1 })).status, 400
  );

  // 老师改分 + 标存疑
  const changed = ok(await ctx.api.put('/api/grade-sheets/' + sheet.id + '/whole', {
    finalScore: 8.5, doubt: true,
  }));
  assert.strictEqual(changed.wholeFinalScore, 8.5);
  assert.strictEqual(changed.doubt, true);
  assert.strictEqual(changed.effectiveTotal, 8.5);

  // 确认：落定的就是整卷这个分（不是拿明细求和，明细本来就是空的）
  const confirmed = ok(await ctx.api.post('/api/grade-sheets/' + sheet.id + '/confirm', {}));
  assert.strictEqual(confirmed.finalTotal, 8.5);
  const after = gradeSheetOf(sub.id);
  assert.strictEqual(after.status, 'confirmed');
  assert.strictEqual(after.final_total, 8.5);
  assert.strictEqual(
    countRows('SELECT COUNT(*) AS c FROM grade_items WHERE grade_sheet_id = ?', sheet.id), 0
  );

  // 已确认锁定后不许再改
  const locked = await ctx.api.put('/api/grade-sheets/' + sheet.id + '/whole', { finalScore: 9 });
  assert.strictEqual(locked.status, 409);
  has(String(locked.data.error), '已确认锁定');

  // 解锁后回到待确认，改分重新开放
  ok(await ctx.api.post('/api/grade-sheets/' + sheet.id + '/unlock', {}));
  const again = ok(await ctx.api.put('/api/grade-sheets/' + sheet.id + '/whole', { finalScore: 9 }));
  assert.strictEqual(again.effectiveTotal, 9);

  assert.strictEqual(questions.length, 1, '整卷批完也不能反过来给题目生成明细');
});

test('整卷改分·逐题答卷不能走整卷这个口子', async (t) => {
  const ctx = await startApp();
  t.after(() => ctx.close());
  const q1 = await addQuestion(ctx, textQuestion());
  const { paper, questions } = await addPaper(ctx, '月考', [q1.id]);
  const stu = await addStudent(ctx, '张三');
  const sub = await submitText(ctx, paper.id, stu.id, questions[0].paperQuestionId);
  ok(await ctx.api.post('/api/submissions/' + sub.id + '/grade', {}));
  const sheet = gradeSheetOf(sub.id);

  const res = await ctx.api.put('/api/grade-sheets/' + sheet.id + '/whole', { finalScore: 5 });
  assert.strictEqual(res.status, 409);
  has(String(res.data.error), '逐题批改');
});

/* ------------------------- 4 · 统计口径与首页（含存疑） ------------------------- */

test('统计·整卷分算进平均分和及格率，但不进每题得分率', async (t) => {
  const ctx = await startApp();
  t.after(() => ctx.close());
  const q1 = await addQuestion(ctx, textQuestion());   // 10 分，及格线 6
  const { paper, questions } = await addPaper(ctx, '月考', [q1.id]);
  const a = await addStudent(ctx, '张三');
  const b = await addStudent(ctx, '李四');

  // 甲：逐题交文字 → 走评分标准，mock 给 7.5
  const subA = await submitText(ctx, paper.id, a.id, questions[0].paperQuestionId);
  ok(await ctx.api.post('/api/submissions/' + subA.id + '/grade', {}));
  const sheetA = gradeSheetOf(subA.id);
  ok(await ctx.api.post('/api/grade-sheets/' + sheetA.id + '/confirm', {}));

  // 乙：交整卷图片 → 只给一个总分，老师手动改成 3（不及格）
  const subB = await submitWhole(ctx, paper.id, b.id, [await uploadShot(ctx, 'b-page')]);
  ok(await ctx.api.post('/api/submissions/' + subB.id + '/grade', {}));
  const sheetB = gradeSheetOf(subB.id);
  ok(await ctx.api.put('/api/grade-sheets/' + sheetB.id + '/whole', { finalScore: 3 }));
  ok(await ctx.api.post('/api/grade-sheets/' + sheetB.id + '/confirm', {}));

  const stats = paperStats(paper.id);
  assert.strictEqual(stats.overview.count, 2, '两份都确认了');
  assert.strictEqual(stats.overview.average, 5.25, '(7.5 + 3) / 2');
  assert.strictEqual(stats.overview.passCount, 1);
  assert.strictEqual(stats.overview.passRate, 0.5);

  // 每题得分率：只有逐题交上来的甲算得进去
  assert.strictEqual(stats.questions[0].sheetCount, 1);
  assert.strictEqual(stats.questions[0].scoreSum, 7.5);
  assert.strictEqual(stats.questions[0].rate, 0.75);

  // 排名里两个人都要在，且乙被标成「图片答卷」
  assert.deepStrictEqual(stats.students.map((s) => [s.name, s.total, s.whole]), [
    ['张三', 7.5, false],
    ['李四', 3, true],
  ]);
  assert.strictEqual(stats.students[1].passed, false);

  // 待讲评只认逐题的得分率，所以这道题（75%）不该被列进去
  assert.strictEqual(stats.ranking[0].rate, 0.75);
});

test('首页·整卷存疑要算进需复核卡，并在列表里显示「整卷」', async (t) => {
  const ctx = await startApp({
    aiMode: 'mock',
    aiChat: async () => JSON.stringify({
      score: 6, reason: '照片有点糊，拿不准', confidence: 0.4, comment: '',
      wrong: [{ no: '3', deduct: 4, where: '看不清', issue: '照片模糊，判断不确定' }],
    }),
  });
  t.after(() => ctx.close());
  const q1 = await addQuestion(ctx, textQuestion());
  const { paper } = await addPaper(ctx, '月考', [q1.id]);
  const stu = await addStudent(ctx, '张三');
  const sub = await submitWhole(ctx, paper.id, stu.id, [await uploadShot(ctx, 'doubt-page')]);
  ok(await ctx.api.post('/api/submissions/' + sub.id + '/grade', {}));

  assert.strictEqual(cardCounts().doubt, 1, '整卷存疑也是存疑');
  assert.strictEqual(progressOf(paper.id).doubt, 1, '试卷进度上的存疑数也要算');

  const home = homeStats();
  assert.strictEqual(home.cards.doubt.count, 1);
  assert.strictEqual(home.cards.doubt.focus.paperId, paper.id);
  assert.strictEqual(focusPaper('doubt').paperId, paper.id, '点卡片要能落到这份试卷');

  // 左栏「需要你处理」：待确认一条（带整卷标记）+ 存疑一条（没有题号）
  assert.strictEqual(home.left.sheets.length, 1);
  assert.strictEqual(home.left.sheets[0].whole, true);
  assert.strictEqual(home.left.sheets[0].effectiveTotal, 6);
  assert.strictEqual(home.left.sheets[0].doubtCount, 1);
  assert.strictEqual(home.left.doubts.length, 1);
  assert.strictEqual(home.left.doubts[0].whole, true);
  assert.strictEqual(home.left.doubts[0].seq, null, '整卷存疑没有题号');
  assert.ok(String(home.left.doubts[0].reason).length > 0);

  // 首页前端：卡片数字、整卷徽标、以及存疑条目的「整卷」字样
  const { registry, root } = loadFrontend(ctx.base, ['pages/home.js']);
  await registry.home.render(root, {});
  const html = root.innerHTML;
  const doubtCard = metricCards(html).find((c) => c.key === 'doubt');
  assert.strictEqual(doubtCard.value, '1');
  assert.strictEqual(doubtCard.query.paper, paper.id);
  has(html, '整卷');
  has(html, '图片答卷');
  assert.ok(!html.includes('第 null 题'), '整卷存疑不能显示成「第 null 题」');
  assert.strictEqual((html.match(/分待定/g) || []).length, 1);
});

test('首页·待批改与待确认的口径把整卷答卷一起算上', async (t) => {
  const ctx = await startApp();
  t.after(() => ctx.close());
  const q1 = await addQuestion(ctx, textQuestion());
  const { paper } = await addPaper(ctx, '月考', [q1.id]);
  const stu = await addStudent(ctx, '张三');
  const sub = await submitWhole(ctx, paper.id, stu.id, [await uploadShot(ctx, 'count-page')]);

  assert.strictEqual(cardCounts().toGrade, 1, '整卷答卷刚交上来同样是待批改');
  ok(await ctx.api.post('/api/submissions/' + sub.id + '/grade', {}));
  assert.strictEqual(cardCounts().toGrade, 0);
  assert.strictEqual(cardCounts().toConfirm, 1, '批完就是待确认');
  assert.strictEqual(progressOf(paper.id).toConfirm, 1);

  const queue = ok(await ctx.api.get('/api/papers/' + paper.id + '/queue?filter=to_confirm'));
  assert.strictEqual(queue.total, 1);
  assert.strictEqual(queue.items[0].whole, true);
  assert.strictEqual(queue.items[0].doubtCount, 0);
});

/* ------------------------------ 5 · 形态切换作废旧结果 ------------------------------ */

test('形态切换·整卷批改确认后再改成逐题作答，旧结果作废', async (t) => {
  const ctx = await startApp();
  t.after(() => ctx.close());
  const q1 = await addQuestion(ctx, textQuestion());
  const { paper, questions } = await addPaper(ctx, '月考', [q1.id]);
  const stu = await addStudent(ctx, '张三');

  const sub = await submitWhole(ctx, paper.id, stu.id, [await uploadShot(ctx, 'morph-page')]);
  ok(await ctx.api.post('/api/submissions/' + sub.id + '/grade', {}));
  const sheet = gradeSheetOf(sub.id);
  ok(await ctx.api.put('/api/grade-sheets/' + sheet.id + '/whole', { finalScore: 9 }));
  ok(await ctx.api.post('/api/grade-sheets/' + sheet.id + '/confirm', {}));
  assert.strictEqual(gradeSheetOf(sub.id).final_total, 9);

  // 老师发现交错了，改成逐题作答 → 整卷那 9 分不能再留着当成绩
  ok(await ctx.api.post('/api/papers/' + paper.id + '/submissions', {
    studentId: stu.id, source: 'manual', status: 'submitted',
    answers: [{ paperQuestionId: questions[0].paperQuestionId, text: '其实我是逐题交的', images: [] }],
  }));

  const after = gradeSheetOf(sub.id);
  assert.strictEqual(after.status, 'ungraded');
  assert.strictEqual(after.final_total, null);
  assert.strictEqual(after.whole_mode, '');
  assert.strictEqual(after.whole_ai_score, null);
  assert.strictEqual(after.whole_final_score, null);
  assert.strictEqual(cardCounts().toGrade, 1, '作废后回到待批改');
  assert.strictEqual(paperStats(paper.id).overview.count, 0);
});

/* --------------------------- 6 · 批改页按整卷渲染 --------------------------- */

test('批改页·整卷答卷渲染整组照片 + 一个可改的总分，没有题号页签', async (t) => {
  const ctx = await startApp();
  t.after(() => ctx.close());
  const q1 = await addQuestion(ctx, textQuestion());   // 10 分
  const { paper } = await addPaper(ctx, '月考', [q1.id]);
  const stu = await addStudent(ctx, '张三');
  const shots = [await uploadShot(ctx, 'ui-1'), await uploadShot(ctx, 'ui-2')];
  const sub = await submitWhole(ctx, paper.id, stu.id, shots);
  ok(await ctx.api.post('/api/submissions/' + sub.id + '/grade', {}));

  const { registry, root, captured } = loadFrontend(ctx.base, ['pages/grading.js']);
  await registry.grading.render(root, { paper: String(paper.id), filter: 'to_confirm', seq: 1 });

  const html = root.innerHTML;
  has(html, '图片答卷 · 整卷给分');
  has(html, '学生答案 · 整份图片（2 张）');
  has(html, '整卷总分');
  has(html, '整卷自主评判');
  assert.strictEqual(
    (html.match(/class="answer-img"/g) || []).length, 2, '整组两张照片都要显示出来'
  );
  assert.strictEqual(root.querySelectorAll('[data-qi]').length, 0, '整卷没有题号页签');
  assert.strictEqual(root.querySelectorAll('[data-score]').length, 0, '也没有逐项评分的输入框');

  const input = root.querySelector('[data-whole-score]');
  assert.strictEqual(input.value, '7.5', '默认显示 AI 给的整卷分');
  has(html, 'data-total>7.5</b>', '底部总分就是整卷分');

  // 老师改分：打的接口就是整卷那个，底部总分跟着走
  input.value = '8';
  await input.fire('change');
  const put = captured.requests.find((r) => r.method === 'PUT' && /\/api\/grade-sheets\/\d+\/whole$/.test(r.url));
  assert.ok(put, '改整卷分要打 /api/grade-sheets/:id/whole');
  assert.deepStrictEqual(JSON.parse(put.body), { finalScore: 8 });
  assert.strictEqual(root.querySelector('[data-total]').textContent, '8');
  assert.strictEqual(gradeSheetOf(sub.id).whole_final_score, 8);

  // 勾存疑：整卷那一处
  const doubtBox = root.querySelector('[data-whole-doubt]');
  doubtBox.checked = true;
  await doubtBox.fire('change');
  assert.strictEqual(gradeSheetOf(sub.id).whole_doubt, 1);
  assert.strictEqual(cardCounts().doubt, 1);
});

test('批改页·逐题答卷仍然渲染题目页签与逐项评分，不受整卷改动影响', async (t) => {
  const ctx = await startApp();
  t.after(() => ctx.close());
  const q1 = await addQuestion(ctx, textQuestion());
  const q2 = await addQuestion(ctx, textQuestion(5));
  const { paper, questions } = await addPaper(ctx, '月考', [q1.id, q2.id]);
  const stu = await addStudent(ctx, '张三');
  const sub = await submitText(ctx, paper.id, stu.id, questions[0].paperQuestionId);
  ok(await ctx.api.post('/api/submissions/' + sub.id + '/grade', {}));

  const { registry, root } = loadFrontend(ctx.base, ['pages/grading.js']);
  await registry.grading.render(root, { paper: String(paper.id), filter: 'to_confirm', seq: 1 });

  assert.strictEqual(root.querySelectorAll('[data-qi]').length, 2, '逐题答卷照旧有题号页签');
  assert.ok(root.querySelectorAll('[data-score]').length > 0, '逐项评分的输入框要在');
  assert.strictEqual(root.querySelectorAll('[data-whole-score]').length, 0, '不该冒出整卷输入框');
  const detail = ok(await ctx.api.get('/api/papers/' + paper.id + '/queue/1'));
  assert.strictEqual(detail.detail.kind, 'perQuestion');
  assert.strictEqual(detail.detail.whole, null);
});

/* ---------------------- 7 · 图片评判：AI 要报出错题号与错在哪 ---------------------- */

test('图片评判·整卷批改要报出「哪一题 + 扣多少分 + 错在哪」', async (t) => {
  const seen = [];
  const ctx = await startApp({ aiMode: 'mock', aiChat: captureMock(seen) });
  t.after(() => ctx.close());
  const q1 = await addQuestion(ctx, textQuestion());   // 10 分
  const { paper } = await addPaper(ctx, '月考', [q1.id]);
  const stu = await addStudent(ctx, '张三');
  const sub = await submitWhole(ctx, paper.id, stu.id, [await uploadShot(ctx, 'wrong-page')]);

  const res = ok(await ctx.api.post('/api/submissions/' + sub.id + '/grade', {}));
  assert.strictEqual(res.wrongCount, 2, 'mock 指出两处错');
  assert.strictEqual(res.wrong[0].no, '2');
  assert.strictEqual(res.wrong[0].where, '第 2 步受力分析');
  assert.strictEqual(res.wrong[0].issue, '摩擦力方向标反了，导致合外力算错');
  assert.strictEqual(res.wrong[0].deduct, 1.25, '每道错题要带扣分（满分 10 的 1/8）');
  res.wrong.forEach((w) => {
    assert.ok(Number.isFinite(w.deduct), '每条错题都要有扣分');
    assert.ok(!('score' in w), '错题条目里不再单独给分数（只有扣分）');
    assert.ok(w.issue, '每条都要说清错在哪');
  });

  // 库里存的是结构化的错题清单
  const sheet = gradeSheetOf(sub.id);
  assert.deepStrictEqual(JSON.parse(sheet.whole_wrong), res.wrong);
  assert.strictEqual(
    countRows('SELECT COUNT(*) AS c FROM grade_items WHERE grade_sheet_id = ?', sheet.id), 0,
    '报了错题也仍然不产生逐题明细'
  );

  // 详情接口照原样带给批改页
  const detail = ok(await ctx.api.get('/api/papers/' + paper.id + '/queue/1'));
  assert.strictEqual(detail.detail.whole.wrong.length, 2);
  assert.strictEqual(detail.detail.whole.wrong[1].no, '4');
  assert.strictEqual(detail.detail.whole.wrong[1].where, '最后一问的单位');

  // 提示词：要报题号 + 扣分 + 错在哪；优先按照片里印的评分机制
  const prompt = seen[0];
  assert.ok(prompt.includes('错题清单'), '提示词要交代错题清单');
  assert.ok(prompt.includes('错在**哪一处**'), '要问清错在哪一处');
  assert.ok(prompt.includes('卷面上学生自己写的或印着的题号'), '题号只认卷面上的');
  assert.ok(prompt.includes('留空'), '看不清题号要留空，不许猜');
  assert.ok(prompt.includes('扣多少分'), '要报每道错题的扣分');
  assert.ok(prompt.includes('优先按照片里印着的评分机制'), '优先读照片里印的评分机制');
  assert.ok(prompt.includes('总分 = 满分'), '总分 = 满分 − 扣分之和');
  assert.ok(prompt.includes('只看学生最终写下的答案'), '要只看最终答案、独立判断，别照搬卷面批改痕迹');
  assert.ok(prompt.includes('不要采信'), '卷面上已有的批改痕迹不要采信');
  assert.ok(!prompt.includes('"items"'), '整卷这条路不能要求逐项给分');
});

test('图片评判·错题清单的脏数据要在入库前收拾干净', async (t) => {
  const dirty = JSON.stringify({
    score: 6,
    reason: '有几处错',
    confidence: 0.9,
    // 不是数组的、空的、没有信息量的、字段名写错的、超长的、超量的都混进来
    wrong: [
      { no: '3', where: ' 第 2 步 ', issue: ' 漏了摩擦力方向 ' },
      { seq: 5, at: '结论句', reason: '单位写成 N' },
      { no: '7' },
      null,
      '这不是对象',
      { where: 'x'.repeat(400), issue: 'y' },
    ].concat(Array.from({ length: 40 }, (_, i) => ({ no: String(i), issue: '第 ' + i + ' 处' }))),
  });
  const ctx = await startApp({ aiMode: 'mock', aiChat: async () => dirty });
  t.after(() => ctx.close());
  const q1 = await addQuestion(ctx, textQuestion());
  const { paper } = await addPaper(ctx, '月考', [q1.id]);
  const stu = await addStudent(ctx, '张三');
  const sub = await submitWhole(ctx, paper.id, stu.id, [await uploadShot(ctx, 'dirty-page')]);

  const res = ok(await ctx.api.post('/api/submissions/' + sub.id + '/grade', {}));
  assert.strictEqual(res.wrong[0].where, '第 2 步', '前后空白要修掉');
  assert.strictEqual(res.wrong[1].no, '5', '字段名写成 seq / at / reason 也要认');
  assert.strictEqual(res.wrongCount, 30, '最多留 30 条');
  assert.ok(res.wrong.every((w) => w.issue.length <= 200), '每段文字不能超过 200 字');
  assert.ok(!res.wrong.some((w) => !w.where && !w.issue), '什么都说不出来的条目要丢掉');
  assert.ok(res.wrong.every((w) => typeof w.no === 'string' && typeof w.where === 'string'));

  // 整份都对 → 空清单，页面上给一句人话
  const clean = await startApp({
    aiMode: 'mock',
    aiChat: async () => JSON.stringify({ score: 9, reason: '都对', confidence: 0.9, wrong: '没有什么错' }),
  });
  t.after(() => clean.close());
  const cq = await addQuestion(clean, textQuestion());
  const cp = await addPaper(clean, '月考', [cq.id]);
  const cs = await addStudent(clean, '李四');
  const csub = await submitWhole(clean, cp.paper.id, cs.id, [await uploadShot(clean, 'clean-page')]);
  const cres = ok(await clean.api.post('/api/submissions/' + csub.id + '/grade', {}));
  assert.deepStrictEqual(cres.wrong, [], 'wrong 不是数组时当空清单');
  assert.strictEqual(gradeSheetOf(csub.id).whole_wrong, '[]');

  const { registry, root } = loadFrontend(clean.base, ['pages/grading.js']);
  await registry.grading.render(root, { paper: String(cp.paper.id), filter: 'to_confirm', seq: 1 });
  has(root.innerHTML, '图片评判 · AI 指出的错题');
  has(root.innerHTML, 'AI 没有指出明显的错题');
});

test('图片评判·老师可以删掉 AI 认错的、也能自己补一条', async (t) => {
  const ctx = await startApp();
  t.after(() => ctx.close());
  const q1 = await addQuestion(ctx, textQuestion());
  const { paper } = await addPaper(ctx, '月考', [q1.id]);
  const stu = await addStudent(ctx, '张三');
  const sub = await submitWhole(ctx, paper.id, stu.id, [await uploadShot(ctx, 'wrong-ui')]);
  ok(await ctx.api.post('/api/submissions/' + sub.id + '/grade', {}));
  const sheet = gradeSheetOf(sub.id);

  const { registry, root, captured } = loadFrontend(ctx.base, ['pages/grading.js']);
  await registry.grading.render(root, { paper: String(paper.id), filter: 'to_confirm', seq: 1 });

  const html = root.innerHTML;
  has(html, '图片评判 · AI 指出的错题');
  has(html, '第 2 题');
  has(html, '第 2 步受力分析');
  has(html, '摩擦力方向标反了，导致合外力算错');
  assert.strictEqual(root.querySelectorAll('[data-wrong-del]').length, 2, '两条错题各有一个删掉按钮');

  // AI 把第 2 题认错了 → 删掉那一条
  await root.querySelector('[data-wrong-del="0"]').click();
  const put1 = captured.requests.filter((r) => r.method === 'PUT' && /\/whole$/.test(r.url));
  assert.strictEqual(put1.length, 1, '删除也要走整卷那个端点');
  const sent1 = JSON.parse(put1[0].body).wrong;
  assert.strictEqual(sent1.length, 1);
  assert.strictEqual(sent1[0].no, '4');
  assert.strictEqual(JSON.parse(gradeSheetOf(sub.id).whole_wrong).length, 1);
  has(captured.toasts[captured.toasts.length - 1].text, '1 条错题');

  // 老师自己补一条
  root.querySelector('[data-wrong-no]').value = '6';
  root.querySelector('[data-wrong-issue]').value = '第 3 问忘了讨论摩擦力为零的情况';
  await root.querySelector('[data-wrong-add]').click();
  const stored = JSON.parse(gradeSheetOf(sub.id).whole_wrong);
  assert.strictEqual(stored.length, 2, '删一条、补一条，最后两条');
  assert.deepStrictEqual(stored[1], { no: '6', where: '', issue: '第 3 问忘了讨论摩擦力为零的情况', deduct: 0 });

  // 只写题号不写错在哪 → 拦下
  root.querySelector('[data-wrong-no]').value = '7';
  root.querySelector('[data-wrong-issue]').value = '   ';
  await root.querySelector('[data-wrong-add]').click();
  assert.strictEqual(JSON.parse(gradeSheetOf(sub.id).whole_wrong).length, 2, '空话不落库');
  has(captured.toasts[captured.toasts.length - 1].text, '请写下错在哪');

  // 确认锁定后清单只读：不给删、不给补
  ok(await ctx.api.post('/api/grade-sheets/' + sheet.id + '/confirm', {}));
  await registry.grading.render(root, { paper: String(paper.id), filter: 'all', seq: 1 });
  has(root.innerHTML, '已确认锁定');
  has(root.innerHTML, '图片评判 · AI 指出的错题');
  assert.strictEqual(root.querySelectorAll('[data-wrong-del]').length, 0, '锁定后不能再删');
  assert.strictEqual(root.querySelectorAll('[data-wrong-add]').length, 0, '锁定后不能再补');
  has(root.innerHTML, '第 3 问忘了讨论摩擦力为零的情况');
});

test('补删错题后，AI 分自动按「满分 − 各错题扣分之和」重算', async (t) => {
  const ctx = await startApp();
  t.after(() => ctx.close());
  const q1 = await addQuestion(ctx, textQuestion(100));   // 满分 100
  const { paper } = await addPaper(ctx, '月考', [q1.id]);
  const stu = await addStudent(ctx, '张三');
  const sub = await submitWhole(ctx, paper.id, stu.id, [await uploadShot(ctx, 'deduct-ui')]);
  ok(await ctx.api.post('/api/submissions/' + sub.id + '/grade', {}));
  const sheet = gradeSheetOf(sub.id);
  // mock：两道错题各扣 12.5，AI 分 = 100 − 25 = 75
  assert.strictEqual(sheet.whole_ai_score, 75);

  // 删掉第 4 题（扣 12.5）→ AI 分重算 = 87.5
  const delRes = ok(await ctx.api.put('/api/grade-sheets/' + sheet.id + '/whole', {
    wrong: [{ no: '2', deduct: 12.5, where: '第 2 步受力分析', issue: '摩擦力方向标反了' }],
  }));
  assert.strictEqual(delRes.aiScore, 87.5, '删一条后 AI 分按剩余扣分重算');
  assert.strictEqual(gradeSheetOf(sub.id).whole_ai_score, 87.5);

  // 再补一条扣 5 分 → AI 分 = 82.5
  const addRes = ok(await ctx.api.put('/api/grade-sheets/' + sheet.id + '/whole', {
    wrong: [
      { no: '2', deduct: 12.5, where: '第 2 步受力分析', issue: '摩擦力方向标反了' },
      { no: '9', deduct: 5, where: '最后一问', issue: '漏了分类讨论' },
    ],
  }));
  assert.strictEqual(addRes.aiScore, 82.5, '补一条带扣分后 AI 分跟着降');
  assert.strictEqual(gradeSheetOf(sub.id).whole_ai_score, 82.5);

  // 扣分超过满分 → AI 分夹到 0
  const overRes = ok(await ctx.api.put('/api/grade-sheets/' + sheet.id + '/whole', {
    wrong: [
      { no: '1', deduct: 999, where: 'x', issue: 'y' },
      { no: '2', deduct: 999, where: 'x', issue: 'y' },
    ],
  }));
  assert.strictEqual(overRes.aiScore, 0, '扣分之和超满分要夹到满分，AI 分归 0');
});

test('同一张照片重复批改会复用上次结果，判分一致；force 才重新判', async (t) => {
  const ctx = await startApp();
  t.after(() => ctx.close());
  const q1 = await addQuestion(ctx, textQuestion(150));   // 满分 150
  const { paper } = await addPaper(ctx, '月考', [q1.id]);
  const stu1 = await addStudent(ctx, '张三');
  const shot = await uploadShot(ctx, 'same-page');

  // 第一份答卷：正常 AI 批改
  const sub1 = await submitWhole(ctx, paper.id, stu1.id, [shot]);
  const res1 = ok(await ctx.api.post('/api/submissions/' + sub1.id + '/grade', {}));
  assert.strictEqual(res1.reused, false, '第一次判不算复用');
  assert.strictEqual(res1.aiTotal, 112.5, '150 的 75%');

  // 第二个学生交同一张照片：复用上次结果，判分一致
  const stu2 = await addStudent(ctx, '李四');
  const sub2 = await submitWhole(ctx, paper.id, stu2.id, [shot]);
  const res2 = ok(await ctx.api.post('/api/submissions/' + sub2.id + '/grade', {}));
  assert.strictEqual(res2.reused, true, '同一张照片要复用上次结果');
  assert.strictEqual(res2.aiTotal, 112.5, '复用后分数一致');
  assert.deepStrictEqual(res2.wrong, res1.wrong, '错题清单也一致');

  // force 重批：绕过复用，重新让 AI 判
  const res3 = ok(await ctx.api.post('/api/submissions/' + sub2.id + '/grade', { force: true }));
  assert.strictEqual(res3.reused, false, 'force 时绕过复用，重新判');
  assert.strictEqual(res3.aiTotal, 112.5);
});

test('并行批改下，同图的两份也复用，只调一次 AI、分数一致', async (t) => {
  // 每次调用扣分递增，这样"复用与否"能用分数和调用次数一眼看出来
  let callCount = 0;
  const ctx = await startApp({
    aiMode: 'mock',
    aiChat: async () => {
      callCount += 1;
      return JSON.stringify({
        score: 0, reason: '第 ' + callCount + ' 次调用', confidence: 0.9, comment: '',
        wrong: [{ no: '1', deduct: callCount * 10, where: '错在这', issue: '错成了这个' }],
      });
    },
  });
  t.after(() => ctx.close());
  const q1 = await addQuestion(ctx, textQuestion(150));   // 满分 150
  const { paper } = await addPaper(ctx, '月考', [q1.id]);
  const stu1 = await addStudent(ctx, '张三');
  const stu2 = await addStudent(ctx, '李四');
  const shot = await uploadShot(ctx, 'same-page');

  // 两份同图答卷，用批量接口并行批改
  const sub1 = await submitWhole(ctx, paper.id, stu1.id, [shot]);
  const sub2 = await submitWhole(ctx, paper.id, stu2.id, [shot]);
  const jobId = ok(await ctx.api.post('/api/papers/' + paper.id + '/grade-batch', {})).job.id;

  const deadline = Date.now() + 10000;
  for (;;) {
    const job = ok(await ctx.api.get('/api/batch/' + jobId)).job;
    if (job.finished) break;
    if (Date.now() > deadline) throw new Error('批量任务没跑完');
    await new Promise((r) => setTimeout(r, 40));
  }

  assert.strictEqual(callCount, 1, '并行下同图只调一次 AI（第二份复用）');
  assert.strictEqual(gradeSheetOf(sub1.id).whole_ai_score, gradeSheetOf(sub2.id).whole_ai_score, '两份分数一致');
  assert.strictEqual(gradeSheetOf(sub1.id).whole_ai_score, 140, '150 − 10 扣分');
});

test('图片评判·逐题答卷没有这个区块，整卷改回逐题后错题清单也被清掉', async (t) => {
  const ctx = await startApp();
  t.after(() => ctx.close());
  const q1 = await addQuestion(ctx, textQuestion());
  const { paper, questions } = await addPaper(ctx, '月考', [q1.id]);
  const stu = await addStudent(ctx, '张三');
  const sub = await submitWhole(ctx, paper.id, stu.id, [await uploadShot(ctx, 'wipe-page')]);
  ok(await ctx.api.post('/api/submissions/' + sub.id + '/grade', {}));
  const sheet = gradeSheetOf(sub.id);
  assert.strictEqual(JSON.parse(sheet.whole_wrong).length, 2);

  // 换成逐题作答：整卷的错题清单属于另一种形态，必须一起作废
  ok(await ctx.api.post('/api/papers/' + paper.id + '/submissions', {
    studentId: stu.id, source: 'manual', status: 'submitted',
    answers: [{ paperQuestionId: questions[0].paperQuestionId, text: '改成逐题交', images: [] }],
  }));
  assert.strictEqual(gradeSheetOf(sub.id).whole_wrong, '[]', '作废时错题清单一并清掉');
  assert.strictEqual(ok(await ctx.api.get('/api/papers/' + paper.id + '/queue/1')).detail.whole, null);

  // 逐题答卷的批改页不该出现「图片评判」区块
  ok(await ctx.api.post('/api/submissions/' + sub.id + '/grade', {}));
  assert.strictEqual(gradeSheetOf(sub.id).whole_wrong, '[]', '逐题批改也要清掉整卷的残留');
  const { registry, root } = loadFrontend(ctx.base, ['pages/grading.js']);
  await registry.grading.render(root, { paper: String(paper.id), filter: 'to_confirm', seq: 1 });
  assert.ok(!root.innerHTML.includes('图片评判'), '逐题答卷没有这个区块');
  assert.strictEqual(root.querySelectorAll('[data-wrong-del]').length, 0);
  assert.ok(root.querySelectorAll('[data-qi]').length > 0, '逐题答卷照旧是题号页签');
});

/* -------------------- 8 · 不用出题：无题卷（图片答卷专用） -------------------- */

test('无题卷·提交即建卷，整卷批改照旧给总分 + 错题清单，统计按整卷满分算', async (t) => {
  const ctx = await startApp();
  t.after(() => ctx.close());
  const stu = await addStudent(ctx, '张三');

  // 老师什么都没建：填个卷名、交一组照片
  const made = ok(await ctx.api.post('/api/whole-submissions', {
    studentId: stu.id,
    paperName: '随堂测',
    wholeFullMarks: 100,
    images: [await uploadShot(ctx, 'noq-1'), await uploadShot(ctx, 'noq-2')],
  }));
  assert.strictEqual(made.fullMarks, 100);
  assert.strictEqual(made.passLine, 60);
  assert.strictEqual(countRows('SELECT COUNT(*) AS c FROM paper_questions'), 0, '这份卷子一道题都没有');

  const graded = ok(await ctx.api.post('/api/submissions/' + made.submission.id + '/grade', {}));
  assert.strictEqual(graded.detail.kind, 'whole');
  assert.strictEqual(graded.detail.questions.length, 0, '没有题目就是没有题目');
  assert.strictEqual(graded.detail.fullMarks, 100, '满分来自卷上设的整卷满分，不是 0');
  assert.strictEqual(graded.detail.passLine, 60);
  assert.strictEqual(graded.detail.whole.aiScore, 75, 'mock 按整卷满分的 75% 给');
  assert.strictEqual(graded.detail.whole.wrong.length, 2, '没有题目也照样要报错题清单');
  assert.strictEqual(countRows('SELECT COUNT(*) AS c FROM grade_items'), 0, '不产生逐题明细');

  // 老师改分 → 确认 → 统计按这份卷子的整卷满分算
  ok(await ctx.api.put('/api/grade-sheets/' + graded.gradeSheetId + '/whole', { finalScore: 80 }));
  ok(await ctx.api.post('/api/grade-sheets/' + graded.gradeSheetId + '/confirm', {}));
  const stats = paperStats(made.paper.id);
  assert.strictEqual(stats.fullMarks, 100);
  assert.strictEqual(stats.passLine, 60);
  assert.strictEqual(stats.overview.count, 1);
  assert.strictEqual(stats.overview.average, 80);
  assert.strictEqual(stats.overview.passRate, 1);
  assert.strictEqual(stats.students[0].whole, true);
});

test('无题卷·整卷满分没填就按 100，填了不合法当场拦下', async (t) => {
  const ctx = await startApp();
  t.after(() => ctx.close());
  const stu = await addStudent(ctx, '张三');

  const made = ok(await ctx.api.post('/api/whole-submissions', {
    studentId: stu.id, paperName: '没填满分的卷', images: [await uploadShot(ctx, 'def-1')],
  }));
  assert.strictEqual(made.fullMarks, 100, '没填就按 100');
  assert.strictEqual(made.passLine, 60);

  for (const bad of [-5, 0, '这不是数字']) {
    const res = await ctx.api.post('/api/whole-submissions', {
      studentId: stu.id, paperName: '没填满分的卷', wholeFullMarks: bad,
      images: [await uploadShot(ctx, 'bad-' + Math.random())],
    });
    assert.strictEqual(res.status, 400, '满分不合法要拦下：' + bad);
    has(String(res.data.error), '大于 0');
  }

  // 卷上原来的满分没被这几个坏请求改动
  assert.strictEqual(ok(await ctx.api.get('/api/papers/' + made.paper.id)).total, 100);
});

test('有题目的卷子·整卷总分也生效：提交图片答卷时填的总分会更新它', async (t) => {
  const ctx = await startApp();
  t.after(() => ctx.close());
  const stu = await addStudent(ctx, '张三');

  // 老师先建了一份卷、设了整卷满分，后来给它挑了题
  const paper = ok(await ctx.api.post('/api/papers', { name: '挑了题的卷', wholeFullMarks: 150 })).paper;
  assert.strictEqual(paper.wholeFullMarks, 150);
  const q1 = await addQuestion(ctx, textQuestion(10));
  ok(await ctx.api.put('/api/papers/' + paper.id + '/questions', { questions: [{ questionId: q1.id }] }));
  ok(await ctx.api.post('/api/papers/' + paper.id + '/publish', {}));

  // 提交同名图片答卷时填一个 100：整卷总分就是 100，会更新到卷子上
  const made = ok(await ctx.api.post('/api/whole-submissions', {
    studentId: stu.id, paperName: '挑了题的卷', wholeFullMarks: 100,
    images: [await uploadShot(ctx, 'with-q-1')],
  }));
  assert.strictEqual(made.paper.id, paper.id, '同名卷子要复用，不该新建');
  assert.strictEqual(made.fullMarks, 100, '整卷总分就是老师填的那个，有无题目都认');
  assert.strictEqual(made.passLine, 60);
  assert.strictEqual(
    ok(await ctx.api.get('/api/papers/' + paper.id)).paper.wholeFullMarks, 100,
    '卷上的整卷总分被更新成 100'
  );
  assert.strictEqual(countRows('SELECT COUNT(*) AS c FROM papers'), 1);
});

test('无题卷·既没有照片也没有题目时，批改要明说「还没有题目」', async (t) => {
  const ctx = await startApp();
  t.after(() => ctx.close());
  const stu = await addStudent(ctx, '张三');
  const made = ok(await ctx.api.post('/api/whole-submissions', {
    studentId: stu.id, paperName: '只收图片的卷', images: [await uploadShot(ctx, 'edge-1')],
  }));

  // 把这组照片换成一份空白的逐题作答（这份卷子本来就没有题目，能填的只有空）
  ok(await ctx.api.put('/api/submissions/' + made.submission.id, { answers: [] }));

  const res = await ctx.api.post('/api/submissions/' + made.submission.id + '/grade', {});
  assert.strictEqual(res.status, 400);
  has(String(res.data.error), '还没有题目');
});

test('批改页·无题卷的整卷答卷照样渲染得出来（没有题目也不崩）', async (t) => {
  const ctx = await startApp();
  t.after(() => ctx.close());
  const stu = await addStudent(ctx, '张三');
  const made = ok(await ctx.api.post('/api/whole-submissions', {
    studentId: stu.id, paperName: '随堂测', wholeFullMarks: 100,
    images: [await uploadShot(ctx, 'ui-noq-1'), await uploadShot(ctx, 'ui-noq-2')],
  }));
  ok(await ctx.api.post('/api/submissions/' + made.submission.id + '/grade', {}));

  const { registry, root } = loadFrontend(ctx.base, ['pages/grading.js']);
  await registry.grading.render(root, { paper: String(made.paper.id), filter: 'to_confirm', seq: 1 });

  const html = root.innerHTML;
  has(html, '图片答卷 · 整卷给分');
  has(html, '整卷总分');
  has(html, 'AI 指出的错题');
  assert.ok(html.includes('data-whole-score'), '那一个可改的总分要在');
  assert.strictEqual(root.querySelectorAll('[data-qi]').length, 0, '没有题目，自然没有题号页签');
  assert.strictEqual(
    (html.match(/class="answer-img"/g) || []).length, 2, '两张照片都要显示出来'
  );
});

/* ------------------------- 9 · 老数据文件的迁移安全 ------------------------- */

test('迁移·升级前的老数据文件打开后自动补上整卷相关的列，老答卷一条不少', async (t) => {
  const dir = tempDir('pgmig-');
  const dbFile = path.join(dir, 'paper.db');

  // 第一趟：攒一份完整的逐题数据（题 → 卷 → 答卷 → 批改 → 确认）
  const before = await startApp({ dir, dbFile });
  const q1 = await addQuestion(before, textQuestion());   // 10 分
  const { paper, questions } = await addPaper(before, '老数据月考', [q1.id]);
  const stu = await addStudent(before, '张三');
  const sub = await submitText(before, paper.id, stu.id, questions[0].paperQuestionId);
  ok(await before.api.post('/api/submissions/' + sub.id + '/grade', {}));
  const oldSheetId = gradeSheetOf(sub.id).id;
  ok(await before.api.post('/api/grade-sheets/' + oldSheetId + '/confirm', {}));
  const oldTotal = gradeSheetOf(sub.id).final_total;
  await before.close();

  // 把整卷相关的列删掉，模拟老师手上那个「还没升级」的数据文件
  const raw = new DatabaseSync(dbFile);
  raw.exec(`
    ALTER TABLE submissions DROP COLUMN images;
    ALTER TABLE grade_sheets DROP COLUMN whole_mode;
    ALTER TABLE grade_sheets DROP COLUMN whole_ai_score;
    ALTER TABLE grade_sheets DROP COLUMN whole_reason;
    ALTER TABLE grade_sheets DROP COLUMN whole_confidence;
    ALTER TABLE grade_sheets DROP COLUMN whole_doubt;
    ALTER TABLE grade_sheets DROP COLUMN whole_final_score;
    ALTER TABLE grade_sheets DROP COLUMN whole_wrong;
    ALTER TABLE grade_items DROP COLUMN mode;
    ALTER TABLE papers DROP COLUMN whole_full_marks;
  `);
  raw.close();

  // 第二趟：直接打开老文件，迁移要自己把列补回来
  const again = await startApp({ dir, dbFile });
  t.after(() => again.close());

  const cols = (table) => getDb().prepare('PRAGMA table_info(' + table + ')').all().map((r) => r.name);
  ['images'].forEach((c) => assert.ok(cols('submissions').includes(c), 'submissions 要有 ' + c));
  ['whole_mode', 'whole_ai_score', 'whole_reason', 'whole_confidence', 'whole_doubt',
    'whole_final_score', 'whole_wrong']
    .forEach((c) => assert.ok(cols('grade_sheets').includes(c), 'grade_sheets 要有 ' + c));
  assert.ok(cols('grade_items').includes('mode'), 'grade_items 要有 mode');
  assert.ok(cols('papers').includes('whole_full_marks'), 'papers 要有 whole_full_marks（无题卷的整卷满分）');

  // 老答卷与新列相处无事：还是逐题形态、分数一分不差
  const detail = ok(await again.api.get('/api/papers/' + paper.id + '/queue/1'));
  assert.strictEqual(detail.detail.kind, 'perQuestion');
  assert.strictEqual(detail.detail.gradeSheet.finalTotal, oldTotal);
  assert.strictEqual(detail.detail.questions[0].items[0].mode, 'rubric', '老明细按 rubric 兜底');
  assert.strictEqual(paperStats(paper.id).overview.count, 1);

  // 迁移后的库上，图片答案这条路要能用
  const stu2 = await addStudent(again, '李四');
  const sub2 = await submitWhole(again, paper.id, stu2.id, [await uploadShot(again, 'after-migrate')]);
  ok(await again.api.post('/api/submissions/' + sub2.id + '/grade', {}));
  const sheet2 = gradeSheetOf(sub2.id);
  assert.strictEqual(sheet2.whole_mode, 'auto');
  ok(await again.api.put('/api/grade-sheets/' + sheet2.id + '/whole', { finalScore: 8 }));
  ok(await again.api.post('/api/grade-sheets/' + sheet2.id + '/confirm', {}));
  assert.strictEqual(gradeSheetOf(sub2.id).final_total, 8);
  assert.strictEqual(cardCounts().toGrade, 0, '两份都批完确认了');
  assert.strictEqual(paperStats(paper.id).overview.count, 2);
  assert.strictEqual(paperStats(paper.id).students[0].whole, true, '8 分那位是整卷给的');

  // 迁移后的库上，「不用出题、直接交图片」这条路也要能用
  const stu3 = await addStudent(again, '王五');
  const noQ = ok(await again.api.post('/api/whole-submissions', {
    studentId: stu3.id,
    paperName: '迁移后的无题卷',
    wholeFullMarks: 100,
    images: [await uploadShot(again, 'after-migrate-noq')],
  }));
  assert.strictEqual(noQ.fullMarks, 100, '老库上新建的无题卷也要有整卷满分');
  const graded3 = ok(await again.api.post('/api/submissions/' + noQ.submission.id + '/grade', {}));
  assert.strictEqual(graded3.detail.kind, 'whole');
  assert.strictEqual(graded3.detail.whole.aiScore, 75);
});
