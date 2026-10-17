'use strict';

/**
 * 三条需求的回归测试：
 *
 * 1. 一次能上传多张图片 —— 老师代录单题贴图支持多选，多张都要留下；
 *    整卷方向上的「一张一张传会丢上下文」由识别接口那一层守着（前端已不拆题）；
 * 2. 删除一条记录时关联内容一并删除 —— 评分标准 / 试卷 / 学生 / 答卷四条链都要清干净，
 *    同时不能误伤不相关的数据；
 * 3. 上传的图片不用评分标准，自主根据图片内容评判 —— 图片作答走 'auto'，
 *    判分提示词里不出现评分标准条目，分数不超满分；纯文字作答仍走 'rubric'。
 */

const test = require('node:test');
const assert = require('node:assert');

const { getDb } = require('../server/db');
const { mockChat } = require('../server/ai/qwen');
const { splitBlocks } = require('../server/lib/zipread');
const { startApp, ok } = require('./helpers');
const { loadFrontend, has } = require('./dom');

/* ---------------------------------- 公共部分 ---------------------------------- */

/** 分项得分点题：4 + 2 = 6 分 */
const ITEM_QUESTION = {
  stem: '一物体从 45 m 高处自由下落，求落地时间。',
  refAnswer: 't = √(2h/g) = 3 s',
  rubricType: 'items',
  items: [
    { text: '正确选取研究对象并写出位移公式', points: 4 },
    { text: '结果与单位规范', points: 2 },
  ],
  subject: '物理',
};

/** 一段文字说明题：4 分 */
const TEXT_QUESTION = {
  stem: '简述牛顿第一定律。',
  refAnswer: '一切物体在没有受到外力作用时，总保持静止或匀速直线运动状态。',
  rubricType: 'text',
  rubricText: '答出「保持静止或匀速直线运动」得 3 分，答出「惯性」再得 1 分。',
  points: 4,
};

async function addQuestion(ctx, body) {
  return ok(await ctx.api.post('/api/questions', body)).question;
}

/** 建一份试卷，题目按传入的 id 顺序排好并发布 */
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

async function submit(ctx, paperId, studentId, answers) {
  return ok(await ctx.api.post('/api/papers/' + paperId + '/submissions', {
    studentId, source: 'manual', status: 'submitted', answers,
  })).submission;
}

function countRows(sql, ...params) {
  return getDb().prepare(sql).get(...params).c;
}

/** 固定回包的假 AI，同时把每次送出去的提示词记下来，便于断言「提示词里有没有评分标准」 */
function captureChat(reply) {
  const seen = [];
  const fn = async (messages) => {
    seen.push(typeof messages === 'string' ? messages : JSON.stringify(messages));
    return typeof reply === 'function' ? reply(messages) : reply;
  };
  fn.seen = seen;
  return fn;
}

const AUTO_REPLY = JSON.stringify({
  items: [{ index: 0, score: 99, reason: '方程列得对，得数也对，单位齐全', confidence: 0.9 }],
  comment: '整体很好',
});

function fakeShot(name, marker) {
  return { name, type: 'image/jpeg', __dataUrl: 'data:image/jpeg;base64,' + marker };
}

function tabHost(root) {
  return root.querySelector('[data-tab-host]');
}

/* ------------------------- 1 · 题号后面标「来自第几张照片」 ------------------------- */

test('整卷拍照·识别结果能标出每题来自第几张照片，正文里的「图2」不会被误吃', () => {
  const blocks = splitBlocks([
    '第1题（图1） 由 h=½gt² 得 t=3s',
    '第2题（图 2）：受力分析如图所示',
    '3. 图2所示的受力分解',
    '第4题 单位漏写',
    '第5题【图3】答：惯性',
  ].join('\n'));

  assert.strictEqual(blocks.length, 5);
  assert.deepStrictEqual(
    blocks.map((b) => [b.label, b.image]),
    [['1', 1], ['2', 2], ['3', null], ['4', null], ['5', 3]]
  );
  assert.strictEqual(blocks[0].text, '由 h=½gt² 得 t=3s', '标记要去掉，只留作答内容');
  assert.strictEqual(blocks[1].text, '受力分析如图所示', '标记后的冒号也要去掉');
  assert.strictEqual(blocks[2].text, '图2所示的受力分解', '正文里的「图2」是内容，不是标记');
  assert.strictEqual(blocks[3].text, '单位漏写');
  assert.strictEqual(blocks[4].text, '答：惯性');
});

test('整卷拍照·识别接口回报每块内容来自哪张照片，越界编号当作没标', async (t) => {
  const ctx = await startApp();
  t.after(() => ctx.close());

  const three = ok(await ctx.api.post('/api/import/parse', {
    kind: 'image',
    images: ['data:image/jpeg;base64,AAAA', 'data:image/jpeg;base64,BBBB', 'data:image/jpeg;base64,CCCC'],
  }));
  assert.strictEqual(three.imageCount, 3);
  assert.deepStrictEqual(three.blocks.map((b) => b.image), [1, 2]);

  // 单张照片：mock 会把两块都标成第 1 张，要照收
  const one = ok(await ctx.api.post('/api/import/parse', {
    kind: 'image', images: ['data:image/jpeg;base64,AAAA'],
  }));
  assert.strictEqual(one.imageCount, 1);
  assert.deepStrictEqual(one.blocks.map((b) => b.image), [1, 1]);

  // AI 数错照片时不能把不存在的编号透出去
  const bogus = await startApp({
    aiChat: async () => '第1题（图9） 乱标的\n第2题（图1） 正常的',
  });
  t.after(() => bogus.close());
  const parsed = ok(await bogus.api.post('/api/import/parse', {
    kind: 'image', images: ['data:image/jpeg;base64,AAAA', 'data:image/jpeg;base64,BBBB'],
  }));
  assert.deepStrictEqual(parsed.blocks.map((b) => b.image), [null, 1]);
});

/* --------------------------- 2 · 一次能上传多张图片 --------------------------- */

test('老师代录·一题贴多张图：两张都上传，入库后两张都留着', async (t) => {
  const ctx = await startApp();
  t.after(() => ctx.close());
  const q1 = await addQuestion(ctx, ITEM_QUESTION);
  const { paper, questions } = await addPaper(ctx, '第一次月考', [q1.id]);
  const stu = await addStudent(ctx, '张三');

  const { registry, root, captured } = loadFrontend(ctx.base, ['pages/submissions.js']);
  await registry.submissions.render(root, { paper: String(paper.id), tab: 'manual' });

  const imgInput = tabHost(root).querySelector('[data-img="0"]');
  imgInput.files = [fakeShot('a.jpg', 'SHOT-A'), fakeShot('b.jpg', 'SHOT-B')];
  await imgInput.fire('change');

  const uploads = captured.requests.filter((r) => r.url.endsWith('/api/uploads'));
  assert.strictEqual(uploads.length, 2, '两张图都要真的传上去');
  const thumbs = tabHost(root).querySelector('[data-imgs="0"]').innerHTML;
  assert.strictEqual((thumbs.match(/<img /g) || []).length, 2, '两张缩略图都要回显');

  // 存盘后两张图都要挂在作答上，不能只剩最后一张
  tabHost(root).querySelector('[data-f="student"]').value = String(stu.id);
  await tabHost(root).querySelector('[data-act="save"]').click();

  const list = ok(await ctx.api.get('/api/papers/' + paper.id + '/submissions'));
  const subId = list.students.find((s) => s.studentId === stu.id).submissionId;
  const detail = ok(await ctx.api.get('/api/submissions/' + subId));
  assert.strictEqual(detail.answers[0].images.length, 2, '一题的两张照片都要留下');
  assert.strictEqual(questions[0].paperQuestionId, detail.answers[0].paperQuestionId);
});

test('整卷拍照（接口层）·识别出的内容能按「来自第几张」挂到对的题目上', async (t) => {
  const ctx = await startApp();
  t.after(() => ctx.close());
  const q1 = await addQuestion(ctx, ITEM_QUESTION);
  const q2 = await addQuestion(ctx, TEXT_QUESTION);
  const { paper, questions } = await addPaper(ctx, '第一次月考', [q1.id, q2.id]);
  const stu = await addStudent(ctx, '张三');

  // 一组照片一次送进识别接口，每块内容标出「来自第几张」
  const parsed = ok(await ctx.api.post('/api/import/parse', {
    kind: 'image',
    images: [
      'data:image/jpeg;base64,' + Buffer.from('page-1').toString('base64'),
      'data:image/jpeg;base64,' + Buffer.from('page-2').toString('base64'),
    ],
    fileName: 'p1.jpg、p2.jpg',
  }));
  assert.strictEqual(parsed.imageCount, 2);
  assert.deepStrictEqual(parsed.blocks.map((b) => b.image), [1, 2], '两块内容分别来自第 1、2 张');

  // 照片要先落盘，才挂得到作答上
  const shots = [];
  for (const marker of ['page-1', 'page-2']) {
    shots.push(ok(await ctx.api.post('/api/uploads', {
      data: 'data:image/jpeg;base64,' + Buffer.from(marker).toString('base64'),
      ext: 'jpg',
    })).path);
  }

  // 老师核对时发现第 2 块其实也拍在第 1 张照片里 → 入库时两题挂同一张
  const sub = await submit(ctx, paper.id, stu.id, [
    { paperQuestionId: questions[0].paperQuestionId, text: parsed.blocks[0].text, images: [shots[0]] },
    { paperQuestionId: questions[1].paperQuestionId, text: parsed.blocks[1].text, images: [shots[0]] },
  ]);

  const detail = ok(await ctx.api.get('/api/submissions/' + sub.id));
  const bySeq = {};
  detail.answers.forEach((a) => { bySeq[a.seq] = a; });
  assert.strictEqual(bySeq[1].images.length, 1);
  assert.strictEqual(bySeq[1].images[0], shots[0], '第 1 题挂着第 1 张照片');
  assert.strictEqual(bySeq[2].images[0], shots[0], '老师改成同一张后，两题挂的是同一张照片');
  assert.notStrictEqual(bySeq[1].images[0], '', '两题都必须挂着真实照片，不能是空数组');
  assert.notStrictEqual(bySeq[1].images[0], undefined);
});

/* -------------------- 3 · 图片作答：不看评分标准，AI 自主判分 -------------------- */

test('图片作答·判分提示词里没有评分标准，分数不超满分，模式记为 auto', async (t) => {
  const ai = captureChat(AUTO_REPLY);
  const ctx = await startApp({ aiMode: 'mock', aiChat: ai });
  t.after(() => ctx.close());

  const q1 = await addQuestion(ctx, ITEM_QUESTION);
  const { paper, questions } = await addPaper(ctx, '月考', [q1.id]);
  const stu = await addStudent(ctx, '张三');

  // 真的落一张图片到附件目录，验证它会作为图片内容送进 AI
  const up = ok(await ctx.api.post('/api/uploads', {
    data: 'data:image/jpeg;base64,' + Buffer.from('fake-jpeg-bytes').toString('base64'), ext: 'jpg',
  }));
  const sub = await submit(ctx, paper.id, stu.id, [{
    paperQuestionId: questions[0].paperQuestionId, text: '', images: [up.path],
  }]);

  const res = ok(await ctx.api.post('/api/submissions/' + sub.id + '/grade', {}));

  const prompt = ai.seen[0];
  assert.ok(prompt.includes('data:image/jpeg;base64,'), '照片要以图片形式送进 AI');
  assert.ok(prompt.includes('不要去找评分标准条目'), '提示词要明说本题不逐条对照评分标准');
  ['正确选取研究对象并写出位移公式', '结果与单位规范', '【评分标准】'].forEach((k) => {
    assert.ok(!prompt.includes(k), '图片作答的提示词里不该出现评分标准相关内容：' + k);
  });

  const q = res.detail.questions[0];
  assert.strictEqual(q.gradingMode, 'auto');
  assert.strictEqual(q.items.length, 1, '自主评判只出一条整题得分，不再拆成多条');
  assert.strictEqual(q.items[0].mode, 'auto');
  assert.strictEqual(q.items[0].aiScore, 6, 'AI 给了 99 分，要夹回本题满分 6 分');
  assert.strictEqual(q.questionTotal, 6);
  assert.ok(q.questionTotal <= res.detail.fullMarks, '自主评判的得分不能超过满分');

  const row = getDb().prepare('SELECT mode, question_item_id FROM grade_items').get();
  assert.strictEqual(row.mode, 'auto');
  assert.strictEqual(row.question_item_id, null, '自主评判没有对应的评分标准条目');
});

test('纯文字作答·仍然逐条对照评分标准，模式记为 rubric', async (t) => {
  const ai = captureChat(JSON.stringify({
    items: [
      { index: 0, score: 4, reason: '写出了位移公式', confidence: 0.95 },
      { index: 1, score: 2, reason: '结果与单位规范', confidence: 0.95 },
    ],
    comment: '很好',
  }));
  const ctx = await startApp({ aiMode: 'mock', aiChat: ai });
  t.after(() => ctx.close());

  const q1 = await addQuestion(ctx, ITEM_QUESTION);
  const { paper, questions } = await addPaper(ctx, '月考', [q1.id]);
  const stu = await addStudent(ctx, '张三');
  const sub = await submit(ctx, paper.id, stu.id, [{
    paperQuestionId: questions[0].paperQuestionId, text: '由 h=½gt² 得 t=3 s',
  }]);

  const res = ok(await ctx.api.post('/api/submissions/' + sub.id + '/grade', {}));
  const prompt = ai.seen[0];
  ['【评分标准】', '正确选取研究对象并写出位移公式', '结果与单位规范'].forEach((k) => {
    assert.ok(prompt.includes(k), '文字作答仍要逐条对照评分标准：' + k);
  });
  assert.ok(!prompt.includes('不要去找评分标准条目'), '文字作答不该走自主评判那套提示词');

  const q = res.detail.questions[0];
  assert.strictEqual(q.gradingMode, 'rubric');
  assert.strictEqual(q.items.length, 2);
  assert.deepStrictEqual(q.items.map((i) => i.mode), ['rubric', 'rubric']);
  assert.deepStrictEqual(q.items.map((i) => i.aiScore), [4, 2]);
  assert.strictEqual(
    getDb().prepare('SELECT COUNT(*) AS c FROM grade_items WHERE mode = ?').get('auto').c, 0
  );
});

test('批改页·把「AI 自主评判」的题目标出来，评分标准收进折叠里备查', async (t) => {
  const ctx = await startApp();
  t.after(() => ctx.close());

  const q1 = await addQuestion(ctx, ITEM_QUESTION);
  const q2 = await addQuestion(ctx, TEXT_QUESTION);
  const { paper, questions } = await addPaper(ctx, '月考', [q1.id, q2.id]);
  const stu = await addStudent(ctx, '张三');

  const up = ok(await ctx.api.post('/api/uploads', {
    data: 'data:image/jpeg;base64,' + Buffer.from('fake-jpeg-bytes').toString('base64'), ext: 'jpg',
  }));
  const sub = await submit(ctx, paper.id, stu.id, [
    { paperQuestionId: questions[0].paperQuestionId, text: '', images: [up.path] },
    { paperQuestionId: questions[1].paperQuestionId, text: '物体保持静止或匀速直线运动' },
  ]);
  ok(await ctx.api.post('/api/submissions/' + sub.id + '/grade', {}));

  const { registry, root } = loadFrontend(ctx.base, ['pages/grading.js']);
  await registry.grading.render(root, { paper: String(paper.id), seq: '1', qi: '0' });

  const html = root.innerHTML;
  has(html, 'AI 自主评判');
  has(html, '本题不看评分标准');
  has(html, '展开评分标准备查');
  has(html, '自主');
  assert.ok(html.includes('data-qi="1"'), '两道题的切换按钮都在');

  // 第 2 题是文字作答，还是老样子逐条对照
  await registry.grading.render(root, { paper: String(paper.id), seq: '1', qi: '1' });
  const html2 = root.innerHTML;
  has(html2, '参考答案 · 评分标准');
  has(html2, '答出「保持静止或匀速直线运动」得 3 分');
  assert.ok(!html2.includes('本题不看评分标准'), '文字作答的题不该显示自主评判说明');
});

/* --------------------- 4 · 删除一条记录，关联内容一并删除 --------------------- */

test('删除评分标准·摘掉用题位置、题号重新连号、对应作答与评分一并清掉', async (t) => {
  const ctx = await startApp();
  t.after(() => ctx.close());

  const q1 = await addQuestion(ctx, ITEM_QUESTION);
  const q2 = await addQuestion(ctx, ITEM_QUESTION);
  const q3 = await addQuestion(ctx, TEXT_QUESTION);
  const { paper, questions } = await addPaper(ctx, '月考', [q1.id, q2.id, q3.id]);
  const stu = await addStudent(ctx, '张三');
  const sub = await submit(ctx, paper.id, stu.id, questions.map((q) => ({
    paperQuestionId: q.paperQuestionId, text: '随便写点',
  })));
  ok(await ctx.api.post('/api/submissions/' + sub.id + '/grade', {}));
  assert.strictEqual(countRows('SELECT COUNT(*) AS c FROM grade_items'), 5, '4 + 2 + 4 三条题共 5 条明细');
  assert.strictEqual(countRows('SELECT COUNT(*) AS c FROM answers'), 3);

  const res = ok(await ctx.api.del('/api/questions/' + q2.id));
  assert.strictEqual(res.usedInPapers, 1, '它当时被 1 份试卷用着');
  assert.deepStrictEqual(res.removed, {
    submissions: 0, answers: 1, gradeSheets: 0, gradeItems: 2, paperQuestions: 1, batchJobs: 0, papers: 1,
  });

  const left = getDb().prepare('SELECT seq, question_id FROM paper_questions WHERE paper_id = ? ORDER BY seq').all(paper.id);
  assert.strictEqual(left.length, 2);
  assert.deepStrictEqual(Array.from(left, (r) => r.seq), [1, 2], '抽掉一题后题号要重新连号');
  assert.deepStrictEqual(Array.from(left, (r) => r.question_id), [q1.id, q3.id]);

  assert.strictEqual(countRows('SELECT COUNT(*) AS c FROM questions WHERE id = ?', q2.id), 0);
  assert.strictEqual(countRows('SELECT COUNT(*) AS c FROM question_items WHERE question_id = ?', q2.id), 0);
  assert.strictEqual(countRows('SELECT COUNT(*) AS c FROM answers'), 2, '只剩另外两题的作答');
  assert.strictEqual(countRows('SELECT COUNT(*) AS c FROM grade_items'), 3, '只剩另外两题的 3 条明细');
  // 试卷本身还在，学生的评分单也还在（只是少了一题的明细）
  assert.strictEqual(countRows('SELECT COUNT(*) AS c FROM papers WHERE id = ?', paper.id), 1);
  assert.strictEqual(countRows('SELECT COUNT(*) AS c FROM grade_sheets'), 1);
});

test('删除试卷·答卷、作答、评分、批量任务一起走，别的试卷不受影响', async (t) => {
  const ctx = await startApp();
  t.after(() => ctx.close());

  const q1 = await addQuestion(ctx, ITEM_QUESTION);
  const p1 = await addPaper(ctx, '要删的卷', [q1.id]);
  const p2 = await addPaper(ctx, '留着的卷', [q1.id]);
  const stu = await addStudent(ctx, '张三');

  const s1 = await submit(ctx, p1.paper.id, stu.id, [
    { paperQuestionId: p1.questions[0].paperQuestionId, text: '第一份' },
  ]);
  const s2 = await submit(ctx, p2.paper.id, stu.id, [
    { paperQuestionId: p2.questions[0].paperQuestionId, text: '第二份' },
  ]);
  ok(await ctx.api.post('/api/submissions/' + s1.id + '/grade', {}));
  ok(await ctx.api.post('/api/submissions/' + s2.id + '/grade', {}));
  getDb().prepare(
    "INSERT INTO batch_jobs(paper_id, status, total, created_at, updated_at) VALUES(?, 'done', 1, '2026-01-01', '2026-01-01')"
  ).run(p1.paper.id);

  const res = ok(await ctx.api.del('/api/papers/' + p1.paper.id));
  assert.strictEqual(res.removed.submissions, 1);
  assert.strictEqual(res.removed.answers, 1);
  assert.strictEqual(res.removed.gradeSheets, 1);
  assert.strictEqual(res.removed.gradeItems, 2);
  assert.strictEqual(res.removed.paperQuestions, 1);
  assert.strictEqual(res.removed.batchJobs, 1);
  assert.strictEqual(res.removed.papers, 1);

  assert.strictEqual(countRows('SELECT COUNT(*) AS c FROM papers'), 1);
  assert.strictEqual(countRows('SELECT COUNT(*) AS c FROM submissions'), 1, '只剩另一份试卷的答卷');
  assert.strictEqual(countRows('SELECT COUNT(*) AS c FROM answers'), 1);
  assert.strictEqual(countRows('SELECT COUNT(*) AS c FROM grade_sheets'), 1);
  assert.strictEqual(countRows('SELECT COUNT(*) AS c FROM batch_jobs'), 0);
  // 不许留孤儿：明细所属的用题位置必须还存在
  assert.strictEqual(
    countRows('SELECT COUNT(*) AS c FROM grade_items WHERE paper_question_id NOT IN (SELECT id FROM paper_questions)'), 0
  );
  assert.strictEqual(
    countRows('SELECT COUNT(*) AS c FROM answers WHERE paper_question_id NOT IN (SELECT id FROM paper_questions)'), 0
  );
  // 评分标准本身不该被顺手删掉
  assert.strictEqual(countRows('SELECT COUNT(*) AS c FROM questions'), 1);
});

test('删除学生·只清他自己的答卷与评分，同卷其他学生不受影响', async (t) => {
  const ctx = await startApp();
  t.after(() => ctx.close());

  const q1 = await addQuestion(ctx, ITEM_QUESTION);
  const { paper, questions } = await addPaper(ctx, '月考', [q1.id]);
  const zhang = await addStudent(ctx, '张三');
  const li = await addStudent(ctx, '李四');

  const sz = await submit(ctx, paper.id, zhang.id, [
    { paperQuestionId: questions[0].paperQuestionId, text: '张三的答案' },
  ]);
  const sl = await submit(ctx, paper.id, li.id, [
    { paperQuestionId: questions[0].paperQuestionId, text: '李四的答案' },
  ]);
  ok(await ctx.api.post('/api/submissions/' + sz.id + '/grade', {}));
  ok(await ctx.api.post('/api/submissions/' + sl.id + '/grade', {}));

  const res = ok(await ctx.api.del('/api/students/' + zhang.id));
  assert.strictEqual(res.removed.submissions, 1);
  assert.strictEqual(res.removed.answers, 1);
  assert.strictEqual(res.removed.gradeSheets, 1);
  assert.strictEqual(res.removed.gradeItems, 2);

  assert.strictEqual(countRows('SELECT COUNT(*) AS c FROM students'), 1);
  assert.strictEqual(countRows('SELECT COUNT(*) AS c FROM submissions'), 1);
  assert.strictEqual(countRows('SELECT COUNT(*) AS c FROM grade_sheets'), 1);
  assert.strictEqual(countRows('SELECT COUNT(*) AS c FROM grade_items'), 2);
  const left = getDb().prepare('SELECT text FROM answers').get();
  assert.strictEqual(left.text, '李四的答案');
  // 队列里只剩李四，且成绩还数得出来
  const queue = ok(await ctx.api.get('/api/papers/' + paper.id + '/queue'));
  assert.strictEqual(queue.total, 1);
  assert.strictEqual(queue.items[0].studentName, '李四');
  assert.strictEqual(queue.counts.toConfirm, 1);
});

test('删除答卷·只清这一条，同一学生在别的卷子上的成绩还在', async (t) => {
  const ctx = await startApp();
  t.after(() => ctx.close());

  const q1 = await addQuestion(ctx, ITEM_QUESTION);
  const p1 = await addPaper(ctx, '第一次月考', [q1.id]);
  const p2 = await addPaper(ctx, '第二次月考', [q1.id]);
  const stu = await addStudent(ctx, '张三');

  const s1 = await submit(ctx, p1.paper.id, stu.id, [
    { paperQuestionId: p1.questions[0].paperQuestionId, text: '第一次的答案' },
  ]);
  const s2 = await submit(ctx, p2.paper.id, stu.id, [
    { paperQuestionId: p2.questions[0].paperQuestionId, text: '第二次的答案' },
  ]);
  ok(await ctx.api.post('/api/submissions/' + s1.id + '/grade', {}));
  ok(await ctx.api.post('/api/submissions/' + s2.id + '/grade', {}));

  const res = ok(await ctx.api.del('/api/submissions/' + s1.id));
  assert.strictEqual(res.removed.submissions, 1);
  assert.strictEqual(res.removed.answers, 1);
  assert.strictEqual(res.removed.gradeSheets, 1);
  assert.strictEqual(res.removed.gradeItems, 2);
  assert.strictEqual(res.removed.paperQuestions, 0, '删答卷不该动试卷上的题');

  assert.strictEqual(countRows('SELECT COUNT(*) AS c FROM submissions'), 1);
  assert.strictEqual(countRows('SELECT COUNT(*) AS c FROM answers'), 1);
  assert.strictEqual(countRows('SELECT COUNT(*) AS c FROM paper_questions'), 2);

  const history = ok(await ctx.api.get('/api/students/' + stu.id + '/history'));
  assert.strictEqual(history.history.length, 1);
  assert.strictEqual(history.history[0].paperName, '第二次月考');
});

/* ------------------ 5 · 删除前的二次确认要把代价说清楚 ------------------ */

test('删除确认与提示·把会连带删掉什么说清楚，删完如实回报', async (t) => {
  const ctx = await startApp();
  t.after(() => ctx.close());

  const q1 = await addQuestion(ctx, ITEM_QUESTION);
  const { paper, questions } = await addPaper(ctx, '月考', [q1.id]);
  const stu = await addStudent(ctx, '张三');
  const sub = await submit(ctx, paper.id, stu.id, [
    { paperQuestionId: questions[0].paperQuestionId, text: '张三的答案' },
  ]);
  ok(await ctx.api.post('/api/submissions/' + sub.id + '/grade', {}));

  /* 试卷页：说清会删掉几份答卷，点取消就什么都不动 */
  const p = loadFrontend(ctx.base, ['pages/papers.js']);
  await p.registry.papers.render(p.root, {});
  p.captured.confirmResult = false;
  await p.root.querySelectorAll('[data-act="del"]')[0].click();
  const confirmP = p.captured.confirmCalls[0];
  assert.strictEqual(confirmP.title, '删除试卷');
  has(confirmP.message, '现有 1 份答卷');
  has(confirmP.message, '每题作答、AI 评分与批注全部删除');
  has(confirmP.message, '1 道题编排一并清除');
  assert.strictEqual(
    p.captured.requests.filter((r) => r.method === 'DELETE').length, 0, '点了取消就不该发删除请求'
  );
  assert.strictEqual(countRows('SELECT COUNT(*) AS c FROM papers'), 1);

  /* 学生页：说清会删掉他几条答卷记录 */
  const s = loadFrontend(ctx.base, ['pages/students.js']);
  await s.registry.students.render(s.root, {});
  await s.root.querySelectorAll('[data-act="del"]')[0].click();
  const confirmS = s.captured.confirmCalls[0];
  assert.strictEqual(confirmS.title, '删除学生');
  has(confirmS.message, '有 1 条答卷记录');
  has(confirmS.message, '已经确认过的成绩也会随之消失');
  assert.strictEqual(countRows('SELECT COUNT(*) AS c FROM students'), 1);

  /* 评分标准页：确认后真的连带清掉，并把删了什么回报出来 */
  const q = loadFrontend(ctx.base, ['pages/questions.js']);
  await q.registry.questions.render(q.root, {});
  q.captured.confirmResult = true;
  await q.root.querySelectorAll('[data-act="del"]')[0].click();

  const confirmQ = q.captured.confirmCalls[0];
  assert.strictEqual(confirmQ.title, '删除评分标准');
  has(confirmQ.message, '正用在 1 份试卷上');
  has(confirmQ.message, '会被从这些试卷里摘掉');
  has(confirmQ.message, '作答和 AI 评分会一并删除');
  has(confirmQ.message, '不可撤销');
  const toastQ = q.captured.toasts.find((x) => x.kind === 'ok');
  has(toastQ.text, '已删除');
  has(toastQ.text, '条作答');
  assert.strictEqual(countRows('SELECT COUNT(*) AS c FROM questions'), 0, '确认后真的要删掉');
});

test('批改页·也能直接删除当前试卷，确认后连答卷评分一起清掉并跳回列表', async (t) => {
  const ctx = await startApp();
  t.after(() => ctx.close());

  const q1 = await addQuestion(ctx, ITEM_QUESTION);
  const { paper, questions } = await addPaper(ctx, '要删的卷', [q1.id]);
  const stu = await addStudent(ctx, '张三');
  const sub = await submit(ctx, paper.id, stu.id, [
    { paperQuestionId: questions[0].paperQuestionId, text: '张三的答案' },
  ]);
  ok(await ctx.api.post('/api/submissions/' + sub.id + '/grade', {}));

  const { registry, root, captured } = loadFrontend(ctx.base, ['pages/grading.js']);
  await registry.grading.render(root, { paper: String(paper.id) });

  // 批改页上有「删除试卷」这个入口
  has(root.innerHTML, '删除试卷');

  // 点删除 → 先说明代价；取消就什么都不动
  captured.confirmResult = false;
  await root.querySelector('[data-act="del"]').click();
  const confirm = captured.confirmCalls[0];
  assert.strictEqual(confirm.title, '删除试卷');
  has(confirm.message, '现有 1 份答卷');
  has(confirm.message, 'AI 评分与批注全部删除');
  has(confirm.message, '1 道题编排一并清除');
  assert.strictEqual(captured.requests.filter((r) => r.method === 'DELETE').length, 0, '点了取消就不该发删除请求');
  assert.strictEqual(countRows('SELECT COUNT(*) AS c FROM papers'), 1);

  // 这次确认删除 → 级联清掉，并跳回批改列表
  captured.confirmResult = true;
  await root.querySelector('[data-act="del"]').click();
  const del = captured.requests.find((r) => r.method === 'DELETE' && /\/api\/papers\/\d+$/.test(r.url));
  assert.ok(del, '确认后要打删除试卷的接口');
  assert.ok(captured.navigated.some((n) => n.id === 'grading'), '删完要跳回批改列表');
  assert.strictEqual(countRows('SELECT COUNT(*) AS c FROM papers'), 0, '试卷删掉了');
  assert.strictEqual(countRows('SELECT COUNT(*) AS c FROM submissions'), 0, '答卷跟着删掉了');
  assert.strictEqual(countRows('SELECT COUNT(*) AS c FROM grade_sheets'), 0, '评分单也一起清掉');
});
