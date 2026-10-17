'use strict';

const { all, get, run, tx, nowIso } = require('../db');
const { HttpError } = require('../router');
const { paperFullMarks, passLine, round2 } = require('../lib/calc');
const { purgeStudent } = require('../lib/cascade');

function toStudent(row) {
  return {
    id: row.id,
    name: row.name,
    sno: row.sno || '',
    className: row.class_name || '',
    createdAt: row.created_at,
  };
}

function studentRow(id) {
  const row = get('SELECT * FROM students WHERE id = ?', id);
  if (!row) throw new HttpError(404, '学生不存在');
  return row;
}

function normalizeName(name) {
  const v = String(name === undefined || name === null ? '' : name).trim();
  if (!v) throw new HttpError(400, '学生姓名不能为空');
  if (v.length > 40) throw new HttpError(400, '学生姓名过长');
  return v;
}

/** 把粘贴的名单文本解析成结构化行 */
function parseRoster(text) {
  const lines = String(text || '').split(/\r?\n/);
  const rows = [];
  lines.forEach((line) => {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) return;
    const parts = trimmed.split(/[\s,，、\t]+/).filter(Boolean);
    if (!parts.length) return;
    rows.push({
      name: parts[0],
      sno: parts[1] || '',
      className: parts.slice(2).join(' ') || '',
    });
  });
  return rows;
}

function duplicateReason(row) {
  if (row.sno) {
    const hit = get('SELECT id FROM students WHERE sno = ?', row.sno);
    if (hit) return `学号 ${row.sno} 已存在`;
  }
  const same = get('SELECT id FROM students WHERE name = ? AND IFNULL(class_name, \'\') = ?', row.name, row.className || '');
  if (same) return '同班同名已存在';
  return null;
}

function register(router) {
  router.get('/api/students', (ctx) => {
    const q = String(ctx.query.q || '').trim();
    let rows;
    if (q) {
      const like = `%${q}%`;
      rows = all(
        `SELECT * FROM students
          WHERE name LIKE ? OR sno LIKE ? OR class_name LIKE ?
          ORDER BY class_name, sno, name`,
        like, like, like
      );
    } else {
      rows = all('SELECT * FROM students ORDER BY class_name, sno, name');
    }
    const counts = all(
      'SELECT student_id, COUNT(*) AS c FROM submissions GROUP BY student_id'
    ).reduce((acc, r) => { acc[r.student_id] = r.c; return acc; }, {});
    return {
      students: rows.map((r) => ({ ...toStudent(r), submissionCount: counts[r.id] || 0 })),
      total: rows.length,
    };
  });

  router.get('/api/students/:id', (ctx) => {
    const row = studentRow(ctx.params.id);
    return { student: toStudent(row) };
  });

  router.post('/api/students', (ctx) => {
    const body = ctx.body || {};
    const name = normalizeName(body.name);
    const sno = String(body.sno || '').trim();
    const className = String(body.className || '').trim();
    const dup = duplicateReason({ name, sno, className });
    if (dup) throw new HttpError(409, dup);
    const info = run(
      'INSERT INTO students(name, sno, class_name, created_at) VALUES(?,?,?,?)',
      name, sno, className, nowIso()
    );
    return { student: toStudent(studentRow(info.lastInsertRowid)) };
  });

  router.put('/api/students/:id', (ctx) => {
    const row = studentRow(ctx.params.id);
    const body = ctx.body || {};
    const name = normalizeName(body.name === undefined ? row.name : body.name);
    const sno = body.sno === undefined ? row.sno : String(body.sno).trim();
    const className = body.className === undefined ? row.class_name : String(body.className).trim();
    const clashSno = sno ? get('SELECT id FROM students WHERE sno = ? AND id <> ?', sno, row.id) : null;
    if (clashSno) throw new HttpError(409, `学号 ${sno} 已存在`);
    const clashName = get(
      "SELECT id FROM students WHERE name = ? AND IFNULL(class_name, '') = ? AND id <> ?",
      name, className, row.id
    );
    if (clashName) throw new HttpError(409, '同班同名已存在');
    run(
      'UPDATE students SET name = ?, sno = ?, class_name = ? WHERE id = ?',
      name, sno, className, row.id
    );
    return { student: toStudent(studentRow(row.id)) };
  });

  router.del('/api/students/:id', (ctx) => {
    const row = studentRow(ctx.params.id);
    // 删学生就把他历次答卷与评分一起清掉，不留孤儿数据
    const removed = tx((db) => purgeStudent(db, row.id));
    return { ok: true, deleted: row.id, removed };
  });

  router.get('/api/students/:id/history', (ctx) => {
    const row = studentRow(ctx.params.id);
    const subs = all(
      `SELECT s.id AS submission_id, s.status AS submission_status, s.submitted_at,
              p.id AS paper_id, p.name AS paper_name, p.pass_line,
              gs.status AS grade_status, gs.final_total, gs.ai_total
         FROM submissions s
         JOIN papers p ON p.id = s.paper_id
         LEFT JOIN grade_sheets gs ON gs.submission_id = s.id
        WHERE s.student_id = ?
        ORDER BY datetime(IFNULL(s.submitted_at, s.updated_at)) DESC, s.id DESC`,
      row.id
    );
    const history = subs.map((s) => {
      const paper = get('SELECT * FROM papers WHERE id = ?', s.paper_id);
      const full = paperFullMarks(paper);
      let total = null;
      if (s.grade_status === 'confirmed') {
        total = s.final_total === null || s.final_total === undefined
          ? (s.ai_total === null || s.ai_total === undefined ? null : round2(s.ai_total))
          : round2(s.final_total);
      }
      return {
        submissionId: s.submission_id,
        paperId: s.paper_id,
        paperName: s.paper_name,
        submissionStatus: s.submission_status,
        gradeStatus: s.grade_status || 'ungraded',
        submittedAt: s.submitted_at,
        fullMarks: full,
        total,
        passLine: passLine(paper),
        passed: total === null ? null : total >= passLine(paper),
      };
    });
    return { student: toStudent(row), history };
  });

  router.post('/api/students/import/preview', (ctx) => {
    const text = (ctx.body || {}).text || '';
    const rows = parseRoster(text).map((r) => {
      const reason = duplicateReason(r);
      return { ...r, duplicate: Boolean(reason), reason: reason || '' };
    });
    return { rows, total: rows.length, duplicates: rows.filter((r) => r.duplicate).length };
  });

  router.post('/api/students/import', (ctx) => {
    const body = ctx.body || {};
    let rows = Array.isArray(body.rows) ? body.rows : null;
    if (!rows) rows = parseRoster(body.text || '');
    if (!rows.length) throw new HttpError(400, '没有可导入的学生');

    const created = [];
    const skipped = [];
    tx((db) => {
      rows.forEach((raw) => {
        const name = String(raw.name || '').trim();
        if (!name) { skipped.push({ name: '(空)', reason: '姓名为空' }); return; }
        const sno = String(raw.sno || '').trim();
        const className = String(raw.className || '').trim();
        const dupCheck = get('SELECT id FROM students WHERE name = ? AND IFNULL(class_name, \'\') = ?', name, className);
        const dupSno = sno ? get('SELECT id FROM students WHERE sno = ?', sno) : null;
        if (dupSno || dupCheck) {
          skipped.push({ name, reason: dupSno ? `学号 ${sno} 已存在` : '同班同名已存在' });
          return;
        }
        const info = db
          .prepare('INSERT INTO students(name, sno, class_name, created_at) VALUES(?,?,?,?)')
          .run(name, sno, className, nowIso());
        created.push({ id: Number(info.lastInsertRowid), name, sno, className });
      });
    });
    return { created: created.length, skipped, students: created };
  });
}

module.exports = { register, parseRoster, toStudent };
