'use strict';

const { all, get } = require('../db');

/** 试卷包含的题目（含生效分值：试卷覆盖值优先，否则用题目自带分值） */
function paperQuestionRows(paperId) {
  return all(
    `SELECT pq.id, pq.paper_id, pq.question_id, pq.seq,
            COALESCE(pq.points, q.points) AS points,
            pq.item_points,
            q.stem, q.ref_answer, q.rubric_type, q.rubric_text,
            q.points AS question_points, q.subject, q.knowledge, q.qtype,
            q.difficulty, q.stem_images
       FROM paper_questions pq
       JOIN questions q ON q.id = pq.question_id
      WHERE pq.paper_id = ?
      ORDER BY pq.seq`,
    paperId
  );
}

/** 试卷总分 = 各题生效分值之和 */
function paperTotal(paperId) {
  return paperQuestionRows(paperId).reduce((sum, r) => sum + Number(r.points || 0), 0);
}

/** 没设整卷满分时的默认值（一份卷子总得有个满分，不然 AI 不知道按多少给分） */
const DEFAULT_WHOLE_FULL_MARKS = 100;

/**
 * 这份卷子的整卷满分 —— 定 AI 给分的上限、及格线、平均分的分母。
 *
 * 规则：**老师自己给的整卷总分（whole_full_marks）优先**；
 * 没给总分时，卷子里有题目就按各题分值之和算（老数据），没有题目就按 100。
 * （有了整卷总分后，AI 会把它按权重分到每道大题、再平均到每小题 —— 见 allocate。）
 * @param {object} paper papers 表的行（要有 id 与 whole_full_marks）
 */
function paperFullMarks(paper) {
  const own = Number(paper.whole_full_marks);
  if (Number.isFinite(own) && own > 0) return round2(own);
  const total = paperTotal(paper.id);
  if (total > 0) return round2(total);
  return DEFAULT_WHOLE_FULL_MARKS;
}

/**
 * 把一个总分**平均**分给 n 项，保证各项之和精确等于总分。
 * 前 n-1 项四舍五入到 2 位，最后一项拿余数补差（所以最后一项可能和前面的差 0.01）。
 */
function distributeEvenly(total, n) {
  const t = round2(total);
  if (!Number.isFinite(n) || n <= 0) return [];
  if (n === 1) return [t];
  const each = round2(t / n);
  const out = new Array(n).fill(each);
  const sum = round2(out.reduce((a, b) => a + b, 0));
  out[n - 1] = round2(out[n - 1] + (t - sum));
  return out;
}

/** 一道题在试卷中的满分 */
function paperQuestionPoints(paperQuestionId) {
  const row = get(
    `SELECT pq.id, COALESCE(pq.points, q.points) AS points
       FROM paper_questions pq JOIN questions q ON q.id = pq.question_id
      WHERE pq.id = ?`,
    paperQuestionId
  );
  return row ? Number(row.points || 0) : 0;
}

/** 评分单某题的最终得分（无老师分则用 AI 分） */
function questionScore(gradeSheetId, paperQuestionId) {
  const rows = all(
    'SELECT ai_score, final_score FROM grade_items WHERE grade_sheet_id = ? AND paper_question_id = ?',
    gradeSheetId,
    paperQuestionId
  );
  return rows.reduce((sum, r) => {
    const v = r.final_score === null || r.final_score === undefined ? r.ai_score : r.final_score;
    return sum + Number(v || 0);
  }, 0);
}

/** 评分单总分 */
function sheetTotal(gradeSheetId) {
  const rows = all(
    'SELECT ai_score, final_score FROM grade_items WHERE grade_sheet_id = ?',
    gradeSheetId
  );
  return round2(rows.reduce((sum, r) => {
    const v = r.final_score === null || r.final_score === undefined ? r.ai_score : r.final_score;
    return sum + Number(v || 0);
  }, 0));
}

function round2(n) {
  return Math.round((Number(n) + Number.EPSILON) * 100) / 100;
}

function mean(list) {
  if (!list.length) return 0;
  return round2(list.reduce((a, b) => a + b, 0) / list.length);
}

/** 试卷及格线：未设置时按整卷满分的 60% 计（无题卷就用它的整卷满分） */
function passLine(paper) {
  if (paper.pass_line && Number(paper.pass_line) > 0) return Number(paper.pass_line);
  return round2(paperFullMarks(paper) * 0.6);
}

module.exports = {
  paperQuestionRows,
  paperTotal,
  paperFullMarks,
  DEFAULT_WHOLE_FULL_MARKS,
  distributeEvenly,
  paperQuestionPoints,
  questionScore,
  sheetTotal,
  round2,
  mean,
  passLine,
};
