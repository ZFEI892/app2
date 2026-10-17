'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const { getDb, nowIso } = require('../server/db');
const { splitBlocks } = require('../server/routes/submissions');
const { buildDocx } = require('../server/lib/zip');
const { splitBlocks: sbFromZip } = require('../server/lib/zipread');
const { startApp, ok } = require('./helpers');

const PNG_1PX = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';

async function seedPaper(ctx) {
  const q1 = ok(await ctx.api.post('/api/questions', {
    stem: '第一题：求落地时间', refAnswer: '3 s', rubricType: 'text', rubricText: '公式对得 6 分', points: 6,
  })).question;
  const q2 = ok(await ctx.api.post('/api/questions', {
    stem: '第二题：受力分析', refAnswer: '如图所示', rubricType: 'text', rubricText: '受力图完整得 4 分', points: 4,
  })).question;
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

function seedStudentDirect(name) {
  const info = getDb().prepare('INSERT INTO students(name, created_at) VALUES(?,?)').run(name, nowIso());
  return Number(info.lastInsertRowid);
}

test('M4 · 题号切分：支持「1.」「第 2 题」等写法', () => {
  const blocks = splitBlocks('第1题 由 h=½gt² 得 t=3s\n第二行补充\n2. 受力分析如图所示\n第 3 题：单位漏写');
  assert.strictEqual(blocks.length, 3);
  assert.strictEqual(blocks[0].label, '1');
  assert.ok(blocks[0].text.includes('第二行补充'), '未带题号的续行应并入上一块');
  assert.strictEqual(blocks[1].label, '2');
  assert.strictEqual(blocks[2].label, '3');

  const single = splitBlocks('没有任何题号的整段文字');
  assert.strictEqual(single.length, 1);
  assert.strictEqual(single[0].label, '');
});

test('M4 · 三种来源各录一份，答案正确归属学生与题目', async (t) => {
  const ctx = await startApp();
  t.after(() => ctx.close());
  const { paper, questions } = await seedPaper(ctx);

  const s1 = await seedStudent(ctx, '张三');
  const s2 = await seedStudent(ctx, '李四');
  const s3 = await seedStudent(ctx, '王五');

  ok(await ctx.api.post('/api/papers/' + paper.id + '/submissions', {
    studentId: s1.id, source: 'manual', answers: [
      { paperQuestionId: questions[0].paperQuestionId, text: '手动录入的答案' },
      { paperQuestionId: questions[1].paperQuestionId, text: '第二题答案' },
    ],
  }));

  ok(await ctx.api.post('/api/papers/' + paper.id + '/submissions', {
    studentId: s2.id, source: 'self', answers: [
      { paperQuestionId: questions[0].paperQuestionId, text: '学生自填的答案' },
    ],
  }));

  ok(await ctx.api.post('/api/papers/' + paper.id + '/submissions', {
    studentId: s3.id, source: 'import', answers: [
      { seq: 1, text: '导入的第 1 题答案' },
      { seq: 2, text: '导入的第 2 题答案' },
    ],
  }));

  const list = ok(await ctx.api.get('/api/papers/' + paper.id + '/submissions'));
  assert.strictEqual(list.submitted, 3);
  assert.strictEqual(list.students.length, 3);

  const zhang = list.students.find((s) => s.name === '张三');
  assert.strictEqual(zhang.answerCount, 2);
  assert.strictEqual(zhang.source, 'manual');

  const detail = ok(await ctx.api.get('/api/submissions/' + zhang.submissionId));
  assert.strictEqual(detail.answers.length, 2);
  assert.strictEqual(detail.answers[0].text, '手动录入的答案');
  assert.strictEqual(detail.answers[0].seq, 1);
  assert.strictEqual(detail.answers[1].text, '第二题答案');
  assert.strictEqual(detail.answers[0].hasText, true);
  assert.strictEqual(detail.answers[0].points, 6);

  const wang = list.students.find((s) => s.name === '王五');
  const wangDetail = ok(await ctx.api.get('/api/submissions/' + wang.submissionId));
  assert.strictEqual(wangDetail.answers[0].text, '导入的第 1 题答案', '按 seq 归属也应正确');
  assert.strictEqual(wangDetail.answers[1].text, '导入的第 2 题答案');
});

test('M4 · 草稿试卷不能收答案；首份答案后进入「收卷中」', async (t) => {
  const ctx = await startApp();
  t.after(() => ctx.close());
  const q1 = ok(await ctx.api.post('/api/questions', {
    stem: '题', rubricType: 'text', rubricText: '说明', points: 5,
  })).question;
  const paper = ok(await ctx.api.post('/api/papers', { name: '草稿卷' })).paper;
  ok(await ctx.api.put('/api/papers/' + paper.id + '/questions', { questions: [{ questionId: q1.id }] }));
  const stu = await seedStudent(ctx, '张三');

  const blocked = await ctx.api.post('/api/papers/' + paper.id + '/submissions', {
    studentId: stu.id, answers: [],
  });
  assert.strictEqual(blocked.status, 409);

  ok(await ctx.api.post('/api/papers/' + paper.id + '/publish', {}));
  ok(await ctx.api.post('/api/papers/' + paper.id + '/submissions', { studentId: stu.id, answers: [] }));

  const detail = ok(await ctx.api.get('/api/papers/' + paper.id));
  assert.strictEqual(detail.paper.status, 'collecting');
});

test('M4 · 同一学生重复提交：覆盖而不是新增', async (t) => {
  const ctx = await startApp();
  t.after(() => ctx.close());
  const { paper, questions } = await seedPaper(ctx);
  const stu = await seedStudent(ctx, '张三');

  const first = ok(await ctx.api.post('/api/papers/' + paper.id + '/submissions', {
    studentId: stu.id, answers: [{ paperQuestionId: questions[0].paperQuestionId, text: '第一版' }],
  })).submission;
  const second = ok(await ctx.api.post('/api/papers/' + paper.id + '/submissions', {
    studentId: stu.id, answers: [{ paperQuestionId: questions[0].paperQuestionId, text: '第二版' }],
  })).submission;

  assert.strictEqual(first.id, second.id, '应复用同一条答卷记录');

  const list = ok(await ctx.api.get('/api/papers/' + paper.id + '/submissions'));
  assert.strictEqual(list.submitted, 1, '同一学生只应有一份答卷');
  const detail = ok(await ctx.api.get('/api/submissions/' + first.id));
  assert.strictEqual(detail.answers[0].text, '第二版');
});

test('M4 · 校验：题目不属于本卷 / 学生不存在 都应 400', async (t) => {
  const ctx = await startApp();
  t.after(() => ctx.close());
  const { paper, questions } = await seedPaper(ctx);
  const stu = await seedStudent(ctx, '张三');

  const badQuestion = await ctx.api.post('/api/papers/' + paper.id + '/submissions', {
    studentId: stu.id, answers: [{ paperQuestionId: 99999, text: 'x' }],
  });
  assert.strictEqual(badQuestion.status, 400);

  const badStudent = await ctx.api.post('/api/papers/' + paper.id + '/submissions', {
    studentId: 99999, answers: [],
  });
  assert.strictEqual(badStudent.status, 400);
  void questions;
});

test('M4 · 缺考标记与答案修改', async (t) => {
  const ctx = await startApp();
  t.after(() => ctx.close());
  const { paper, questions } = await seedPaper(ctx);
  const s1 = await seedStudent(ctx, '张三');
  const s2 = await seedStudent(ctx, '李四');

  const sub = ok(await ctx.api.post('/api/papers/' + paper.id + '/submissions', {
    studentId: s1.id, answers: [{ paperQuestionId: questions[0].paperQuestionId, text: '原始答案' }],
  })).submission;

  ok(await ctx.api.post('/api/papers/' + paper.id + '/submissions', {
    studentId: s2.id, status: 'absent', answers: [],
  }));

  const list = ok(await ctx.api.get('/api/papers/' + paper.id + '/submissions'));
  assert.strictEqual(list.absent, 1);
  assert.strictEqual(list.students.find((s) => s.name === '李四').status, 'absent');

  ok(await ctx.api.put('/api/submissions/' + sub.id, {
    answers: [{ paperQuestionId: questions[0].paperQuestionId, text: '改过的答案' }, { seq: 2, text: '补的第 2 题' }],
  }));
  const detail = ok(await ctx.api.get('/api/submissions/' + sub.id));
  assert.strictEqual(detail.answers[0].text, '改过的答案');
  assert.strictEqual(detail.answers[1].text, '补的第 2 题');
});

test('M4 · 删除答卷：级联清理答案与评分单', async (t) => {
  const ctx = await startApp();
  t.after(() => ctx.close());
  const { paper, questions } = await seedPaper(ctx);
  const stu = await seedStudent(ctx, '张三');
  const sub = ok(await ctx.api.post('/api/papers/' + paper.id + '/submissions', {
    studentId: stu.id, answers: [{ paperQuestionId: questions[0].paperQuestionId, text: 'x' }],
  })).submission;

  const sheetId = getDb().prepare('SELECT id FROM grade_sheets WHERE submission_id = ?').get(sub.id).id;
  getDb().prepare('INSERT INTO grade_items(grade_sheet_id, paper_question_id, ai_score) VALUES(?,?,?)')
    .run(sheetId, questions[0].paperQuestionId, 5);

  ok(await ctx.api.del('/api/submissions/' + sub.id));

  assert.strictEqual(getDb().prepare('SELECT COUNT(*) AS c FROM submissions').get().c, 0);
  assert.strictEqual(getDb().prepare('SELECT COUNT(*) AS c FROM answers').get().c, 0);
  assert.strictEqual(getDb().prepare('SELECT COUNT(*) AS c FROM grade_sheets').get().c, 0);
  assert.strictEqual(getDb().prepare('SELECT COUNT(*) AS c FROM grade_items').get().c, 0);
});

test('M4 · 图片上传：落盘到 attachments，可通过 /files/ 访问', async (t) => {
  const ctx = await startApp();
  t.after(() => ctx.close());

  const up = ok(await ctx.api.post('/api/uploads', { data: 'data:image/png;base64,' + PNG_1PX, ext: 'png' }));
  assert.ok(up.path.endsWith('.png'));
  assert.strictEqual(up.url, '/files/' + up.path);
  assert.ok(fs.existsSync(path.join(path.dirname(ctx.dbFile), 'attachments', up.path)));

  const fetched = await fetch(ctx.base + up.url);
  assert.strictEqual(fetched.status, 200);
  assert.strictEqual(fetched.headers.get('content-type'), 'image/png');

  const badExt = await ctx.api.post('/api/uploads', { data: 'data:text/plain;base64,' + PNG_1PX, ext: 'exe' });
  assert.strictEqual(badExt.status, 400, '不支持的格式应被拒绝');

  const empty = await ctx.api.post('/api/uploads', { data: '' });
  assert.strictEqual(empty.status, 400);
});

test('M4 · 导入解析：txt 文本切块并建议学生', async (t) => {
  const ctx = await startApp();
  t.after(() => ctx.close());
  const { paper } = await seedPaper(ctx);
  await seedStudent(ctx, '张三');
  void paper;

  const parsed = ok(await ctx.api.post('/api/import/parse', {
    kind: 'text',
    text: '张三\n第1题 我的答案是 3s\n第2题 受力图见下',
  }));
  assert.strictEqual(parsed.blocks.length, 2);
  assert.strictEqual(parsed.blocks[0].label, '1');
  assert.ok(parsed.suggestedStudentId, '文本里出现学生姓名时应给出建议');
  assert.strictEqual(parsed.needsReview, true);
});

test('M4 · 导入解析：docx 抽文并切块', async (t) => {
  const ctx = await startApp();
  t.after(() => ctx.close());

  const docx = buildDocx(['第1题 由 h=½gt² 得 t=3s', '第2题 受力分析如图所示']);
  const parsed = ok(await ctx.api.post('/api/import/parse', {
    kind: 'docx',
    data: 'data:application/vnd.openxmlformats-officedocument.wordprocessingml.document;base64,' + docx.toString('base64'),
  }));
  assert.strictEqual(parsed.blocks.length, 2);
  assert.ok(parsed.blocks[0].text.includes('t=3s'));
  assert.strictEqual(parsed.blocks[1].label, '2');
});

test('M4 · 导入解析：图片走 AI 识别（模拟模式）', async (t) => {
  const ctx = await startApp({ aiMode: 'mock' });
  t.after(() => ctx.close());

  const parsed = ok(await ctx.api.post('/api/import/parse', {
    kind: 'image',
    images: ['data:image/png;base64,' + PNG_1PX],
  }));
  assert.ok(parsed.blocks.length >= 1, '应识别出至少一块内容');
  assert.strictEqual(parsed.kind, 'image');
  assert.strictEqual(parsed.needsReview, true);
});

test('M4 · 导入解析：docx 内容为空时给出 400', async (t) => {
  const ctx = await startApp();
  t.after(() => ctx.close());
  const emptyDocx = buildDocx(['   ']);
  const res = await ctx.api.post('/api/import/parse', {
    kind: 'docx',
    data: emptyDocx.toString('base64'),
  });
  assert.strictEqual(res.status, 400);
  assert.ok(res.data.error.includes('没有读到文字'));
});

test('M4 · 批量导入答卷接口', async (t) => {
  const ctx = await startApp();
  t.after(() => ctx.close());
  const { paper, questions } = await seedPaper(ctx);
  const s1 = seedStudentDirect('批量甲');
  const s2 = seedStudentDirect('批量乙');

  const res = ok(await ctx.api.post('/api/papers/' + paper.id + '/submissions/import', {
    items: [
      { studentId: s1, answers: [{ seq: 1, text: '甲的第1题' }] },
      { studentId: s2, answers: [{ seq: 2, text: '乙的第2题' }] },
    ],
  }));
  assert.strictEqual(res.created, 2);

  const list = ok(await ctx.api.get('/api/papers/' + paper.id + '/submissions'));
  assert.strictEqual(list.submitted, 2);
  void questions;
});
