'use strict';

const { all, get, run, nowIso } = require('../db');
const { HttpError } = require('../router');
const { cardCounts, focusPaper, localDateKey, todayKey } = require('./stats');

const MAX_AUTO_PER_KIND = 3;

function manualRow(id) {
  const row = get('SELECT * FROM todos WHERE id = ?', id);
  if (!row) throw new HttpError(404, '这条提醒不存在');
  return row;
}

function toManual(row) {
  return {
    id: row.id,
    text: row.text,
    done: row.done === 1,
    createdAt: row.created_at,
    doneAt: row.done_at,
  };
}

/**
 * 自动条目：每次都由实时查询得出，不落库。
 * 「做完就消失」由此自然满足——批完确认了，对应的待办就不再出现。
 */
function autoItems() {
  const today = todayKey();
  const counts = cardCounts();
  const items = [];

  // 1. 今天新收、还没批完的答案（按试卷分条，最多 3 条）
  const pendingSubmissions = all(
    `SELECT s.id, s.paper_id, s.submitted_at, p.name AS paper_name
       FROM submissions s
       JOIN papers p ON p.id = s.paper_id
  LEFT JOIN grade_sheets gs ON gs.submission_id = s.id
      WHERE s.status = 'submitted' AND IFNULL(gs.status, 'ungraded') <> 'confirmed'
      ORDER BY s.id`
  );
  const byPaper = new Map();
  pendingSubmissions.forEach((r) => {
    const entry = byPaper.get(r.paper_id)
      || { paperId: r.paper_id, paperName: r.paper_name, total: 0, today: 0 };
    entry.total += 1;
    if (localDateKey(r.submitted_at) === today) entry.today += 1;
    byPaper.set(r.paper_id, entry);
  });
  [...byPaper.values()]
    .filter((e) => e.today > 0)
    .sort((a, b) => b.today - a.today || a.paperId - b.paperId)
    .slice(0, MAX_AUTO_PER_KIND)
    .forEach((e) => {
      items.push({
        key: 'today_received:' + e.paperId,
        text: `《${e.paperName}》今天新收了 ${e.today} 份答卷，还没批完`,
        count: e.today,
        page: 'grading',
        query: { paper: e.paperId, filter: 'pending', seq: 1 },
        hint: `本卷共 ${e.total} 份待批改`,
      });
    });

  // 2. 缺考待处理
  const absent = all(
    `SELECT s.paper_id, p.name AS paper_name, COUNT(*) AS c
       FROM submissions s JOIN papers p ON p.id = s.paper_id
      WHERE s.status = 'absent'
      GROUP BY s.paper_id`
  );
  absent.slice(0, MAX_AUTO_PER_KIND).forEach((r) => {
    items.push({
      key: 'absent:' + r.paper_id,
      text: `《${r.paper_name}》有 ${r.c} 名学生缺考待处理`,
      count: r.c,
      page: 'submissions',
      query: { paper: r.paper_id },
      hint: '确认是缺考还是漏交',
    });
  });

  // 3. 待批改
  if (counts.toGrade > 0) {
    const focus = focusPaper('toGrade');
    items.push({
      key: 'to_grade',
      text: `有 ${counts.toGrade} 份答卷等你批改`,
      count: counts.toGrade,
      page: 'grading',
      query: focus ? { paper: focus.paperId, filter: 'pending', seq: 1 } : { filter: 'pending' },
      hint: focus ? `主要集中在《${focus.paperName}》` : '',
    });
  }

  // 4. AI 存疑待复核
  if (counts.doubt > 0) {
    const focus = focusPaper('doubt');
    items.push({
      key: 'doubt',
      text: `有 ${counts.doubt} 处 AI 拿不准，等你复核`,
      count: counts.doubt,
      page: 'grading',
      query: focus ? { paper: focus.paperId, filter: 'doubt', seq: 1 } : { filter: 'doubt' },
      hint: focus ? `主要集中在《${focus.paperName}》` : '',
    });
  }

  // 5. 已批完待确认
  if (counts.toConfirm > 0) {
    const focus = focusPaper('toConfirm');
    items.push({
      key: 'to_confirm',
      text: `有 ${counts.toConfirm} 份已批完，等你确认`,
      count: counts.toConfirm,
      page: 'grading',
      query: focus ? { paper: focus.paperId, filter: 'to_confirm', seq: 1 } : { filter: 'to_confirm' },
      hint: '确认后才计入统计',
    });
  }

  // 6. 刚发布、还没人交的试卷
  const idle = all(
    `SELECT p.id, p.name FROM papers p
      WHERE p.status = 'open'
        AND NOT EXISTS (SELECT 1 FROM submissions s WHERE s.paper_id = p.id)
      ORDER BY p.updated_at DESC, p.id DESC`
  );
  idle.slice(0, MAX_AUTO_PER_KIND).forEach((p) => {
    items.push({
      key: 'idle_paper:' + p.id,
      text: `《${p.name}》已发布，还没有人交`,
      count: 1,
      page: 'submissions',
      query: { paper: p.id },
      hint: '去「提交」页录入答案',
    });
  });

  return items;
}

function listTodos() {
  const manual = all('SELECT * FROM todos ORDER BY done, id DESC').map(toManual);
  return {
    date: todayKey(),
    auto: autoItems(),
    manual: manual.filter((t) => !t.done),
    manualDone: manual.filter((t) => t.done),
  };
}

function register(router) {
  router.get('/api/todos', () => listTodos());

  router.post('/api/todos', (ctx) => {
    const text = String((ctx.body && ctx.body.text) || '').trim();
    if (!text) throw new HttpError(400, '提醒内容不能为空');
    if (text.length > 200) throw new HttpError(400, '提醒内容请控制在 200 字以内');
    const now = nowIso();
    const info = run('INSERT INTO todos(text, done, created_at) VALUES(?, 0, ?)', text, now);
    return { todo: toManual(manualRow(info.lastInsertRowid)) };
  });

  router.put('/api/todos/:id', (ctx) => {
    const row = manualRow(ctx.params.id);
    const body = ctx.body || {};
    const text = body.text === undefined ? row.text : String(body.text).trim();
    if (!text) throw new HttpError(400, '提醒内容不能为空');
    const done = body.done === undefined ? row.done === 1 : Boolean(body.done);
    run(
      'UPDATE todos SET text = ?, done = ?, done_at = ? WHERE id = ?',
      text,
      done ? 1 : 0,
      done ? (row.done_at || nowIso()) : null,
      row.id
    );
    return { todo: toManual(manualRow(row.id)) };
  });

  router.del('/api/todos/:id', (ctx) => {
    manualRow(ctx.params.id);
    run('DELETE FROM todos WHERE id = ?', ctx.params.id);
    return { ok: true };
  });

  router.post('/api/todos/clear-done', () => {
    const info = run('DELETE FROM todos WHERE done = 1');
    return { ok: true, removed: Number(info.changes || 0) };
  });
}

module.exports = { register, listTodos, autoItems };
