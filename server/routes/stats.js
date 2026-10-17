'use strict';

const { all, get } = require('../db');
const { HttpError } = require('../router');
const { paperQuestionRows, paperFullMarks, passLine, round2, mean } = require('../lib/calc');
const { progressOf } = require('./papers');

/** 得分：老师分优先，否则用 AI 分 */
function effectiveOf(row) {
  const v = row.final_score === null || row.final_score === undefined ? row.ai_score : row.final_score;
  return Number(v || 0);
}

function hasNum(v) {
  return v !== null && v !== undefined;
}

/**
 * 已确认答卷的最终得分。
 * 逐题答卷：明细（老师分优先）加总。
 * 整份图片作答：卷子上只有一个总分，按「确认时落定的 final_total → 老师改过的整卷分 → AI 给的整卷分」取。
 */
function confirmedTotalOf(sheet, itemSum) {
  if (!sheet.whole_mode) return Number(itemSum || 0);
  const v = hasNum(sheet.final_total)
    ? sheet.final_total
    : (hasNum(sheet.whole_final_score) ? sheet.whole_final_score : sheet.whole_ai_score);
  return hasNum(v) ? Number(v || 0) : 0;
}

function todayKey(d) {
  const x = d || new Date();
  const p = (n) => String(n).padStart(2, '0');
  return `${x.getFullYear()}-${p(x.getMonth() + 1)}-${p(x.getDate())}`;
}

/** 把 ISO 时间转成当地日期（用于判断"今天"） */
function localDateKey(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  return todayKey(d);
}

function paperRow(id) {
  const row = get('SELECT * FROM papers WHERE id = ?', id);
  if (!row) throw new HttpError(404, '试卷不存在');
  return row;
}

/** 已确认的评分单（统计口径：只算已确认，见 PRD 第 24 条） */
function confirmedSheets(paperId) {
  return all(
    `SELECT gs.id AS sheet_id, gs.submission_id, gs.final_total, gs.comment,
            gs.whole_mode, gs.whole_ai_score, gs.whole_final_score,
            s.student_id, st.name, st.sno, st.class_name
       FROM grade_sheets gs
       JOIN submissions s ON s.id = gs.submission_id
  LEFT JOIN students st ON st.id = s.student_id
      WHERE s.paper_id = ? AND gs.status = 'confirmed'`,
    paperId
  );
}

function confirmedItems(paperId) {
  return all(
    `SELECT gi.grade_sheet_id, gi.paper_question_id, gi.question_item_id,
            gi.ai_score, gi.final_score, gi.doubt
       FROM grade_items gi
       JOIN grade_sheets gs ON gs.id = gi.grade_sheet_id
       JOIN submissions s ON s.id = gs.submission_id
      WHERE s.paper_id = ? AND gs.status = 'confirmed'`,
    paperId
  );
}

/**
 * 一份试卷的全部统计（只算已确认答卷）。
 * 返回 questions 按得分率升序（最需要讲的排前面）、students 按总分降序。
 */
function paperStats(paperId) {
  const paper = paperRow(paperId);
  const pqs = paperQuestionRows(paperId);
  const sheets = confirmedSheets(paperId);
  const items = confirmedItems(paperId);

  const buckets = new Map();
  pqs.forEach((q) => buckets.set(q.id, { scoreSum: 0, itemCount: 0, doubtCount: 0 }));
  const sheetQuestionScore = new Map(); // "sheetId:pqId" -> score
  const sheetTotalScore = new Map();    // sheetId -> score

  items.forEach((it) => {
    const bucket = buckets.get(it.paper_question_id);
    if (!bucket) return;
    const score = effectiveOf(it);
    bucket.scoreSum += score;
    bucket.itemCount += 1;
    if (it.doubt === 1) bucket.doubtCount += 1;
    const key = it.grade_sheet_id + ':' + it.paper_question_id;
    sheetQuestionScore.set(key, (sheetQuestionScore.get(key) || 0) + score);
    sheetTotalScore.set(it.grade_sheet_id, (sheetTotalScore.get(it.grade_sheet_id) || 0) + score);
  });

  const fullMarks = paperFullMarks(paper);
  const line = passLine(paper);

  const questions = pqs.map((q) => {
    const bucket = buckets.get(q.id);
    const points = round2(q.points || 0);
    let sheetCount = 0;
    let lostCount = 0;
    let zeroCount = 0;
    sheets.forEach((sh) => {
      const sc = sheetQuestionScore.get(sh.sheet_id + ':' + q.id);
      if (sc === undefined) return;
      sheetCount += 1;
      if (sc < points - 1e-9) lostCount += 1;
      if (sc <= 1e-9) zeroCount += 1;
    });
    const scoreSum = round2(bucket.scoreSum);
    return {
      paperQuestionId: q.id,
      questionId: q.question_id,
      seq: q.seq,
      stem: q.stem,
      points,
      subject: q.subject || '',
      knowledge: q.knowledge || '',
      qtype: q.qtype || '',
      sheetCount,
      scoreSum,
      fullSum: round2(points * sheetCount),
      rate: points > 0 && sheetCount > 0 ? round2(scoreSum / (points * sheetCount)) : null,
      average: sheetCount > 0 ? round2(scoreSum / sheetCount) : null,
      lostCount,
      zeroCount,
      doubtCount: bucket.doubtCount,
    };
  });

  const ranked = questions.slice().sort((a, b) => {
    if (a.rate === null && b.rate === null) return a.seq - b.seq;
    if (a.rate === null) return 1;
    if (b.rate === null) return -1;
    return a.rate - b.rate || a.seq - b.seq;
  });

  // 整卷答卷没有明细，按卷子上那个总分算；逐题答卷还是明细加总
  const totals = sheets.map((sh) => round2(confirmedTotalOf(sh, sheetTotalScore.get(sh.sheet_id))));
  const passCount = totals.filter((t) => t >= line - 1e-9).length;

  const students = sheets.map((sh) => {
    const total = round2(confirmedTotalOf(sh, sheetTotalScore.get(sh.sheet_id)));
    return {
      studentId: sh.student_id,
      name: sh.name || '(已删除)',
      sno: sh.sno || '',
      className: sh.class_name || '',
      submissionId: sh.submission_id,
      gradeSheetId: sh.sheet_id,
      // 这份答卷是整份图片作答（整卷一个总分，没拆到题上）
      whole: Boolean(sh.whole_mode),
      total,
      percent: fullMarks > 0 ? round2(total / fullMarks) : null,
      passed: total >= line - 1e-9,
    };
  }).sort((a, b) => b.total - a.total || String(a.sno).localeCompare(String(b.sno)));

  let rank = 0;
  let prev = null;
  students.forEach((s, i) => {
    if (prev === null || s.total !== prev) {
      rank = i + 1;
      prev = s.total;
    }
    s.rank = rank;
  });

  const progress = progressOf(paperId);
  return {
    paper: { id: paper.id, name: paper.name, status: paper.status, updatedAt: paper.updated_at },
    fullMarks,
    passLine: line,
    overview: {
      count: sheets.length,
      submitted: progress.submissionCount,
      absent: progress.absentCount,
      ungraded: progress.ungraded,
      toConfirm: progress.toConfirm,
      confirmed: progress.confirmed,
      average: totals.length ? mean(totals) : null,
      highest: totals.length ? round2(Math.max(...totals)) : null,
      lowest: totals.length ? round2(Math.min(...totals)) : null,
      passLine: line,
      passCount,
      passRate: totals.length ? round2(passCount / totals.length) : null,
    },
    questions,
    ranking: ranked,
    students,
  };
}

/** 单题详情：失分学生名单 */
function questionDetail(paperId, paperQuestionId) {
  paperRow(paperId);
  const pq = paperQuestionRows(paperId).find((r) => r.id === Number(paperQuestionId));
  if (!pq) throw new HttpError(404, '这道题不在该试卷里');

  const points = round2(pq.points || 0);
  const rubricItems = pq.rubric_type === 'items'
    ? all('SELECT id, seq, text, points FROM question_items WHERE question_id = ? ORDER BY seq', pq.question_id)
      .map((r) => ({ id: r.id, seq: r.seq, text: r.text, points: round2(r.points) }))
    : [];

  const sheets = confirmedSheets(paperId);
  const items = all(
    `SELECT gi.*
       FROM grade_items gi
       JOIN grade_sheets gs ON gs.id = gi.grade_sheet_id
       JOIN submissions s ON s.id = gs.submission_id
      WHERE s.paper_id = ? AND gs.status = 'confirmed' AND gi.paper_question_id = ?
      ORDER BY gi.id`,
    paperId,
    pq.id
  );

  const rows = sheets.map((sh) => {
    const mine = items.filter((i) => i.grade_sheet_id === sh.sheet_id);
    const score = round2(mine.reduce((s, i) => s + effectiveOf(i), 0));
    return {
      studentId: sh.student_id,
      name: sh.name || '(已删除)',
      sno: sh.sno || '',
      className: sh.class_name || '',
      submissionId: sh.submission_id,
      gradeSheetId: sh.sheet_id,
      answered: mine.length > 0,
      score,
      lost: round2(points - score),
      rate: points > 0 ? round2(score / points) : null,
      doubtCount: mine.filter((i) => i.doubt === 1).length,
      items: mine.map((i) => {
        const rub = i.question_item_id ? rubricItems.find((r) => r.id === i.question_item_id) : null;
        return {
          gradeItemId: i.id,
          criterion: rub ? rub.text : (pq.rubric_type === 'text' ? '整体给分' : '得分点'),
          score: round2(effectiveOf(i)),
          max: rub ? round2(rub.points) : points,
          aiScore: i.ai_score === null || i.ai_score === undefined ? null : round2(i.ai_score),
          doubt: i.doubt === 1,
          reason: i.ai_reason || '',
          teacherNote: i.teacher_note || '',
        };
      }),
    };
  });

  const sheetCount = rows.filter((r) => r.answered).length;
  const scoreSum = round2(rows.reduce((s, r) => s + (r.answered ? r.score : 0), 0));
  const lost = rows
    .filter((r) => r.answered && r.lost > 1e-9)
    .sort((a, b) => b.lost - a.lost || String(a.sno).localeCompare(String(b.sno)));

  return {
    paperQuestionId: pq.id,
    questionId: pq.question_id,
    seq: pq.seq,
    stem: pq.stem,
    refAnswer: pq.ref_answer || '',
    points,
    rubricType: pq.rubric_type,
    rubricText: pq.rubric_text || '',
    rubricItems,
    sheetCount,
    scoreSum,
    fullSum: round2(points * sheetCount),
    rate: points > 0 && sheetCount > 0 ? round2(scoreSum / (points * sheetCount)) : null,
    average: sheetCount > 0 ? round2(scoreSum / sheetCount) : null,
    lostCount: lost.length,
    students: lost,
  };
}

/** 有已确认答卷的试卷（待讲评题目的来源） */
function gradedPapers() {
  return all(
    `SELECT DISTINCT p.id, p.name, p.status, p.updated_at
       FROM papers p
       JOIN submissions s ON s.paper_id = p.id
       JOIN grade_sheets gs ON gs.submission_id = s.id
      WHERE gs.status = 'confirmed'
      ORDER BY p.updated_at DESC`
  );
}

/** 得分率低于 50% 的题目 = 待讲评 */
const REVIEW_RATE = 0.5;

function lowRateQuestions(limit) {
  const out = [];
  gradedPapers().forEach((p) => {
    const stats = paperStats(p.id);
    stats.questions.forEach((q) => {
      if (q.rate !== null && q.sheetCount > 0 && q.rate < REVIEW_RATE) {
        out.push({
          paperId: p.id,
          paperName: p.name,
          paperQuestionId: q.paperQuestionId,
          seq: q.seq,
          stem: q.stem,
          points: q.points,
          subject: q.subject,
          knowledge: q.knowledge,
          sheetCount: q.sheetCount,
          scoreSum: q.scoreSum,
          fullSum: q.fullSum,
          rate: q.rate,
          average: q.average,
          lostCount: q.lostCount,
        });
      }
    });
  });
  out.sort((a, b) => a.rate - b.rate || a.paperId - b.paperId || a.seq - b.seq);
  return limit ? out.slice(0, limit) : out;
}

/** 四张摘要卡的口径与各自"最该去点的那份试卷" */
function cardCounts() {
  const toGrade = get(
    `SELECT COUNT(*) AS c FROM submissions s
  LEFT JOIN grade_sheets gs ON gs.submission_id = s.id
      WHERE s.status = 'submitted' AND IFNULL(gs.status, 'ungraded') = 'ungraded'`
  ).c;
  const toConfirm = get("SELECT COUNT(*) AS c FROM grade_sheets WHERE status = 'ai_done'").c;
  // 存疑 = 逐题明细里的存疑点 + 整卷答卷上的整卷存疑（两边互斥，不会重复计）
  const doubt = get(
    `SELECT
       IFNULL((SELECT COUNT(*) FROM grade_items gi
                 JOIN grade_sheets gs ON gs.id = gi.grade_sheet_id
                WHERE gi.doubt = 1 AND gs.status <> 'confirmed'), 0)
     + IFNULL((SELECT COUNT(*) FROM grade_sheets gs
                WHERE gs.whole_doubt = 1 AND gs.status <> 'confirmed'), 0) AS c`
  ).c;
  return { toGrade, toConfirm, doubt };
}

function focusPaper(kind) {
  let row = null;
  if (kind === 'toGrade') {
    row = get(
      `SELECT s.paper_id AS pid, COUNT(*) AS c FROM submissions s
    LEFT JOIN grade_sheets gs ON gs.submission_id = s.id
        WHERE s.status = 'submitted' AND IFNULL(gs.status, 'ungraded') = 'ungraded'
        GROUP BY s.paper_id ORDER BY c DESC, s.paper_id LIMIT 1`
    );
  } else if (kind === 'toConfirm') {
    row = get(
      `SELECT s.paper_id AS pid, COUNT(*) AS c FROM grade_sheets gs
        JOIN submissions s ON s.id = gs.submission_id
        WHERE gs.status = 'ai_done' GROUP BY s.paper_id ORDER BY c DESC, s.paper_id LIMIT 1`
    );
  } else if (kind === 'doubt') {
    // 逐题存疑点和整卷存疑都归到"最该去点的那份试卷"上
    row = get(
      `SELECT pid, COUNT(*) AS c FROM (
         SELECT s.paper_id AS pid FROM grade_items gi
           JOIN grade_sheets gs ON gs.id = gi.grade_sheet_id
           JOIN submissions s ON s.id = gs.submission_id
          WHERE gi.doubt = 1 AND gs.status <> 'confirmed'
         UNION ALL
         SELECT s.paper_id AS pid FROM grade_sheets gs
           JOIN submissions s ON s.id = gs.submission_id
          WHERE gs.whole_doubt = 1 AND gs.status <> 'confirmed'
       )
       GROUP BY pid ORDER BY c DESC, pid LIMIT 1`
    );
  }
  if (!row) return null;
  const paper = get('SELECT id, name FROM papers WHERE id = ?', row.pid);
  return paper ? { paperId: paper.id, paperName: paper.name, count: row.c } : null;
}

/** 当前还在进行中的试卷（待作答 / 收卷中 / 批改中） */
function activePapers() {
  return all(
    `SELECT * FROM papers WHERE status IN ('open','collecting','grading') ORDER BY updated_at DESC, id DESC`
  ).map((p) => {
    const stats = paperStats(p.id);
    return {
      id: p.id,
      name: p.name,
      status: p.status,
      updatedAt: p.updated_at,
      fullMarks: stats.fullMarks,
      progress: progressOf(p.id),
      average: stats.overview.average,
      highest: stats.overview.highest,
      lowest: stats.overview.lowest,
    };
  });
}

/** 左栏「需要你处理」：待确认的答卷 + AI 存疑处 */
function pendingWork(limit) {
  const sheets = all(
    `SELECT gs.id AS sheet_id, gs.submission_id, gs.ai_total, s.paper_id, p.name AS paper_name,
            p.whole_full_marks AS paper_whole_full_marks,
            st.name AS student_name, st.sno, st.class_name,
            gs.whole_mode, gs.whole_ai_score, gs.whole_final_score, gs.whole_doubt,
            (SELECT COUNT(*) FROM grade_items gi WHERE gi.grade_sheet_id = gs.id AND gi.doubt = 1) AS doubt_count,
            (SELECT COALESCE(SUM(CASE WHEN gi.final_score IS NULL THEN IFNULL(gi.ai_score,0) ELSE gi.final_score END), 0)
               FROM grade_items gi WHERE gi.grade_sheet_id = gs.id) AS effective_total
       FROM grade_sheets gs
       JOIN submissions s ON s.id = gs.submission_id
       JOIN papers p ON p.id = s.paper_id
  LEFT JOIN students st ON st.id = s.student_id
      WHERE gs.status = 'ai_done'
      ORDER BY gs.updated_at DESC, gs.id DESC
      LIMIT ?`,
    limit
  ).map((r) => {
    const whole = Boolean(r.whole_mode);
    // 整卷答卷只有整卷这一个分、这一处存疑
    const wholeScore = hasNum(r.whole_final_score) ? r.whole_final_score
      : (hasNum(r.whole_ai_score) ? r.whole_ai_score : r.ai_total);
    return {
      gradeSheetId: r.sheet_id,
      submissionId: r.submission_id,
      paperId: r.paper_id,
      paperName: r.paper_name,
      studentName: r.student_name || '(已删除)',
      sno: r.sno || '',
      className: r.class_name || '',
      whole,
      doubtCount: whole ? (r.whole_doubt === 1 ? 1 : 0) : r.doubt_count,
      effectiveTotal: round2(whole ? (hasNum(wholeScore) ? Number(wholeScore) : 0) : r.effective_total),
      fullMarks: paperFullMarks({ id: r.paper_id, whole_full_marks: r.paper_whole_full_marks }),
    };
  });

  // 逐题存疑点和整卷存疑合成一条流；整卷那条没有题号（seq 为 null）
  const doubts = all(
    `SELECT * FROM (
       SELECT gi.id AS sort_id, 0 AS whole, gi.id AS grade_item_id, gi.paper_question_id,
              gi.ai_reason, pq.seq,
              gs.id AS sheet_id, gs.submission_id, s.paper_id, p.name AS paper_name,
              st.name AS student_name, st.class_name, gs.updated_at AS upd,
              (CASE WHEN gi.final_score IS NULL THEN IFNULL(gi.ai_score,0) ELSE gi.final_score END) AS eff
         FROM grade_items gi
         JOIN grade_sheets gs ON gs.id = gi.grade_sheet_id
         JOIN submissions s ON s.id = gs.submission_id
         JOIN papers p ON p.id = s.paper_id
         JOIN paper_questions pq ON pq.id = gi.paper_question_id
    LEFT JOIN students st ON st.id = s.student_id
        WHERE gi.doubt = 1 AND gs.status <> 'confirmed'
       UNION ALL
       SELECT gs.id AS sort_id, 1 AS whole, NULL AS grade_item_id, NULL AS paper_question_id,
              gs.whole_reason AS ai_reason, NULL AS seq,
              gs.id AS sheet_id, gs.submission_id, s.paper_id, p.name AS paper_name,
              st.name AS student_name, st.class_name, gs.updated_at AS upd,
              (CASE WHEN gs.whole_final_score IS NULL
                    THEN IFNULL(gs.whole_ai_score, IFNULL(gs.ai_total,0))
                    ELSE gs.whole_final_score END) AS eff
         FROM grade_sheets gs
         JOIN submissions s ON s.id = gs.submission_id
         JOIN papers p ON p.id = s.paper_id
    LEFT JOIN students st ON st.id = s.student_id
        WHERE gs.whole_doubt = 1 AND gs.status <> 'confirmed'
     )
     ORDER BY upd DESC, whole, sort_id
     LIMIT ?`,
    limit
  ).map((r) => ({
    gradeItemId: r.grade_item_id,
    gradeSheetId: r.sheet_id,
    submissionId: r.submission_id,
    paperId: r.paper_id,
    paperName: r.paper_name,
    studentName: r.student_name || '(已删除)',
    className: r.class_name || '',
    // 整卷存疑没有题号，前端显示「整卷」
    whole: r.whole === 1,
    seq: r.seq === null ? null : r.seq,
    score: round2(r.eff),
    reason: r.ai_reason || '',
  }));

  return { sheets, doubts };
}

function homeStats() {
  const counts = cardCounts();
  const low = lowRateQuestions();
  const review = {
    count: low.length,
    questions: low.slice(0, 3),
    focusPaper: low.length ? { paperId: low[0].paperId, paperName: low[0].paperName, count: low.length } : null,
  };
  const cards = {
    toGrade: { count: counts.toGrade, focus: focusPaper('toGrade') },
    toConfirm: { count: counts.toConfirm, focus: focusPaper('toConfirm') },
    doubt: { count: counts.doubt, focus: focusPaper('doubt') },
    toReview: { count: review.count, focus: review.focusPaper },
  };
  return {
    date: todayKey(),
    cards,
    papers: activePapers(),
    left: pendingWork(6),
    right: { lowRateQuestions: review.questions, lowRateTotal: review.count },
  };
}

function register(router) {
  router.get('/api/stats/home', () => homeStats());

  router.get('/api/stats/paper/:pid', (ctx) => paperStats(ctx.params.pid));

  router.get('/api/stats/paper/:pid/question/:pqid', (ctx) => questionDetail(ctx.params.pid, ctx.params.pqid));
}

module.exports = {
  register,
  homeStats,
  paperStats,
  questionDetail,
  lowRateQuestions,
  cardCounts,
  focusPaper,
  activePapers,
  REVIEW_RATE,
  localDateKey,
  todayKey,
};
