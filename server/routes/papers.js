'use strict';

const { all, get, run, tx, nowIso } = require('../db');
const { HttpError } = require('../router');
const {
  paperQuestionRows, paperFullMarks, passLine, round2, distributeEvenly,
} = require('../lib/calc');
const { purgePaper } = require('../lib/cascade');
const { runChat } = require('../ai/qwen');
const { effectiveConfig } = require('../config');
const { parseLoose } = require('../lib/json');
const { buildAllocateMessages, normalizeAllocation } = require('../lib/prompts');

const STATUSES = ['draft', 'open', 'collecting', 'grading', 'done'];

const TRANSITIONS = {
  publish: { from: ['draft'], to: 'open' },
  withdraw: { from: ['open', 'collecting'], to: 'draft' },
  'start-grading': { from: ['open', 'collecting', 'grading'], to: 'grading' },
  complete: { from: ['open', 'collecting', 'grading'], to: 'done' },
  reopen: { from: ['done'], to: 'grading' },
};

function toPaper(row, extra) {
  return {
    id: row.id,
    name: row.name,
    status: row.status,
    passLine: row.pass_line || 0,
    // 整卷满分：只在「没有题目」的卷子上生效（图片答卷），有题目时前端按题目总分显示
    wholeFullMarks: row.whole_full_marks === null || row.whole_full_marks === undefined
      ? null
      : Number(row.whole_full_marks),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    ...(extra || {}),
  };
}

/** 收「整卷满分」这个入参：空串/缺省都算"没设"，非法值直接拦下 */
function readWholeFullMarks(body, fallback) {
  if (body.wholeFullMarks === undefined || body.wholeFullMarks === null || body.wholeFullMarks === '') {
    return fallback;
  }
  const v = Number(body.wholeFullMarks);
  if (!Number.isFinite(v) || v <= 0) throw new HttpError(400, '整卷满分必须是大于 0 的数字');
  return v;
}

function paperRow(id) {
  const row = get('SELECT * FROM papers WHERE id = ?', id);
  if (!row) throw new HttpError(404, '试卷不存在');
  return row;
}

function progressOf(paperId) {
  const questionCount = get('SELECT COUNT(*) AS c FROM paper_questions WHERE paper_id = ?', paperId).c;
  // 整卷满分：有题目 = 各题分值之和；无题卷（图片答卷）= 卷上设的整卷满分
  const row = paperRow(paperId);
  const total = paperFullMarks(row);
  const submissionCount = get("SELECT COUNT(*) AS c FROM submissions WHERE paper_id = ? AND status = 'submitted'", paperId).c;
  const absentCount = get("SELECT COUNT(*) AS c FROM submissions WHERE paper_id = ? AND status = 'absent'", paperId).c;
  const studentCount = get('SELECT COUNT(*) AS c FROM students').c;
  const ungraded = get(
    `SELECT COUNT(*) AS c FROM grade_sheets gs
       JOIN submissions s ON s.id = gs.submission_id
      WHERE s.paper_id = ? AND gs.status = 'ungraded' AND s.status = 'submitted'`,
    paperId
  ).c;
  const toConfirm = get(
    `SELECT COUNT(*) AS c FROM grade_sheets gs
       JOIN submissions s ON s.id = gs.submission_id
      WHERE s.paper_id = ? AND gs.status = 'ai_done'`,
    paperId
  ).c;
  const confirmed = get(
    `SELECT COUNT(*) AS c FROM grade_sheets gs
       JOIN submissions s ON s.id = gs.submission_id
      WHERE s.paper_id = ? AND gs.status = 'confirmed'`,
    paperId
  ).c;
  // 存疑 = 逐题明细里的存疑点 + 整卷答卷上的整卷存疑
  const doubt = get(
    `SELECT
       IFNULL((SELECT COUNT(*) FROM grade_items gi
                 JOIN grade_sheets gs ON gs.id = gi.grade_sheet_id
                 JOIN submissions s ON s.id = gs.submission_id
                WHERE s.paper_id = ? AND gi.doubt = 1 AND gs.status <> 'confirmed'), 0)
     + IFNULL((SELECT COUNT(*) FROM grade_sheets gs
                 JOIN submissions s ON s.id = gs.submission_id
                WHERE s.paper_id = ? AND gs.whole_doubt = 1 AND gs.status <> 'confirmed'), 0) AS c`,
    paperId,
    paperId
  ).c;
  return {
    questionCount,
    total: round2(total),
    passLine: passLine(row),
    studentCount,
    submissionCount,
    absentCount,
    graded: confirmed + toConfirm,
    ungraded,
    toConfirm,
    confirmed,
    doubt,
    progressPercent: studentCount ? Math.round(((confirmed + toConfirm) / studentCount) * 100) : 0,
  };
}

function paperQuestions(paperId) {
  return paperQuestionRows(paperId).map((r) => {
    const base = {
      paperQuestionId: r.id,
      questionId: r.question_id,
      seq: r.seq,
      points: round2(r.points || 0),
      pointsOverridden: r.points !== null && r.points !== undefined,
      stem: r.stem,
      refAnswer: r.ref_answer,
      rubricType: r.rubric_type,
      rubricText: r.rubric_text,
      difficulty: r.difficulty,
      subject: r.subject,
      knowledge: r.knowledge,
      qtype: r.qtype,
    };
    // 分项得分点的题：把每个得分点（小题）都带出来，分值优先用分配后的（item_points）
    if (r.rubric_type === 'items') {
      const items = all(
        'SELECT id, seq, text, points FROM question_items WHERE question_id = ? ORDER BY seq',
        r.question_id
      );
      const allocated = safeNumbers(r.item_points);
      base.itemPoints = allocated.length ? allocated : null;
      base.rubricItems = items.map((it, i) => ({
        text: it.text,
        points: round2(allocated.length ? allocated[i] : it.points),
      }));
    } else {
      base.itemPoints = null;
      base.rubricItems = [];
    }
    return base;
  });
}

/** 解析 JSON 数字数组，坏数据一律当空 */
function safeNumbers(text) {
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

/** 一道大题的得分点个数（text 类型没有小题，返回 0） */
function itemCountOf(row) {
  if (row.rubric_type !== 'items') return 0;
  return get('SELECT COUNT(*) AS c FROM question_items WHERE question_id = ?', row.question_id).c;
}

/**
 * 把整卷总分按权重分到每道大题（AI 做），再平均分到每小题（算法做），写进 paper_questions。
 * 返回分配结果，供前端展示与老师手改。
 */
async function allocateInto(ctx, paperId, fullMarks) {
  const rows = paperQuestionRows(paperId);
  if (!rows.length) return { fullMarks: round2(fullMarks), questions: [] };

  const questions = rows.map((r) => ({
    seq: r.seq,
    paperQuestionId: r.id,
    stem: r.stem,
    refAnswer: r.ref_answer,
    rubricType: r.rubric_type,
    rubricText: r.rubric_text,
    itemCount: itemCountOf(r),
  }));

  const messages = buildAllocateMessages({ fullMarks, questions });
  const raw = await runChat(ctx, messages);
  const parsed = parseLoose(raw);
  const allocations = normalizeAllocation(parsed, fullMarks, questions);
  const bySeq = new Map(allocations.map((a) => [a.seq, a.points]));

  const perQuestion = questions.map((q) => {
    const points = bySeq.has(q.seq) ? bySeq.get(q.seq) : 0;
    const itemPoints = q.itemCount > 0 ? distributeEvenly(points, q.itemCount) : null;
    return {
      paperQuestionId: q.paperQuestionId,
      seq: q.seq,
      points: round2(points),
      itemPoints,
    };
  });

  tx((db) => {
    const stmt = db.prepare('UPDATE paper_questions SET points = ?, item_points = ? WHERE id = ?');
    perQuestion.forEach((p) => {
      stmt.run(p.points, p.itemPoints === null ? null : JSON.stringify(p.itemPoints), p.paperQuestionId);
    });
  });

  return { fullMarks: round2(fullMarks), questions: perQuestion };
}

/** 按每题当前的大题分，把小题分值重算成平均（老师手改大题分后，小题跟着平均） */
function recomputeItemPoints(paperId) {
  const rows = paperQuestionRows(paperId);
  tx((db) => {
    const stmt = db.prepare('UPDATE paper_questions SET item_points = ? WHERE id = ?');
    rows.forEach((r) => {
      const itemPoints = itemCountOf(r) > 0
        ? distributeEvenly(round2(r.points || 0), itemCountOf(r))
        : null;
      stmt.run(itemPoints === null ? null : JSON.stringify(itemPoints), r.id);
    });
  });
}

function assertDraft(paper) {
  if (paper.status !== 'draft') {
    throw new HttpError(409, '试卷已发布，题目已锁定。请先撤回为草稿再修改。');
  }
}

function register(router) {
  router.get('/api/papers', () => {
    const rows = all('SELECT * FROM papers ORDER BY id DESC');
    return {
      papers: rows.map((r) => toPaper(r, { progress: progressOf(r.id) })),
      total: rows.length,
    };
  });

  router.post('/api/papers', (ctx) => {
    const body = ctx.body || {};
    const name = String(body.name || '').trim();
    if (!name) throw new HttpError(400, '试卷名称不能为空');
    const passLineValue = body.passLine === undefined || body.passLine === '' ? 0 : Number(body.passLine);
    if (!Number.isFinite(passLineValue) || passLineValue < 0) throw new HttpError(400, '及格线必须是非负数字');
    const wholeFullMarks = readWholeFullMarks(body, null);
    const now = nowIso();
    const info = run(
      'INSERT INTO papers(name, status, pass_line, whole_full_marks, created_at, updated_at) VALUES(?,?,?,?,?,?)',
      name, 'draft', passLineValue, wholeFullMarks, now, now
    );
    const row = paperRow(info.lastInsertRowid);
    return { paper: toPaper(row, { progress: progressOf(row.id) }) };
  });

  router.get('/api/papers/:id', (ctx) => {
    const row = paperRow(ctx.params.id);
    return {
      paper: toPaper(row, { progress: progressOf(row.id) }),
      questions: paperQuestions(row.id),
      // 有题目时就是各题分值之和；无题卷就是它的整卷满分
      total: paperFullMarks(row),
    };
  });

  router.put('/api/papers/:id', (ctx) => {
    const row = paperRow(ctx.params.id);
    const body = ctx.body || {};
    const name = body.name === undefined ? row.name : String(body.name).trim();
    if (!name) throw new HttpError(400, '试卷名称不能为空');
    const passLineValue = body.passLine === undefined || body.passLine === ''
      ? (row.pass_line || 0)
      : Number(body.passLine);
    if (!Number.isFinite(passLineValue) || passLineValue < 0) throw new HttpError(400, '及格线必须是非负数字');
    const wholeFullMarks = readWholeFullMarks(body, row.whole_full_marks === undefined ? null : row.whole_full_marks);
    run(
      'UPDATE papers SET name = ?, pass_line = ?, whole_full_marks = ?, updated_at = ? WHERE id = ?',
      name, passLineValue, wholeFullMarks, nowIso(), row.id
    );
    return { paper: toPaper(paperRow(row.id), { progress: progressOf(row.id) }) };
  });

  router.put('/api/papers/:id/questions', async (ctx) => {
    const paper = paperRow(ctx.params.id);
    assertDraft(paper);
    const body = ctx.body || {};
    const list = body.questions;
    if (!Array.isArray(list)) throw new HttpError(400, 'questions 必须是数组');
    // 老师有没有手动指定大题分值（有的话就不该让 AI 覆盖）
    const bodyHasPoints = list.some(
      (it) => it && it.points !== null && it.points !== undefined && it.points !== ''
    );
    list.forEach((item, idx) => {
      const qid = Number(item && item.questionId);
      if (!Number.isFinite(qid)) throw new HttpError(400, `第 ${idx + 1} 项缺少 questionId`);
      if (!get('SELECT id FROM questions WHERE id = ?', qid)) {
        throw new HttpError(400, `第 ${idx + 1} 项引用的题目不存在（id=${qid}）`);
      }
      if (item.points !== null && item.points !== undefined && item.points !== '') {
        const p = Number(item.points);
        if (!Number.isFinite(p) || p <= 0) throw new HttpError(400, `第 ${idx + 1} 项的分值必须大于 0`);
      }
    });
    const seen = new Set();
    list.forEach((item) => {
      const qid = Number(item.questionId);
      if (seen.has(qid)) throw new HttpError(400, '同一道题不能在一份试卷里重复出现');
      seen.add(qid);
    });

    tx((db) => {
      db.prepare('DELETE FROM paper_questions WHERE paper_id = ?').run(paper.id);
      const stmt = db.prepare('INSERT INTO paper_questions(paper_id, question_id, seq, points, item_points) VALUES(?,?,?,?,?)');
      list.forEach((item, idx) => {
        const override = item.points === null || item.points === undefined || item.points === ''
          ? null
          : Number(item.points);
        stmt.run(paper.id, Number(item.questionId), idx + 1, override, null);
      });
      db.prepare('UPDATE papers SET updated_at = ? WHERE id = ?').run(nowIso(), paper.id);
    });

    // 老师设了整卷总分、又没有手动指定大题分 → AI 自动分一次（权重到大题、平均到小题）
    const ownMarks = Number(paper.whole_full_marks);
    if (ownMarks > 0 && list.length > 0 && !bodyHasPoints) {
      await allocateInto(ctx, paper.id, ownMarks);
    } else if (list.length > 0 && bodyHasPoints) {
      // 老师手改了大题分：小题分值跟着重算成平均
      recomputeItemPoints(paper.id);
    }

    return {
      questions: paperQuestions(paper.id),
      total: paperFullMarks(paperRow(paper.id)),
      progress: progressOf(paper.id),
    };
  });

  /** 一键让 AI 把整卷总分按权重分到每道大题（再平均到每小题），老师可在此基础上手改 */
  router.post('/api/papers/:id/allocate', async (ctx) => {
    const paper = paperRow(ctx.params.id);
    assertDraft(paper);
    const fullMarks = paperFullMarks(paper);
    const result = await allocateInto(ctx, paper.id, fullMarks);
    return {
      ...result,
      total: paperFullMarks(paperRow(paper.id)),
      questions: paperQuestions(paper.id),
    };
  });

  router.post('/api/papers/:id/:action(publish|withdraw|start-grading|complete|reopen)', (ctx) => {
    const action = ctx.params.action;
    const transition = TRANSITIONS[action];
    if (!transition) throw new HttpError(404, `不支持的操作：${action}`);

    const paper = paperRow(ctx.params.id);
    if (!transition.from.includes(paper.status)) {
      throw new HttpError(
        409,
        `当前状态「${paper.status}」不能执行该操作。允许的状态：${transition.from.join(' / ')}`
      );
    }

    if (action === 'withdraw') {
      const subs = get('SELECT COUNT(*) AS c FROM submissions WHERE paper_id = ?', paper.id).c;
      if (subs > 0) throw new HttpError(409, `该试卷已有 ${subs} 份答卷，不能撤回为草稿。`);
    }
    if (action === 'publish') {
      // 无题卷也允许发布：它是专门用来收「图片答卷」的卷子 —— 老师不用出题，
      // 直接收整卷照片让 AI 给一个总分，满分走 papers.whole_full_marks。
      // 这里不再要求必须有题目（原来那条拦截会把这条路堵死）。
    }
    if (action === 'complete') {
      const pending = get(
        `SELECT COUNT(*) AS c FROM grade_sheets gs JOIN submissions s ON s.id = gs.submission_id
          WHERE s.paper_id = ? AND gs.status = 'ai_done'`,
        paper.id
      ).c;
      if (pending > 0) throw new HttpError(409, `还有 ${pending} 份答卷待确认，全部确认后才能标记完成。`);
    }

    run('UPDATE papers SET status = ?, updated_at = ? WHERE id = ?', transition.to, nowIso(), paper.id);
    const row = paperRow(paper.id);
    return { paper: toPaper(row, { progress: progressOf(row.id) }) };
  });

  router.del('/api/papers/:id', (ctx) => {
    const paper = paperRow(ctx.params.id);
    // 删试卷就把它的题目编排、所有答卷、作答、评分、批量任务一起清掉，不留孤儿数据
    const removed = tx((db) => purgePaper(db, paper.id));
    return { ok: true, deleted: paper.id, removed };
  });

  router.get('/api/papers/:id/progress', (ctx) => {
    paperRow(ctx.params.id);
    return { progress: progressOf(ctx.params.id) };
  });
}

module.exports = { register, STATUSES, TRANSITIONS, progressOf, paperQuestions };
