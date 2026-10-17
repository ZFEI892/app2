-- 试卷批改专属 App · 全部建表语句
-- 由 server/db.js 在首次启动时执行；已存在的对象自动跳过。

CREATE TABLE IF NOT EXISTS questions (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  stem         TEXT NOT NULL,
  stem_images  TEXT DEFAULT '[]',
  ref_answer   TEXT DEFAULT '',
  rubric_type  TEXT NOT NULL,
  rubric_text  TEXT DEFAULT '',
  points       REAL NOT NULL DEFAULT 0,
  subject      TEXT DEFAULT '',
  knowledge    TEXT DEFAULT '',
  qtype        TEXT DEFAULT '',
  difficulty   TEXT DEFAULT '中',
  created_at   TEXT NOT NULL,
  updated_at   TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS question_items (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  question_id INTEGER NOT NULL REFERENCES questions(id) ON DELETE CASCADE,
  seq         INTEGER NOT NULL,
  text        TEXT NOT NULL,
  points      REAL NOT NULL
);

CREATE TABLE IF NOT EXISTS papers (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  name         TEXT NOT NULL,
  status       TEXT NOT NULL DEFAULT 'draft',
  pass_line    REAL DEFAULT 0,
  -- 整卷总分：**这份卷子的满分**。老师自己给一个总分，AI 会把它按权重分到每道大题、
  -- 再平均分到每小题（见 paper_questions.item_points）。
  -- 卷子里没有题目（专收「图片答卷」）时，它直接做 AI 整卷给分的上限。
  -- 留空时：有题目按各题分值之和算，没题目按 100 算。
  whole_full_marks REAL,
  created_at   TEXT NOT NULL,
  updated_at   TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS paper_questions (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  paper_id    INTEGER NOT NULL REFERENCES papers(id) ON DELETE CASCADE,
  question_id INTEGER NOT NULL REFERENCES questions(id),
  seq         INTEGER NOT NULL,
  points      REAL,
  -- AI 分配分值后，这道大题下面每个得分点（小题）各占几分，顺序对应 question_items 的 seq。
  -- JSON 数组，如 [4, 3, 3]；NULL = 还没分配，批改时回退用评分标准自带的小题分值。
  item_points TEXT
);

CREATE TABLE IF NOT EXISTS students (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  name       TEXT NOT NULL,
  sno        TEXT DEFAULT '',
  class_name TEXT DEFAULT '',
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS submissions (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  paper_id     INTEGER NOT NULL REFERENCES papers(id) ON DELETE CASCADE,
  student_id   INTEGER NOT NULL REFERENCES students(id),
  source       TEXT NOT NULL,
  status       TEXT NOT NULL DEFAULT 'submitted',
  -- 整份图片作答：这组照片就是这名学生整张答题卡的作答，不挂到任何题目上。
  -- 与 answers 里的逐题作答互斥（一份答卷只会是其中一种形态）。
  images       TEXT DEFAULT '[]',
  submitted_at TEXT,
  updated_at   TEXT NOT NULL,
  UNIQUE(paper_id, student_id)
);

CREATE TABLE IF NOT EXISTS answers (
  id                INTEGER PRIMARY KEY AUTOINCREMENT,
  submission_id     INTEGER NOT NULL REFERENCES submissions(id) ON DELETE CASCADE,
  paper_question_id INTEGER NOT NULL REFERENCES paper_questions(id) ON DELETE CASCADE,
  text              TEXT DEFAULT '',
  images            TEXT DEFAULT '[]',
  updated_at        TEXT NOT NULL,
  UNIQUE(submission_id, paper_question_id)
);

CREATE TABLE IF NOT EXISTS grade_sheets (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  submission_id INTEGER NOT NULL UNIQUE REFERENCES submissions(id) ON DELETE CASCADE,
  status        TEXT NOT NULL DEFAULT 'ungraded',
  ai_total      REAL,
  final_total   REAL,
  comment       TEXT DEFAULT '',
  error         TEXT DEFAULT '',
  -- 整份图片作答的评分：整卷只给一个总分，没有逐题明细。
  -- whole_mode 为空字符串表示这份答卷是逐题批的；为 'auto' 表示整卷自主评判。
  whole_mode       TEXT DEFAULT '',
  whole_ai_score   REAL,
  whole_reason     TEXT DEFAULT '',
  whole_confidence REAL,
  whole_doubt      INTEGER DEFAULT 0,
  whole_final_score REAL,
  -- AI 从卷面上读出来的错题清单：[{no:'3', deduct:3, where:'第 2 步受力分析', issue:'漏了摩擦力方向'}]
  -- 每条带扣分（deduct），总分 = 满分 − 各错题扣分之和。
  whole_wrong      TEXT DEFAULT '[]',
  -- 整卷批改时那组图片的内容指纹：同一张照片批过就复用，让"两次上传同样的照片"判分一致
  whole_image_hash TEXT,
  confirmed_at  TEXT,
  created_at    TEXT NOT NULL,
  updated_at    TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS grade_items (
  id                INTEGER PRIMARY KEY AUTOINCREMENT,
  grade_sheet_id    INTEGER NOT NULL REFERENCES grade_sheets(id) ON DELETE CASCADE,
  paper_question_id INTEGER NOT NULL REFERENCES paper_questions(id) ON DELETE CASCADE,
  question_item_id  INTEGER,
  -- 'rubric' = 逐条对照评分标准给分；'auto' = 学生交的是图片，AI 直接看图自主判分
  mode              TEXT DEFAULT 'rubric',
  ai_score          REAL,
  ai_reason         TEXT DEFAULT '',
  ai_confidence     REAL,
  doubt             INTEGER DEFAULT 0,
  final_score       REAL,
  teacher_note      TEXT DEFAULT ''
);

CREATE TABLE IF NOT EXISTS batch_jobs (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  paper_id     INTEGER NOT NULL REFERENCES papers(id) ON DELETE CASCADE,
  status       TEXT NOT NULL DEFAULT 'running',
  total        INTEGER NOT NULL DEFAULT 0,
  done         INTEGER NOT NULL DEFAULT 0,
  failed       TEXT DEFAULT '[]',
  targets      TEXT DEFAULT '[]',
  cursor       INTEGER DEFAULT 0,
  message      TEXT DEFAULT '',
  created_at   TEXT NOT NULL,
  updated_at   TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS todos (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  text       TEXT NOT NULL,
  done       INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  done_at    TEXT
);

CREATE TABLE IF NOT EXISTS settings (
  key   TEXT PRIMARY KEY,
  value TEXT
);

CREATE TABLE IF NOT EXISTS audit_log (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  entity     TEXT NOT NULL,
  entity_id  INTEGER NOT NULL,
  action     TEXT NOT NULL,
  detail     TEXT DEFAULT '',
  created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_pq_paper    ON paper_questions(paper_id);
CREATE INDEX IF NOT EXISTS idx_sub_paper   ON submissions(paper_id);
CREATE INDEX IF NOT EXISTS idx_sub_student ON submissions(student_id);
CREATE INDEX IF NOT EXISTS idx_ans_sub     ON answers(submission_id);
CREATE INDEX IF NOT EXISTS idx_gi_sheet    ON grade_items(grade_sheet_id);
CREATE INDEX IF NOT EXISTS idx_q_items     ON question_items(question_id);
