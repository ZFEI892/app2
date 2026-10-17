'use strict';

const { all, get, run, tx, nowIso } = require('../db');
const { HttpError } = require('../router');
const { round2 } = require('../lib/calc');
const { purgeQuestion } = require('../lib/cascade');

const DIFFICULTIES = ['易', '中', '难'];
const RUBRIC_TYPES = ['items', 'text'];

function toQuestion(row, items) {
  return {
    id: row.id,
    stem: row.stem,
    stemImages: safeJson(row.stem_images, []),
    refAnswer: row.ref_answer || '',
    rubricType: row.rubric_type,
    rubricText: row.rubric_text || '',
    points: round2(row.points || 0),
    subject: row.subject || '',
    knowledge: row.knowledge || '',
    qtype: row.qtype || '',
    difficulty: row.difficulty || '中',
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    items: items || undefined,
  };
}

function safeJson(text, fallback) {
  try {
    const v = JSON.parse(text);
    return Array.isArray(v) ? v : fallback;
  } catch (_) {
    return fallback;
  }
}

function itemsOf(questionId) {
  return all('SELECT id, seq, text, points FROM question_items WHERE question_id = ? ORDER BY seq', questionId)
    .map((r) => ({ id: r.id, seq: r.seq, text: r.text, points: round2(r.points) }));
}

function questionRow(id) {
  const row = get('SELECT * FROM questions WHERE id = ?', id);
  if (!row) throw new HttpError(404, '题目不存在');
  return row;
}

/** 校验并归一化题目输入 */
function normalizePayload(body, base) {
  const src = body || {};
  const pick = (key, fallback) => (src[key] === undefined ? fallback : src[key]);

  const stem = String(pick('stem', base ? base.stem : '')).trim();
  if (!stem) throw new HttpError(400, '题干不能为空');
  if (stem.length > 20000) throw new HttpError(400, '题干过长');

  const rubricType = String(pick('rubricType', base ? base.rubric_type : 'items')).trim();
  if (!RUBRIC_TYPES.includes(rubricType)) throw new HttpError(400, '评分标准类型只能是 items 或 text');

  const difficulty = String(pick('difficulty', base ? base.difficulty : '中')).trim() || '中';
  if (!DIFFICULTIES.includes(difficulty)) throw new HttpError(400, '难度只能是 易 / 中 / 难');

  const difficultyStrict = difficulty;

  const rawItems = src.items !== undefined
    ? src.items
    : (base && base.rubric_type === 'items' ? itemsOf(base.id) : []);

  let items = [];
  let points = 0;
  let rubricText = String(pick('rubricText', base ? base.rubric_text : '')).trim();

  if (rubricType === 'items') {
    if (!Array.isArray(rawItems) || rawItems.length === 0) {
      throw new HttpError(400, '分项得分点模式下至少需要一条得分点');
    }
    items = rawItems.map((raw, idx) => {
      const text = String((raw && raw.text) || '').trim();
      const p = Number((raw && raw.points) === undefined ? NaN : raw.points);
      if (!text) throw new HttpError(400, `第 ${idx + 1} 条得分点内容不能为空`);
      if (!Number.isFinite(p) || p <= 0) throw new HttpError(400, `第 ${idx + 1} 条得分点分值必须大于 0`);
      return { seq: idx + 1, text, points: p };
    });
    points = round2(items.reduce((s, it) => s + it.points, 0));
    rubricText = '';
  } else {
    if (!rubricText) throw new HttpError(400, '一段文字说明模式下必须填写评分说明');
    const p = Number(pick('points', base ? base.points : NaN));
    if (!Number.isFinite(p) || p <= 0) throw new HttpError(400, '题目总分必须大于 0');
    points = round2(p);
    items = [];
  }

  return {
    stem,
    stemImages: safeJson(JSON.stringify(pick('stemImages', base ? safeJson(base.stem_images, []) : [])), []),
    refAnswer: String(pick('refAnswer', base ? base.ref_answer : '')),
    rubricType,
    rubricText,
    points,
    subject: String(pick('subject', base ? base.subject : '')).trim(),
    knowledge: String(pick('knowledge', base ? base.knowledge : '')).trim(),
    qtype: String(pick('qtype', base ? base.qtype : '')).trim(),
    difficulty: difficultyStrict,
    items,
  };
}

function insertQuestion(data) {
  return tx((db) => {
    const now = nowIso();
    const info = db.prepare(
      `INSERT INTO questions(stem, stem_images, ref_answer, rubric_type, rubric_text, points,
                             subject, knowledge, qtype, difficulty, created_at, updated_at)
       VALUES(?,?,?,?,?,?,?,?,?,?,?,?)`
    ).run(
      data.stem, JSON.stringify(data.stemImages), data.refAnswer, data.rubricType,
      data.rubricText, data.points, data.subject, data.knowledge, data.qtype,
      data.difficulty, now, now
    );
    const id = Number(info.lastInsertRowid);
    const stmt = db.prepare('INSERT INTO question_items(question_id, seq, text, points) VALUES(?,?,?,?)');
    data.items.forEach((it) => stmt.run(id, it.seq, it.text, it.points));
    return id;
  });
}

function register(router) {
  router.get('/api/questions/meta', () => {
    const uniq = (col) => all(
      `SELECT DISTINCT ${col} AS v FROM questions WHERE IFNULL(${col}, '') <> '' ORDER BY v`
    ).map((r) => r.v);
    return {
      subjects: uniq('subject'),
      knowledge: uniq('knowledge'),
      qtypes: uniq('qtype'),
      difficulties: DIFFICULTIES,
    };
  });

  router.get('/api/questions', (ctx) => {
    const where = [];
    const params = [];
    const q = String(ctx.query.q || '').trim();
    if (q) {
      where.push('(stem LIKE ? OR ref_answer LIKE ? OR rubric_text LIKE ?)');
      const like = `%${q}%`;
      params.push(like, like, like);
    }
    ['subject', 'knowledge', 'qtype', 'difficulty'].forEach((field) => {
      const v = String(ctx.query[field] || '').trim();
      if (v) {
        where.push(`${field} = ?`);
        params.push(v);
      }
    });
    const sql =
      'SELECT * FROM questions' +
      (where.length ? ' WHERE ' + where.join(' AND ') : '') +
      ' ORDER BY id DESC';
    const rows = all(sql, ...params);

    const usedCount = all('SELECT question_id, COUNT(*) AS c FROM paper_questions GROUP BY question_id')
      .reduce((acc, r) => { acc[r.question_id] = r.c; return acc; }, {});

    return {
      questions: rows.map((r) => ({
        ...toQuestion(r),
        items: r.rubric_type === 'items' ? itemsOf(r.id) : [],
        usedInPapers: usedCount[r.id] || 0,
      })),
      total: rows.length,
    };
  });

  router.get('/api/questions/:id', (ctx) => {
    const row = questionRow(ctx.params.id);
    return { question: toQuestion(row, itemsOf(row.id)) };
  });

  router.post('/api/questions', (ctx) => {
    const data = normalizePayload(ctx.body, null);
    const id = insertQuestion(data);
    return { question: toQuestion(questionRow(id), itemsOf(id)) };
  });

  router.put('/api/questions/:id', (ctx) => {
    const row = questionRow(ctx.params.id);
    const data = normalizePayload(ctx.body, row);
    tx((db) => {
      const now = nowIso();
      db.prepare(
        `UPDATE questions SET stem = ?, stem_images = ?, ref_answer = ?, rubric_type = ?,
                rubric_text = ?, points = ?, subject = ?, knowledge = ?, qtype = ?,
                difficulty = ?, updated_at = ?
          WHERE id = ?`
      ).run(
        data.stem, JSON.stringify(data.stemImages), data.refAnswer, data.rubricType,
        data.rubricText, data.points, data.subject, data.knowledge, data.qtype,
        data.difficulty, now, row.id
      );
      db.prepare('DELETE FROM question_items WHERE question_id = ?').run(row.id);
      const stmt = db.prepare('INSERT INTO question_items(question_id, seq, text, points) VALUES(?,?,?,?)');
      data.items.forEach((it) => stmt.run(row.id, it.seq, it.text, it.points));
    });
    return { question: toQuestion(questionRow(row.id), itemsOf(row.id)) };
  });

  router.del('/api/questions/:id', (ctx) => {
    const row = questionRow(ctx.params.id);
    const used = get('SELECT COUNT(*) AS c FROM paper_questions WHERE question_id = ?', row.id).c;
    // 删一条评分标准，就把它在试卷里的用题位置、那些位置上已有的作答与评分一并清掉，
    // 不留孤儿数据；被抽掉一题后试卷题号会重新连号。
    const removed = tx((db) => purgeQuestion(db, row.id));
    return { ok: true, deleted: row.id, usedInPapers: used, removed };
  });

  router.post('/api/questions/:id/duplicate', (ctx) => {
    const row = questionRow(ctx.params.id);
    const items = itemsOf(row.id);
    const data = normalizePayload({
      stem: row.stem + '（副本）',
      stemImages: safeJson(row.stem_images, []),
      refAnswer: row.ref_answer,
      rubricType: row.rubric_type,
      rubricText: row.rubric_text,
      points: row.points,
      subject: row.subject,
      knowledge: row.knowledge,
      qtype: row.qtype,
      difficulty: row.difficulty,
      items: items.map((it) => ({ text: it.text, points: it.points })),
    }, null);
    const id = insertQuestion(data);
    return { question: toQuestion(questionRow(id), itemsOf(id)) };
  });
}

module.exports = { register, toQuestion, itemsOf, normalizePayload, DIFFICULTIES };
