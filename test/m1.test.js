'use strict';

const test = require('node:test');
const assert = require('node:assert');

const { getDb, nowIso } = require('../server/db');
const { parseRoster } = require('../server/routes/students');
const { startApp, ok } = require('./helpers');

function seedPaper(name, questionPoints, status) {
  const db = getDb();
  const now = nowIso();
  const paper = db.prepare(
    'INSERT INTO papers(name, status, pass_line, created_at, updated_at) VALUES(?,?,?,?,?)'
  ).run(name, status || 'open', 0, now, now);
  const paperId = Number(paper.lastInsertRowid);
  const question = db.prepare(
    "INSERT INTO questions(stem, rubric_type, rubric_text, points, created_at, updated_at) VALUES(?,?,?,?,?,?)"
  ).run('测试题', 'text', '标准', questionPoints, now, now);
  const pq = db.prepare(
    'INSERT INTO paper_questions(paper_id, question_id, seq, points) VALUES(?,?,?,?)'
  ).run(paperId, Number(question.lastInsertRowid), 1, null);
  return { paperId, pqId: Number(pq.lastInsertRowid) };
}

function seedSubmission(paperId, studentId) {
  const db = getDb();
  const now = nowIso();
  const s = db.prepare(
    'INSERT INTO submissions(paper_id, student_id, source, status, submitted_at, updated_at) VALUES(?,?,?,?,?,?)'
  ).run(paperId, studentId, 'manual', 'submitted', now, now);
  return Number(s.lastInsertRowid);
}

function seedConfirmedSheet(submissionId, score) {
  const db = getDb();
  const now = nowIso();
  const g = db.prepare(
    "INSERT INTO grade_sheets(submission_id, status, ai_total, final_total, confirmed_at, created_at, updated_at) VALUES(?,?,?,?,?,?,?)"
  ).run(submissionId, 'confirmed', score, score, now, now, now);
  return Number(g.lastInsertRowid);
}

test('M1 · 名单文本解析：支持空格、逗号、制表符与注释行', () => {
  const rows = parseRoster('张三 001 高一(1)班\n李四,002,高一(1)班\n# 这是注释\n\n王五\t003\t高一(2)班\n赵六');
  assert.strictEqual(rows.length, 4);
  assert.deepStrictEqual(rows[0], { name: '张三', sno: '001', className: '高一(1)班' });
  assert.deepStrictEqual(rows[1], { name: '李四', sno: '002', className: '高一(1)班' });
  assert.deepStrictEqual(rows[2], { name: '王五', sno: '003', className: '高一(2)班' });
  assert.deepStrictEqual(rows[3], { name: '赵六', sno: '', className: '' });
});

test('M1 · 学生 CRUD 全流程', async (t) => {
  const ctx = await startApp();
  t.after(() => ctx.close());

  const created = ok(await ctx.api.post('/api/students', { name: '张三', sno: '001', className: '高一(1)班' }));
  assert.strictEqual(created.student.name, '张三');
  assert.ok(created.student.id > 0);

  const list = ok(await ctx.api.get('/api/students'));
  assert.strictEqual(list.total, 1);
  assert.strictEqual(list.students[0].submissionCount, 0);

  const updated = ok(await ctx.api.put('/api/students/' + created.student.id, { name: '张三丰', sno: '001', className: '高一(2)班' }));
  assert.strictEqual(updated.student.name, '张三丰');
  assert.strictEqual(updated.student.className, '高一(2)班');

  const fetched = ok(await ctx.api.get('/api/students/' + created.student.id));
  assert.strictEqual(fetched.student.name, '张三丰');

  ok(await ctx.api.del('/api/students/' + created.student.id));
  const after = ok(await ctx.api.get('/api/students'));
  assert.strictEqual(after.total, 0);
});

test('M1 · 校验：姓名为空 400、学号重复 409、同班同名 409', async (t) => {
  const ctx = await startApp();
  t.after(() => ctx.close());

  const empty = await ctx.api.post('/api/students', { name: '  ' });
  assert.strictEqual(empty.status, 400);

  ok(await ctx.api.post('/api/students', { name: '李四', sno: '100', className: '一班' }));

  const dupSno = await ctx.api.post('/api/students', { name: '王五', sno: '100', className: '一班' });
  assert.strictEqual(dupSno.status, 409);
  assert.ok(dupSno.data.error.includes('学号'));

  const dupName = await ctx.api.post('/api/students', { name: '李四', sno: '', className: '一班' });
  assert.strictEqual(dupName.status, 409);
});

test('M1 · 搜索：按姓名 / 学号 / 班级 命中', async (t) => {
  const ctx = await startApp();
  t.after(() => ctx.close());
  ok(await ctx.api.post('/api/students', { name: '张三', sno: '001', className: '高一(1)班' }));
  ok(await ctx.api.post('/api/students', { name: '李四', sno: '002', className: '高二(3)班' }));

  assert.strictEqual(ok(await ctx.api.get('/api/students?q=' + encodeURIComponent('张三'))).total, 1);
  assert.strictEqual(ok(await ctx.api.get('/api/students?q=002')).total, 1);
  assert.strictEqual(ok(await ctx.api.get('/api/students?q=' + encodeURIComponent('高一'))).total, 1);
  assert.strictEqual(ok(await ctx.api.get('/api/students?q=' + encodeURIComponent('不存在'))).total, 0);
});

test('M1 · 批量导入：预览标记重复、导入跳过重复', async (t) => {
  const ctx = await startApp();
  t.after(() => ctx.close());

  const text = '张三 001 高一(1)班\n李四 002 高一(1)班\n张三 003 高一(1)班';
  const preview = ok(await ctx.api.post('/api/students/import/preview', { text }));
  assert.strictEqual(preview.total, 3);

  const res = ok(await ctx.api.post('/api/students/import', { text }));
  assert.strictEqual(res.created, 2, '应导入 2 位');

  const again = ok(await ctx.api.post('/api/students/import', { text }));
  assert.strictEqual(again.created, 0, '重复导入不应新增');
  assert.strictEqual(again.skipped.length, 3, '三行都应与已有记录重复而被跳过');
  assert.ok(again.skipped.every((s) => s.reason), '每条跳过都要给出原因');

  const list = ok(await ctx.api.get('/api/students'));
  assert.strictEqual(list.total, 2, '第三行"张三 003"与已存在的同班同名，应被跳过');
  assert.deepStrictEqual(list.students.map((s) => s.name).sort(), ['张三', '李四']);
});

test('M1 · 删除学生：历次答卷与评分一起清掉，不留孤儿', async (t) => {
  const ctx = await startApp();
  t.after(() => ctx.close());

  const stu = ok(await ctx.api.post('/api/students', { name: '张三', sno: '001', className: '高一(1)班' })).student;
  const other = ok(await ctx.api.post('/api/students', { name: '李四', sno: '002', className: '高一(1)班' })).student;

  const noHistory = ok(await ctx.api.get('/api/students/' + other.id + '/history'));
  assert.strictEqual(noHistory.history.length, 0);

  const { paperId, pqId } = seedPaper('高一物理 · 第一次月考', 10, 'open');
  const subId = seedSubmission(paperId, stu.id);
  const sheetId = seedConfirmedSheet(subId, 8);
  getDb().prepare(
    'INSERT INTO grade_items(grade_sheet_id, paper_question_id, mode, ai_score, final_score) VALUES(?,?,?,?,?)'
  ).run(sheetId, pqId, 'rubric', 8, 8);

  const history = ok(await ctx.api.get('/api/students/' + stu.id + '/history'));
  assert.strictEqual(history.history.length, 1);
  assert.strictEqual(history.history[0].paperName, '高一物理 · 第一次月考');
  assert.strictEqual(history.history[0].fullMarks, 10);
  assert.strictEqual(history.history[0].total, 8);
  assert.strictEqual(history.history[0].passed, true, '及格线默认总分的 60%，8 分应及格');

  // 删学生不再拦人：历次答卷与评分一并清掉，并如实回报删了什么
  const removed = ok(await ctx.api.del('/api/students/' + stu.id));
  assert.strictEqual(removed.removed.submissions, 1);
  assert.strictEqual(removed.removed.gradeSheets, 1);
  assert.strictEqual(removed.removed.gradeItems, 1);
  const db = getDb();
  assert.strictEqual(db.prepare('SELECT COUNT(*) AS c FROM submissions WHERE student_id = ?').get(stu.id).c, 0);
  assert.strictEqual(db.prepare('SELECT COUNT(*) AS c FROM grade_sheets').get().c, 0);

  ok(await ctx.api.del('/api/students/' + other.id));
  const stillThere = ok(await ctx.api.get('/api/students'));
  assert.strictEqual(stillThere.total, 0);
});

test('M1 · 列表带答卷数统计', async (t) => {
  const ctx = await startApp();
  t.after(() => ctx.close());
  const stu = ok(await ctx.api.post('/api/students', { name: '张三', className: '高一(1)班' })).student;
  const { paperId } = seedPaper('卷A', 10, 'open');
  seedSubmission(paperId, stu.id);
  const list = ok(await ctx.api.get('/api/students'));
  assert.strictEqual(list.students[0].submissionCount, 1);
});
