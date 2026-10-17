'use strict';

/**
 * 级联删除。
 *
 * 原则：删掉一条记录，就把由它派生出来的东西一并删干净，不留孤儿数据。
 * 之所以要显式写出来（而不是只靠 schema 里的 ON DELETE CASCADE），有两个原因：
 *   1. 要**准确统计**删了多少东西，好让前端在二次确认里把代价说清楚；
 *   2. paper_questions → questions、submissions → students 这两条外键**故意没有**级联，
 *      为的是不让"删一道题"顺手把不相关的数据带走——所以这两处必须在事务里显式处理。
 *
 * 所有函数都必须在调用方的 tx() 里执行，返回计数对象（可安全 JSON 化）。
 */

function changed(result) {
  return Number((result && result.changes) || 0);
}

function emptyCounts() {
  return { submissions: 0, answers: 0, gradeSheets: 0, gradeItems: 0, paperQuestions: 0, batchJobs: 0, papers: 0 };
}

/** 一份答卷的下游：评分明细 → 评分单 → 答案（答卷本身由调用方删） */
function purgeSubmissionSubtree(db, submissionId) {
  const counts = { answers: 0, gradeSheets: 0, gradeItems: 0 };
  const sheet = db.prepare('SELECT id FROM grade_sheets WHERE submission_id = ?').get(submissionId);
  if (sheet) {
    counts.gradeItems += changed(db.prepare('DELETE FROM grade_items WHERE grade_sheet_id = ?').run(sheet.id));
    counts.gradeSheets += changed(db.prepare('DELETE FROM grade_sheets WHERE id = ?').run(sheet.id));
  }
  counts.answers += changed(db.prepare('DELETE FROM answers WHERE submission_id = ?').run(submissionId));
  return counts;
}

/** 删一份答卷：评分明细、评分单、答案、答卷一起清掉 */
function purgeSubmission(db, submissionId) {
  const counts = emptyCounts();
  const sub = db.prepare('SELECT id FROM submissions WHERE id = ?').get(submissionId);
  if (!sub) return counts;
  const c = purgeSubmissionSubtree(db, submissionId);
  counts.answers += c.answers;
  counts.gradeSheets += c.gradeSheets;
  counts.gradeItems += c.gradeItems;
  counts.submissions += changed(db.prepare('DELETE FROM submissions WHERE id = ?').run(submissionId));
  return counts;
}

/** 删一份试卷：题目编排、连带的所有答卷与评分、批量任务一起清掉 */
function purgePaper(db, paperId) {
  const counts = emptyCounts();

  const subs = db.prepare('SELECT id FROM submissions WHERE paper_id = ?').all(paperId);
  subs.forEach((s) => {
    const c = purgeSubmissionSubtree(db, s.id);
    counts.answers += c.answers;
    counts.gradeSheets += c.gradeSheets;
    counts.gradeItems += c.gradeItems;
  });
  counts.submissions += changed(db.prepare('DELETE FROM submissions WHERE paper_id = ?').run(paperId));

  // 万一还有挂在题目上、却不在任何评分单里的明细，先扫干净再删题目
  counts.gradeItems += changed(db.prepare(
    'DELETE FROM grade_items WHERE paper_question_id IN (SELECT id FROM paper_questions WHERE paper_id = ?)'
  ).run(paperId));
  counts.answers += changed(db.prepare(
    'DELETE FROM answers WHERE paper_question_id IN (SELECT id FROM paper_questions WHERE paper_id = ?)'
  ).run(paperId));

  counts.paperQuestions += changed(db.prepare('DELETE FROM paper_questions WHERE paper_id = ?').run(paperId));
  counts.batchJobs += changed(db.prepare('DELETE FROM batch_jobs WHERE paper_id = ?').run(paperId));
  db.prepare('DELETE FROM papers WHERE id = ?').run(paperId);
  counts.papers += 1;
  return counts;
}

/** 删一名学生：他在所有试卷上的答卷与评分一起清掉 */
function purgeStudent(db, studentId) {
  const counts = emptyCounts();
  const subs = db.prepare('SELECT id FROM submissions WHERE student_id = ?').all(studentId);
  subs.forEach((s) => {
    const c = purgeSubmissionSubtree(db, s.id);
    counts.answers += c.answers;
    counts.gradeSheets += c.gradeSheets;
    counts.gradeItems += c.gradeItems;
  });
  counts.submissions += changed(db.prepare('DELETE FROM submissions WHERE student_id = ?').run(studentId));
  db.prepare('DELETE FROM students WHERE id = ?').run(studentId);
  return counts;
}

/** 抽掉一题后把题号重新连号，否则试卷上会留下「第 1 题、第 3 题」这种空档 */
function renumberPaper(db, paperId) {
  const rows = db.prepare('SELECT id FROM paper_questions WHERE paper_id = ? ORDER BY seq, id').all(paperId);
  const stmt = db.prepare('UPDATE paper_questions SET seq = ? WHERE id = ?');
  rows.forEach((r, i) => stmt.run(i + 1, r.id));
}

/** 删一条评分标准：把它从所有引用它的试卷里摘掉，并清掉对应的作答与评分 */
function purgeQuestion(db, questionId) {
  const counts = emptyCounts();
  const papers = new Set();

  const pqs = db.prepare(
    'SELECT id, paper_id FROM paper_questions WHERE question_id = ? ORDER BY paper_id, seq'
  ).all(questionId);

  pqs.forEach((pq) => {
    counts.answers += changed(db.prepare('DELETE FROM answers WHERE paper_question_id = ?').run(pq.id));
    counts.gradeItems += changed(db.prepare('DELETE FROM grade_items WHERE paper_question_id = ?').run(pq.id));
    db.prepare('DELETE FROM paper_questions WHERE id = ?').run(pq.id);
    counts.paperQuestions += 1;
    papers.add(pq.paper_id);
  });

  papers.forEach((pid) => renumberPaper(db, pid));
  counts.papers = papers.size;

  counts.gradeItems += changed(db.prepare(
    'DELETE FROM grade_items WHERE question_item_id IN (SELECT id FROM question_items WHERE question_id = ?)'
  ).run(questionId));
  db.prepare('DELETE FROM question_items WHERE question_id = ?').run(questionId);
  db.prepare('DELETE FROM questions WHERE id = ?').run(questionId);
  return counts;
}

/** 给前端二次确认用的"删了会连带影响什么"摘要 */
function describeCounts(counts) {
  const parts = [];
  if (counts.submissions) parts.push(`${counts.submissions} 份答卷`);
  if (counts.answers) parts.push(`${counts.answers} 条作答`);
  if (counts.gradeSheets) parts.push(`${counts.gradeSheets} 份评分`);
  if (counts.gradeItems) parts.push(`${counts.gradeItems} 条评分明细`);
  if (counts.paperQuestions) parts.push(`${counts.paperQuestions} 处用题`);
  if (counts.batchJobs) parts.push(`${counts.batchJobs} 个批量任务`);
  return parts.length ? parts.join('、') : '没有关联数据';
}

module.exports = {
  purgeSubmission,
  purgeSubmissionSubtree,
  purgePaper,
  purgeStudent,
  purgeQuestion,
  renumberPaper,
  describeCounts,
};
