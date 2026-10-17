'use strict';

const { all, get, run, tx, nowIso } = require('../db');
const { HttpError } = require('../router');
const { paperFullMarks, passLine, round2 } = require('../lib/calc');
const { normalizeWrongList } = require('../lib/prompts');
const {
  gradeSubmission, loadContext, gradingModeOf, wholeImagesOf,
} = require('../services/grader');

const FILTERS = ['all', 'pending', 'to_confirm', 'doubt'];

function paperRow(id) {
  const row = get('SELECT * FROM papers WHERE id = ?', id);
  if (!row) throw new HttpError(404, '试卷不存在');
  return row;
}

function sheetRow(id) {
  const row = get('SELECT * FROM grade_sheets WHERE id = ?', id);
  if (!row) throw new HttpError(404, '评分单不存在');
  return row;
}

function doubtCountOf(sheetId) {
  return get('SELECT COUNT(*) AS c FROM grade_items WHERE grade_sheet_id = ? AND doubt = 1', sheetId).c;
}

function effectiveTotal(sheetId) {
  const rows = all('SELECT ai_score, final_score FROM grade_items WHERE grade_sheet_id = ?', sheetId);
  return round2(rows.reduce((sum, r) => {
    const v = r.final_score === null || r.final_score === undefined ? r.ai_score : r.final_score;
    return sum + Number(v || 0);
  }, 0));
}

/** 这张评分单是不是「整份图片作答」的整卷评分（没有逐题明细，只有一个总分）。 */
function wholeModeOf(sheet) {
  return Boolean(sheet && sheet.whole_mode);
}

function positive(image) {
  return image !== null && image !== undefined;
}

/**
 * 老师看到的那个总分。整卷答卷看整卷分（老师改过的 > AI 给的 > 兜底），
 * 逐题答卷还是把明细加总。
 */
function sheetTotal(sheet) {
  if (!sheet) return 0;
  if (!wholeModeOf(sheet)) return effectiveTotal(sheet.id);
  const v = positive(sheet.whole_final_score)
    ? sheet.whole_final_score
    : (positive(sheet.whole_ai_score) ? sheet.whole_ai_score : sheet.ai_total);
  return positive(v) ? round2(v) : 0;
}

/** 这张评分单上有几处存疑。整卷答卷只有整卷这一处。 */
function doubtCountOfSheet(sheet) {
  if (!sheet) return 0;
  return wholeModeOf(sheet) ? (sheet.whole_doubt === 1 ? 1 : 0) : doubtCountOf(sheet.id);
}

/** 从队列查询的一行里还原出一张"够用"的评分单对象（避免每人再查一次库）。 */
function sheetOfQueueRow(s) {
  if (!s.sheet_id) return null;
  return {
    id: s.sheet_id,
    whole_mode: s.whole_mode,
    whole_doubt: s.whole_doubt,
    whole_ai_score: s.whole_ai_score,
    whole_final_score: s.whole_final_score,
    ai_total: s.ai_total,
  };
}

/** 库里存的错题清单：坏了就当空数组，绝不让它把批改页搞崩 */
function safeWrong(text) {
  try {
    return normalizeWrongList(JSON.parse(text || '[]'));
  } catch (_) {
    return [];
  }
}

/** 解析 JSON 数字数组（AI 分配的小题分值），坏数据当空 */
function safeNumberArray(text) {
  try {
    const v = JSON.parse(text || 'null');
    if (!Array.isArray(v)) return [];
    return v.map((n) => {
      const num = Number(n);
      return Number.isFinite(num) && num >= 0 ? round2(num) : 0;
    });
  } catch (_) {
    return [];
  }
}

function queueItems(paperId, filter) {
  const submissions = all(
    `SELECT s.id AS submission_id, s.status AS submission_status, s.submitted_at,
            st.id AS student_id, st.name, st.sno, st.class_name,
            gs.id AS sheet_id, gs.status AS grade_status,
            gs.whole_mode, gs.whole_doubt, gs.whole_ai_score, gs.whole_final_score, gs.ai_total
       FROM submissions s
       JOIN students st ON st.id = s.student_id
  LEFT JOIN grade_sheets gs ON gs.submission_id = s.id
      WHERE s.paper_id = ?
      ORDER BY st.class_name, st.sno, st.name, s.id`,
    paperId
  );

  let items = submissions.map((s) => {
    const sheet = sheetOfQueueRow(s);
    return {
      submissionId: s.submission_id,
      studentId: s.student_id,
      studentName: s.name,
      sno: s.sno || '',
      className: s.class_name || '',
      submissionStatus: s.submission_status,
      gradeSheetId: s.sheet_id,
      gradeStatus: s.grade_status || 'ungraded',
      // 整份图片作答的答卷（整卷一个总分），前端据此换一套批改界面
      whole: wholeModeOf(sheet),
      doubtCount: doubtCountOfSheet(sheet),
      total: sheet && s.grade_status === 'confirmed' ? sheetTotal(sheet) : null,
    };
  });

  if (filter === 'pending') {
    items = items.filter((i) => i.submissionStatus === 'submitted' && i.gradeStatus === 'ungraded');
  } else if (filter === 'to_confirm') {
    items = items.filter((i) => i.gradeStatus === 'ai_done');
  } else if (filter === 'doubt') {
    items = items.filter((i) => i.doubtCount > 0 && i.gradeStatus !== 'confirmed');
  }

  items = items.map((i, idx) => ({ ...i, seq: idx + 1 }));

  const allItems = submissions.map((s) => {
    const sheet = sheetOfQueueRow(s);
    return {
      status: s.grade_status || 'ungraded',
      submissionStatus: s.submission_status,
      doubt: doubtCountOfSheet(sheet),
    };
  });

  return {
    items,
    total: items.length,
    counts: {
      all: allItems.length,
      pending: allItems.filter((i) => i.submissionStatus === 'submitted' && i.status === 'ungraded').length,
      toConfirm: allItems.filter((i) => i.status === 'ai_done').length,
      doubt: allItems.filter((i) => i.doubt > 0 && i.status !== 'confirmed').length,
      confirmed: allItems.filter((i) => i.status === 'confirmed').length,
      absent: allItems.filter((i) => i.submissionStatus === 'absent').length,
    },
  };
}

function gradeDetail(submissionId) {
  const { submission, paper, student, questions } = loadContext(submissionId);
  const sheet = get('SELECT * FROM grade_sheets WHERE submission_id = ?', submissionId);
  const items = sheet
    ? all('SELECT * FROM grade_items WHERE grade_sheet_id = ? ORDER BY id', sheet.id)
    : [];
  // 整份图片作答：这组照片就是这名学生的整张答题卡，不挂到任何题目上
  const wholePaths = wholeImagesOf(submission);
  const isWhole = wholePaths.length > 0;

  return {
    submission: {
      id: submission.id,
      status: submission.status,
      submittedAt: submission.submitted_at,
      source: submission.source,
    },
    student: {
      id: student ? student.id : null,
      name: student ? student.name : '(已删除)',
      sno: student ? student.sno : '',
      className: student ? student.class_name : '',
    },
    paper: { id: paper.id, name: paper.name, status: paper.status },
    fullMarks: paperFullMarks(paper),
    passLine: passLine(paper),
    // 'whole' = 整份图片作答（整卷一个总分，不拆题）；'perQuestion' = 逐题作答
    kind: isWhole ? 'whole' : 'perQuestion',
    whole: isWhole
      ? {
        imageCount: wholePaths.length,
        images: wholePaths,
        aiScore: sheet && positive(sheet.whole_ai_score) ? round2(sheet.whole_ai_score) : null,
        reason: sheet ? (sheet.whole_reason || '') : '',
        confidence: sheet && positive(sheet.whole_confidence) ? sheet.whole_confidence : null,
        doubt: Boolean(sheet && sheet.whole_doubt),
        finalScore: sheet && positive(sheet.whole_final_score) ? round2(sheet.whole_final_score) : null,
        effectiveScore: sheet ? sheetTotal(sheet) : null,
        // AI 从卷面上读出来的错题清单（题号 + 错在哪），只报错处不给每题分
        wrong: sheet ? safeWrong(sheet.whole_wrong) : [],
      }
      : null,
    gradeSheet: sheet
      ? {
        id: sheet.id,
        status: sheet.status,
        aiTotal: sheet.ai_total === null || sheet.ai_total === undefined ? null : round2(sheet.ai_total),
        finalTotal: sheet.final_total === null || sheet.final_total === undefined ? null : round2(sheet.final_total),
        effectiveTotal: sheetTotal(sheet),
        comment: sheet.comment || '',
        error: sheet.error || '',
        confirmedAt: sheet.confirmed_at,
      }
      : null,
    questions: questions.map((q) => {
      const qItems = items.filter((i) => i.paper_question_id === q.paperQuestionId);
      // 已经批过就以库里记的为准，还没批就按"这一题有没有图片"预告
      const stored = qItems.find((i) => i.mode);
      return {
        paperQuestionId: q.paperQuestionId,
        seq: q.seq,
        points: q.points,
        stem: q.stem,
        refAnswer: q.refAnswer,
        rubricType: q.rubricType,
        rubricText: q.rubricText,
        rubricItems: q.rubricItems,
        answerText: q.answerText,
        answerImages: q.answerImages,
        gradingMode: stored ? stored.mode : gradingModeOf(q),
        items: qItems.map((i) => ({
          id: i.id,
          questionItemId: i.question_item_id,
          mode: i.mode || 'rubric',
          aiScore: i.ai_score === null ? null : round2(i.ai_score),
          aiReason: i.ai_reason || '',
          aiConfidence: i.ai_confidence,
          doubt: i.doubt === 1,
          finalScore: i.final_score === null ? null : round2(i.final_score),
          effectiveScore: round2(
            i.final_score === null || i.final_score === undefined ? i.ai_score : i.final_score
          ),
          teacherNote: i.teacher_note || '',
        })),
        questionTotal: round2(qItems.reduce((sum, i) => {
          const v = i.final_score === null || i.final_score === undefined ? i.ai_score : i.final_score;
          return sum + Number(v || 0);
        }, 0)),
      };
    }),
  };
}

function register(router) {
  router.post('/api/submissions/:id/grade', async (ctx) => {
    const result = await gradeSubmission(ctx, ctx.params.id, { force: Boolean(ctx.body && ctx.body.force) });
    return { ...result, detail: gradeDetail(ctx.params.id) };
  });

  router.get('/api/papers/:pid/queue', (ctx) => {
    paperRow(ctx.params.pid);
    const filter = FILTERS.includes(ctx.query.filter) ? ctx.query.filter : 'all';
    return { filter, ...queueItems(ctx.params.pid, filter) };
  });

  router.get('/api/papers/:pid/queue/:seq', (ctx) => {
    paperRow(ctx.params.pid);
    const filter = FILTERS.includes(ctx.query.filter) ? ctx.query.filter : 'all';
    const queue = queueItems(ctx.params.pid, filter);
    const seq = Number(ctx.params.seq);
    const entry = queue.items.find((i) => i.seq === seq);
    if (!entry) throw new HttpError(404, '队列里没有第 ' + seq + ' 份');
    if (!entry.gradeSheetId) {
      return { entry, queue: { total: queue.total, counts: queue.counts }, detail: null };
    }
    return {
      entry,
      queue: { total: queue.total, counts: queue.counts },
      detail: gradeDetail(entry.submissionId),
    };
  });

  router.put('/api/grade-items/:id', (ctx) => {
    const item = get('SELECT * FROM grade_items WHERE id = ?', ctx.params.id);
    if (!item) throw new HttpError(404, '评分明细不存在');
    const sheet = sheetRow(item.grade_sheet_id);
    if (sheet.status === 'confirmed') {
      throw new HttpError(409, '该答卷已确认锁定，如需修改请先解锁。');
    }
    const body = ctx.body || {};
    let finalScore = item.final_score;
    if (body.finalScore !== undefined && body.finalScore !== null && body.finalScore !== '') {
      const v = Number(body.finalScore);
      if (!Number.isFinite(v) || v < 0) throw new HttpError(400, '分数必须是非负数字');
      const max = get(
        `SELECT COALESCE(pq.points, q.points) AS points
           FROM paper_questions pq JOIN questions q ON q.id = pq.question_id
          WHERE pq.id = ?`,
        item.paper_question_id
      );
      if (item.question_item_id) {
        // 小题满分优先用 AI 分配进试卷的（item_points 按 seq 对齐），没分配过才用评分标准自带值
        const rub = get(
          `SELECT qi.points, qi.seq, pq.item_points
             FROM question_items qi
             JOIN paper_questions pq ON pq.question_id = qi.question_id
            WHERE qi.id = ? AND pq.id = ?`,
          item.question_item_id,
          item.paper_question_id
        );
        let maxPts = rub ? Number(rub.points) : 0;
        if (rub && rub.item_points) {
          const arr = safeNumberArray(rub.item_points);
          const idx = Number(rub.seq) - 1;
          if (arr.length && arr[idx] !== undefined) maxPts = arr[idx];
        }
        if (v > maxPts + 1e-9) {
          throw new HttpError(400, `该项得分不能超过满分 ${maxPts}`);
        }
      } else if (max && v > Number(max.points) + 1e-9) {
        throw new HttpError(400, `该项得分不能超过该题满分 ${max.points}`);
      }
      finalScore = v;
    } else if (body.finalScore === null || body.finalScore === '') {
      finalScore = null;
    }

    const doubt = body.doubt === undefined ? item.doubt : (body.doubt ? 1 : 0);
    const note = body.teacherNote === undefined ? item.teacher_note : String(body.teacherNote);

    run(
      'UPDATE grade_items SET final_score = ?, doubt = ?, teacher_note = ? WHERE id = ?',
      finalScore, doubt, note, item.id
    );
    run('UPDATE grade_sheets SET updated_at = ? WHERE id = ?', nowIso(), sheet.id);
    return { itemId: item.id, effectiveTotal: effectiveTotal(sheet.id) };
  });

  router.put('/api/grade-sheets/:id', (ctx) => {
    const sheet = sheetRow(ctx.params.id);
    if (sheet.status === 'confirmed') {
      throw new HttpError(409, '该答卷已确认锁定，如需修改请先解锁。');
    }
    const body = ctx.body || {};
    const comment = body.comment === undefined ? sheet.comment : String(body.comment);
    run('UPDATE grade_sheets SET comment = ?, updated_at = ? WHERE id = ?', comment, nowIso(), sheet.id);
    return { gradeSheetId: sheet.id, comment };
  });

  /**
   * 整份图片作答的改分：整卷只有一个总分，老师改这一处。
   * 逐题答卷走 /api/grade-items/:id，不要用这个端点。
   */
  router.put('/api/grade-sheets/:id/whole', (ctx) => {
    const sheet = sheetRow(ctx.params.id);
    if (sheet.status === 'confirmed') {
      throw new HttpError(409, '该答卷已确认锁定，如需修改请先解锁。');
    }
    if (!wholeModeOf(sheet)) {
      throw new HttpError(409, '这份答卷是逐题批改的，请改各题的分数。');
    }
    const submission = get('SELECT * FROM submissions WHERE id = ?', sheet.submission_id);
    const paper = paperRow(submission.paper_id);
    const fullMarks = paperFullMarks(paper);
    const body = ctx.body || {};

    let finalScore = sheet.whole_final_score;
    if (body.finalScore !== undefined) {
      if (body.finalScore === null || body.finalScore === '') {
        finalScore = null;
      } else {
        const v = Number(body.finalScore);
        if (!Number.isFinite(v) || v < 0) throw new HttpError(400, '分数必须是非负数字');
        if (v > fullMarks + 1e-9) throw new HttpError(400, `整卷分数不能超过满分 ${fullMarks}`);
        finalScore = v;
      }
    }
    const doubt = body.doubt === undefined ? sheet.whole_doubt : (body.doubt ? 1 : 0);
    const reason = body.reason === undefined ? (sheet.whole_reason || '') : String(body.reason);
    const comment = body.comment === undefined ? (sheet.comment || '') : String(body.comment);
    // 错题清单允许老师整份覆盖：AI 认错了题号可以删掉，自己也能补一条
    const wrong = body.wrong === undefined ? safeWrong(sheet.whole_wrong) : normalizeWrongList(body.wrong);

    // 补/删错题后，AI 分跟着扣分重算：whole_ai_score = 满分 − 各错题扣分之和。
    // 只重算 AI 分，不碰老师的人工分（whole_final_score 若已改过，仍然优先）。
    let aiScore = sheet.whole_ai_score;
    if (body.wrong !== undefined) {
      const deductSum = round2(wrong.reduce((s, w) => s + (Number(w.deduct) || 0), 0));
      aiScore = round2(Math.max(0, fullMarks - Math.min(deductSum, fullMarks)));
    }

    run(
      `UPDATE grade_sheets
          SET whole_final_score = ?, whole_doubt = ?, whole_reason = ?, comment = ?,
              whole_wrong = ?, whole_ai_score = ?, ai_total = ?, updated_at = ?
        WHERE id = ?`,
      finalScore, doubt, reason, comment, JSON.stringify(wrong), aiScore, aiScore, nowIso(), sheet.id
    );
    return {
      gradeSheetId: sheet.id,
      wholeFinalScore: positive(finalScore) ? round2(finalScore) : null,
      aiScore: positive(aiScore) ? round2(aiScore) : null,
      doubt: Boolean(doubt),
      wrong,
      wrongCount: wrong.length,
      effectiveTotal: sheetTotal(sheetRow(sheet.id)),
    };
  });

  router.post('/api/grade-sheets/:id/confirm', (ctx) => {
    const sheet = sheetRow(ctx.params.id);
    if (sheet.status === 'confirmed') throw new HttpError(409, '该答卷已经确认过了。');
    if (sheet.status === 'ungraded') throw new HttpError(409, '这份答卷还没批改，不能确认。');

    const submission = get('SELECT * FROM submissions WHERE id = ?', sheet.submission_id);
    const paper = paperRow(submission.paper_id);

    return tx((db) => {
      const now = nowIso();
      const comment = ctx.body && ctx.body.comment !== undefined ? String(ctx.body.comment) : sheet.comment;
      // 整卷答卷按整卷分落定，逐题答卷还是明细加总
      const total = sheetTotal(sheet);
      db.prepare(
        "UPDATE grade_sheets SET status = 'confirmed', final_total = ?, comment = ?, confirmed_at = ?, updated_at = ? WHERE id = ?"
      ).run(total, comment, now, now, sheet.id);

      // 全部确认后自动把试卷标记为已完成
      const pending = get(
        `SELECT COUNT(*) AS c FROM grade_sheets gs JOIN submissions s ON s.id = gs.submission_id
          WHERE s.paper_id = ? AND s.status = 'submitted' AND gs.status <> 'confirmed'`,
        paper.id
      ).c;
      if (pending === 0 && (paper.status === 'grading' || paper.status === 'collecting' || paper.status === 'open')) {
        db.prepare('UPDATE papers SET status = ?, updated_at = ? WHERE id = ?').run('done', now, paper.id);
      }
      return { gradeSheetId: sheet.id, status: 'confirmed', finalTotal: total, paperStatus: get('SELECT status FROM papers WHERE id = ?', paper.id).status };
    });
  });

  router.post('/api/grade-sheets/:id/unlock', (ctx) => {
    const sheet = sheetRow(ctx.params.id);
    if (sheet.status !== 'confirmed') throw new HttpError(409, '只有已确认锁定的答卷才需要解锁。');
    return tx((db) => {
      const now = nowIso();
      db.prepare(
        "UPDATE grade_sheets SET status = 'ai_done', final_total = NULL, confirmed_at = NULL, updated_at = ? WHERE id = ?"
      ).run(now, sheet.id);
      db.prepare(
        "INSERT INTO audit_log(entity, entity_id, action, detail, created_at) VALUES('grade_sheet', ?, 'unlock', ?, ?)"
      ).run(sheet.id, ctx.body && ctx.body.reason ? String(ctx.body.reason) : '', now);

      const submission = get('SELECT * FROM submissions WHERE id = ?', sheet.submission_id);
      const paper = get('SELECT * FROM papers WHERE id = ?', submission.paper_id);
      if (paper && paper.status === 'done') {
        db.prepare('UPDATE papers SET status = ?, updated_at = ? WHERE id = ?').run('grading', now, paper.id);
      }
      return { gradeSheetId: sheet.id, status: 'ai_done' };
    });
  });
}

module.exports = {
  register, gradeDetail, queueItems, effectiveTotal, sheetTotal, wholeModeOf, doubtCountOfSheet,
};
