'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const { all, get, getDb, tx, nowIso } = require('../db');
const { HttpError } = require('../router');
const { round2, paperFullMarks, passLine } = require('../lib/calc');
const { parseLoose } = require('../lib/json');
const {
  buildGradeMessages, buildAutoGradeMessages, buildWholeGradeMessages, normalizeWrongList,
} = require('../lib/prompts');
const { runChat } = require('../ai/qwen');
const { effectiveConfig } = require('../config');

const MIME_BY_EXT = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
};

/** 把本机附件转成 AI 可直接读取的 data URL */
function toDataUrl(ctx, relativePath) {
  const file = path.join(ctx.attachmentsDir, relativePath);
  if (!fs.existsSync(file)) return null;
  const ext = path.extname(file).toLowerCase();
  const mime = MIME_BY_EXT[ext] || 'image/jpeg';
  return 'data:' + mime + ';base64,' + fs.readFileSync(file).toString('base64');
}

/**
 * 一组图片的「内容指纹」：同一张答题卡的照片（哪怕文件名不同）指纹一样。
 * 用它去重复用判分结果，让"两次上传同样的照片"得到一致分数。
 */
function imagesHash(images) {
  const h = crypto.createHash('md5');
  (images || []).forEach((url) => h.update(String(url)));
  return h.digest('hex');
}

/** 正在批改中的图片指纹 → 它的 Promise。并行批改时，同图的几份要等第一份判完再复用。 */
const inFlight = new Map();

function safeImages(text) {
  try {
    const v = JSON.parse(text);
    return Array.isArray(v) ? v : [];
  } catch (_) {
    return [];
  }
}

/** 解析 JSON 数字数组（AI 分配的每小题分值），坏数据一律当空 */
function parseNumberArray(text) {
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

/** 取一份答卷参与批改的全部信息 */
function loadContext(submissionId) {
  const submission = get('SELECT * FROM submissions WHERE id = ?', submissionId);
  if (!submission) throw new HttpError(404, '答卷不存在');
  const paper = get('SELECT * FROM papers WHERE id = ?', submission.paper_id);
  const student = get('SELECT * FROM students WHERE id = ?', submission.student_id);
  const rows = all(
    `SELECT pq.id AS pq_id, pq.seq, pq.question_id,
            COALESCE(pq.points, q.points) AS points,
            pq.item_points AS pq_item_points,
            q.stem, q.ref_answer, q.rubric_type, q.rubric_text, q.stem_images,
            a.text AS answer_text, a.images AS answer_images
       FROM paper_questions pq
       JOIN questions q ON q.id = pq.question_id
  LEFT JOIN answers a ON a.paper_question_id = pq.id AND a.submission_id = ?
      WHERE pq.paper_id = ?
      ORDER BY pq.seq`,
    submissionId,
    submission.paper_id
  );

  const questions = rows.map((r) => {
    // 小题分值优先用 AI 分配进试卷的（item_points），没分配过就回退评分标准自带的
    const allocated = parseNumberArray(r.pq_item_points);
    const rubricItems = r.rubric_type === 'items'
      ? all('SELECT id, seq, text, points FROM question_items WHERE question_id = ? ORDER BY seq', r.question_id)
        .map((it, i) => ({ id: it.id, text: it.text, points: round2(allocated.length ? allocated[i] : it.points) }))
      : [];
    return {
      paperQuestionId: r.pq_id,
      seq: r.seq,
      points: round2(r.points || 0),
      stem: r.stem,
      refAnswer: r.ref_answer || '',
      rubricType: r.rubric_type,
      rubricText: r.rubric_text || '',
      rubricItems,
      answerText: r.answer_text || '',
      answerImages: safeImages(r.answer_images),
    };
  });

  return { submission, paper, student, questions };
}

/**
 * 这一题该怎么判分。
 * 学生交的是图片（手写/拍照）→ 'auto'：不看评分标准，AI 直接看图自主判分。
 * 纯文字作答 → 'rubric'：还是老实按评分标准逐条对照。
 */
function gradingModeOf(question) {
  return (question.answerImages && question.answerImages.length) ? 'auto' : 'rubric';
}

/**
 * 这份答卷交的是「整份图片」吗。
 * 老师把整张答题卡拍照交上来、不拆题不挂题目时，就只能按整卷给一个总分。
 */
function wholeImagesOf(submission) {
  return safeImages(submission && submission.images);
}

/** 归一化 AI 返回的逐项判分 */
function normalizeItems(parsed, question, doubtThreshold, mode) {
  if (!parsed || !Array.isArray(parsed.items)) {
    throw new HttpError(502, 'AI 没有返回可解析的逐项评分结果');
  }
  const expected = mode === 'auto'
    ? [{ id: null, text: 'AI 自主评判', points: question.points }]
    : (question.rubricType === 'items'
      ? question.rubricItems
      : [{ id: null, text: question.rubricText || '整体给分', points: question.points }]);

  const byIndex = new Map();
  parsed.items.forEach((raw, i) => {
    const idx = raw && raw.index !== undefined && raw.index !== null ? Number(raw.index) : i;
    if (!byIndex.has(idx)) byIndex.set(idx, raw);
  });

  return expected.map((exp, idx) => {
    const raw = byIndex.get(idx);
    if (!raw) {
      return {
        questionItemId: exp.id,
        aiScore: 0,
        aiReason: 'AI 未返回这一项的评分，请人工判定',
        aiConfidence: 0,
        doubt: 1,
      };
    }
    let score = Number(raw.score);
    if (!Number.isFinite(score)) score = 0;
    score = Math.min(Math.max(score, 0), Number(exp.points) || 0);
    let confidence = Number(raw.confidence);
    if (!Number.isFinite(confidence)) confidence = 1;
    confidence = Math.min(Math.max(confidence, 0), 1);
    return {
      questionItemId: exp.id,
      aiScore: round2(score),
      aiReason: String(raw.reason || '').slice(0, 2000),
      aiConfidence: confidence,
      doubt: confidence < doubtThreshold ? 1 : 0,
    };
  });
}

function ensureSheet(submissionId) {
  const existing = get('SELECT * FROM grade_sheets WHERE submission_id = ?', submissionId);
  if (existing) return existing;
  const now = nowIso();
  const info = getDb().prepare(
    'INSERT INTO grade_sheets(submission_id, status, created_at, updated_at) VALUES(?,?,?,?)'
  ).run(submissionId, 'ungraded', now, now);
  return get('SELECT * FROM grade_sheets WHERE id = ?', Number(info.lastInsertRowid));
}

/**
 * 整份图片作答的批改：一次调用，给整卷一个总分 + 一份「错题清单」。
 * 这一路**不产生逐题明细**（拿不到可靠题号，硬拆只会编造），所以写入时会先清空明细。
 * 错题清单报「哪一题、扣多少分、错在哪一处、错成了什么」，
 * 总分 = 满分 − 各错题扣分之和（扣分参与总分计算，逐题可核对）。
 */
async function gradeWholeSubmission(ctx, { submission, paper, wholePaths, fullMarks, doubtThreshold, force }) {
  const images = wholePaths.map((p) => toDataUrl(ctx, p)).filter(Boolean);
  if (!images.length) {
    throw new HttpError(400, '这份答卷的图片都找不到了，请让老师重新上传。');
  }
  const imageHash = imagesHash(images);

  // 同一张照片正在被另一份答卷批改：等它判完（并行批改时避免同图各自独立判分）
  if (!force) {
    const pending = inFlight.get(imageHash);
    if (pending) await pending.catch(() => {});
  }

  // 同一张照片（内容相同）批过一次就复用那次结果，不再让 AI 重判，
  // 这样"两次上传同样的照片"能得到一致分数。老师要强制重批时才带 force。
  const reuseTarget = !force
    ? get(
      `SELECT * FROM grade_sheets
        WHERE whole_image_hash = ? AND status IN ('ai_done','confirmed') AND submission_id != ?
        ORDER BY id DESC LIMIT 1`,
      imageHash, submission.id
    )
    : null;

  let confidence;
  let reason;
  let comment;
  let wrong;
  if (reuseTarget) {
    confidence = reuseTarget.whole_confidence;
    reason = reuseTarget.whole_reason || '';
    comment = reuseTarget.comment || '';
    let rawWrong = [];
    try { rawWrong = JSON.parse(reuseTarget.whole_wrong || '[]'); } catch (_) { rawWrong = []; }
    wrong = normalizeWrongList(rawWrong);
  } else {
    // 把 AI 调用登记进 in-flight：同图第二份进来时会等这份判完再复用，不会各自判出两个分
    const task = (async () => {
      const messages = buildWholeGradeMessages({
        paperName: paper.name,
        fullMarks,
        passLine: passLine(paper),
        answer: { images },
      });
      const raw = await runChat(ctx, messages);
      const parsed = parseLoose(raw);
      if (!parsed) {
        throw new HttpError(502, 'AI 返回的整卷评分无法解析：' + String(raw).slice(0, 120));
      }
      return parsed;
    })();
    inFlight.set(imageHash, task);
    let parsed;
    try {
      parsed = await task;
    } finally {
      inFlight.delete(imageHash);
    }
    confidence = Number(parsed.confidence);
    if (!Number.isFinite(confidence)) confidence = 1;
    confidence = Math.min(Math.max(confidence, 0), 1);
    reason = String(parsed.reason || '').slice(0, 2000);
    comment = String(parsed.comment || '').slice(0, 1000);
    wrong = normalizeWrongList(parsed.wrong);
  }

  // 扣分参与总分：总分 = 满分 − 各错题扣分之和（逐题可核对，也消除同图分数波动）
  const deductSum = round2(wrong.reduce((s, w) => s + (Number(w.deduct) || 0), 0));
  const score = round2(Math.max(0, fullMarks - Math.min(deductSum, fullMarks)));
  const doubt = confidence < doubtThreshold ? 1 : 0;

  return tx((db) => {
    const now = nowIso();
    const sheet = get('SELECT * FROM grade_sheets WHERE submission_id = ?', submission.id);
    // 整卷评分和逐题明细互斥：这条路不逐题打分，就一条明细都不留
    db.prepare('DELETE FROM grade_items WHERE grade_sheet_id = ?').run(sheet.id);
    db.prepare(
      `UPDATE grade_sheets
          SET status = 'ai_done', ai_total = ?, error = '', comment = ?,
              whole_mode = 'auto', whole_ai_score = ?, whole_reason = ?, whole_confidence = ?,
              whole_doubt = ?, whole_final_score = NULL, whole_wrong = ?, whole_image_hash = ?, updated_at = ?
        WHERE id = ?`
    ).run(score, comment, score, reason, confidence, doubt, JSON.stringify(wrong), imageHash, now, sheet.id);

    if (paper.status === 'open' || paper.status === 'collecting') {
      db.prepare('UPDATE papers SET status = ?, updated_at = ? WHERE id = ?').run('grading', now, paper.id);
    }

    return {
      gradeSheetId: sheet.id,
      status: 'ai_done',
      aiTotal: score,
      whole: true,
      imageCount: wholePaths.length,
      doubt: Boolean(doubt),
      reused: Boolean(reuseTarget),
      wrong,
      wrongCount: wrong.length,
      comments: [],
    };
  });
}

/**
 * 对一份答卷做 AI 批改：逐题调用，全部成功才写入。
 * 任何一题失败都会抛出，不会留下半份脏数据。
 * 若这份答卷交的是「整份图片」（不挂题目），则整卷一次给出总分。
 */
async function gradeSubmission(ctx, submissionId, options) {
  const opts = options || {};
  const { submission, paper, questions } = loadContext(submissionId);
  const existing = ensureSheet(submissionId);

  if (existing.status === 'confirmed' && !opts.force) {
    throw new HttpError(409, '该答卷已确认锁定，如需重批请先解锁。');
  }
  if (submission.status === 'absent') {
    throw new HttpError(409, '该学生被标记为缺考，无需批改。');
  }

  const cfg = effectiveConfig(ctx.configDir);
  const doubtThreshold = Number.isFinite(Number(cfg.doubtThreshold)) ? Number(cfg.doubtThreshold) : 0.75;
  // 整卷满分：有题目按题目分值之和，无题卷用卷上设的整卷满分
  const fullMarks = paperFullMarks(paper);

  // 整份图片作答：整卷给一个总分，不逐题。
  // 这条分支**不看卷子有没有题目** —— 「图片答卷」本来就是"老师不用出题、
  // 直接收整卷照片让 AI 给一个总分"的那条路，无题卷反而是常态。
  const wholePaths = wholeImagesOf(submission);
  if (wholePaths.length) {
    return gradeWholeSubmission(ctx, { submission, paper, wholePaths, fullMarks, doubtThreshold, force: opts.force });
  }

  // 走到这儿是逐题作答：没有题目就没得批
  if (!questions.length) {
    throw new HttpError(400, '这份试卷还没有题目。');
  }

  const results = [];
  for (const question of questions) {
    const mode = gradingModeOf(question);
    const imageUrls = question.answerImages
      .map((p) => toDataUrl(ctx, p))
      .filter(Boolean);
    // 图片作答：不看评分标准，让 AI 直接看图自己判；文字作答：照旧逐条对照
    const messages = mode === 'auto'
      ? buildAutoGradeMessages({
        stem: question.stem,
        refAnswer: question.refAnswer,
        points: question.points,
        seq: question.seq,
        answer: { text: question.answerText, images: imageUrls },
      })
      : buildGradeMessages({
        stem: question.stem,
        refAnswer: question.refAnswer,
        rubricType: question.rubricType,
        rubricText: question.rubricText,
        items: question.rubricItems.length ? question.rubricItems : { points: question.points },
        answer: { text: question.answerText, images: imageUrls },
      });
    const raw = await runChat(ctx, messages);
    const parsed = parseLoose(raw);
    if (!parsed) {
      throw new HttpError(502, `AI 返回的评分结果无法解析（第 ${question.seq} 题）：${String(raw).slice(0, 120)}`);
    }
    results.push({
      question,
      mode,
      items: normalizeItems(parsed, question, doubtThreshold, mode),
      comment: String(parsed.comment || '').slice(0, 1000),
    });
  }

  const total = round2(
    results.reduce((sum, r) => sum + r.items.reduce((s, it) => s + it.aiScore, 0), 0)
  );

  return tx((db) => {
    const now = nowIso();
    const sheet = get('SELECT * FROM grade_sheets WHERE submission_id = ?', submissionId);
    db.prepare('DELETE FROM grade_items WHERE grade_sheet_id = ?').run(sheet.id);
    const stmt = db.prepare(
      `INSERT INTO grade_items(grade_sheet_id, paper_question_id, question_item_id, mode,
                               ai_score, ai_reason, ai_confidence, doubt, final_score, teacher_note)
       VALUES(?,?,?,?,?,?,?,?,NULL,'')`
    );
    results.forEach((r) => {
      r.items.forEach((it) => {
        stmt.run(
          sheet.id, r.question.paperQuestionId, it.questionItemId, r.mode,
          it.aiScore, it.aiReason, it.aiConfidence, it.doubt
        );
      });
    });
    db.prepare(
      `UPDATE grade_sheets
          SET status = 'ai_done', ai_total = ?, error = '',
              whole_mode = '', whole_ai_score = NULL, whole_reason = '',
              whole_confidence = NULL, whole_doubt = 0, whole_final_score = NULL,
              whole_wrong = '[]',
              updated_at = ?
        WHERE id = ?`
    ).run(total, now, sheet.id);

    if (paper.status === 'open' || paper.status === 'collecting') {
      db.prepare('UPDATE papers SET status = ?, updated_at = ? WHERE id = ?').run('grading', now, paper.id);
    }

    return {
      gradeSheetId: sheet.id,
      status: 'ai_done',
      aiTotal: total,
      comments: results.map((r) => ({ paperQuestionId: r.question.paperQuestionId, comment: r.comment })),
    };
  });
}

module.exports = {
  gradeSubmission, loadContext, normalizeItems, toDataUrl, ensureSheet, gradingModeOf,
  wholeImagesOf, gradeWholeSubmission,
};
