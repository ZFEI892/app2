'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');

const SCHEMA_PATH = path.join(__dirname, 'schema.sql');

let current = null;
let currentFile = null;

/** 给已存在的表补充新列（轻量迁移，不破坏已有数据） */
function ensureColumn(db, table, column, ddl) {
  const cols = db.prepare(`PRAGMA table_info(${table})`).all().map((c) => c.name);
  if (!cols.includes(column)) {
    db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${ddl}`);
  }
}

function migrate(db) {
  ensureColumn(db, 'batch_jobs', 'targets', "TEXT DEFAULT '[]'");
  // 老数据默认都算「按评分标准判分」，只有图片作答才会被写成 'auto'
  ensureColumn(db, 'grade_items', 'mode', "TEXT DEFAULT 'rubric'");
  // 「整份图片作答」这一路：答卷上挂一组照片，评分单上存整卷那一个总分。
  // 老数据 images 为空数组、whole_mode 为空串，等价于"没有走这条路"。
  ensureColumn(db, 'submissions', 'images', "TEXT DEFAULT '[]'");
  ensureColumn(db, 'grade_sheets', 'whole_mode', "TEXT DEFAULT ''");
  ensureColumn(db, 'grade_sheets', 'whole_ai_score', 'REAL');
  ensureColumn(db, 'grade_sheets', 'whole_reason', "TEXT DEFAULT ''");
  ensureColumn(db, 'grade_sheets', 'whole_confidence', 'REAL');
  ensureColumn(db, 'grade_sheets', 'whole_doubt', 'INTEGER DEFAULT 0');
  ensureColumn(db, 'grade_sheets', 'whole_final_score', 'REAL');
  // AI 从整卷照片上读出来的错题清单（题号 + 错在哪），只报错处不给每题分
  ensureColumn(db, 'grade_sheets', 'whole_wrong', "TEXT DEFAULT '[]'");
  // 无题卷（专收「图片答卷」的卷子）的整卷满分：卷上没题目时靠它定满分与及格线
  ensureColumn(db, 'papers', 'whole_full_marks', 'REAL');
  // AI 分配分值后，每道大题下面每个得分点（小题）各占几分（JSON 数组）
  ensureColumn(db, 'paper_questions', 'item_points', 'TEXT');
  // 整卷批改时那组图片的内容指纹：同一张照片批过就复用，让判分一致
  ensureColumn(db, 'grade_sheets', 'whole_image_hash', 'TEXT');
}

/** 打开（或创建）数据库并确保表结构就绪 */
function initDb(file) {
  const target = file || ':memory:';
  if (target !== ':memory:') {
    fs.mkdirSync(path.dirname(path.resolve(target)), { recursive: true });
  }
  const db = new DatabaseSync(target);
  db.exec('PRAGMA foreign_keys = ON;');
  db.exec(fs.readFileSync(SCHEMA_PATH, 'utf8'));
  migrate(db);
  current = db;
  currentFile = target;
  return db;
}

function getDb() {
  if (!current) throw new Error('数据库未初始化，请先调用 initDb()');
  return current;
}

function getDbFile() {
  return currentFile;
}

function closeDb() {
  if (current) {
    try { current.close(); } catch (_) { /* ignore */ }
    current = null;
    currentFile = null;
  }
}

/** 事务包装：同步函数，抛错自动回滚 */
function tx(fn) {
  const db = getDb();
  db.exec('BEGIN');
  try {
    const result = fn(db);
    db.exec('COMMIT');
    return result;
  } catch (err) {
    try { db.exec('ROLLBACK'); } catch (_) { /* ignore */ }
    throw err;
  }
}

function nowIso() {
  return new Date().toISOString();
}

function all(sql, ...params) {
  return getDb().prepare(sql).all(...params);
}

function get(sql, ...params) {
  return getDb().prepare(sql).get(...params);
}

function run(sql, ...params) {
  return getDb().prepare(sql).run(...params);
}

function setting(key, fallback = null) {
  const row = get('SELECT value FROM settings WHERE key = ?', key);
  return row ? row.value : fallback;
}

function setSetting(key, value) {
  run(
    'INSERT INTO settings(key, value) VALUES(?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value',
    key,
    value === null || value === undefined ? '' : String(value)
  );
}

module.exports = {
  SCHEMA_PATH,
  initDb,
  getDb,
  getDbFile,
  closeDb,
  tx,
  nowIso,
  all,
  get,
  run,
  setting,
  setSetting,
};
