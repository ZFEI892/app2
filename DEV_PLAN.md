# 试卷批改专属 App · 开发计划（DEV_PLAN.md）

| 项目 | 内容 |
| --- | --- |
| 依据 | `PRD.md` v2.2（正式版） |
| 计划版本 | v1.8 |
| 制定日期 | 2026-10-16 |
| 执行方式 | 按里程碑顺序推进，每个里程碑独立可验收 |
| 技术约束 | 零第三方依赖（用 Node 内置能力），不需要 npm install |
| 本次修订 | ① **图片评判改版**：错题清单每条带 `deduct`（扣分），**总分 = 满分 − 各错题扣分之和**（后端强制），扣分依据**优先按照片里印的评分机制**；② 批改页右栏并排显示「AI 给分」与「人工改后」对比；③ 修订 K22 与 M5 的「不给每题分」为「带扣分」 |

> 说明：本计划里每个里程碑都自带「任务清单 + 产出文件 + 验收方法」。验收方法中的编号对应 PRD 第 10 节的检查条目。

---

## 1. 技术选型（已实测确认）

| 层次 | 选型 | 为什么这么选 |
| --- | --- | --- |
| 运行时 | Node.js v22.22.2（本机已有托管版本） | 无需安装，直接可用 |
| 数据库 | **`node:sqlite`（Node 内置）** | **已实测可用**：建表、插入、查询全部通过。零安装、单文件、事务安全 |
| 后端 | Node 原生 `http` 模块 + 自写轻量路由 | 不引入 Express 等依赖，永不因装包失败卡住 |
| 前端 | 原生 HTML / CSS / JavaScript | 无构建步骤，改完刷新即生效，排错直观 |
| 图片 | 存 `data/attachments/`，数据库只存相对路径 | 避免数据文件膨胀（PRD 7.1） |
| 打包 | Windows `启动.bat` | 双击即用（PRD 2.1） |
| 压缩备份 | 自写 `lib/zip.js`（基于内置 `zlib`） | 满足 PRD 7.2「备份是单一文件」，又不引入依赖 |

**已完成的可行性验证**

| 验证项 | 结果 |
| --- | --- |
| `node:sqlite` 建表/插入/查询 | 通过 |
| 千问 API Key 连通性 | 通过 |
| 模型 `qwen3.8-max-0902` 文本对话 | 通过 |
| 模型 `qwen3.8-max-0902` 图片输入 | 通过 |

> 注意事项：`node:sqlite` 会打印一条实验性警告，启动命令里用 `--no-warnings` 抑制即可，功能不受影响。

---

## 2. 目录结构（最终形态）

```
app2/
├─ PRD.md                     需求文档（已定稿）
├─ DEV_PLAN.md                本文件
├─ 启动.bat                   双击启动器
├─ config.local.json          （已不在此处）API Key 等私有配置改存用户主目录 .paper-grading/
├─ server/
│  ├─ index.js                入口：起服务、开浏览器、优雅退出
│  ├─ router.js               轻量路由
│  ├─ db.js                   建库建表、迁移、事务封装
│  ├─ schema.sql              全部建表语句
│  ├─ lib/
│  │  ├─ zip.js               零依赖 ZIP 打包（备份用）
│  │  ├─ prompts.js           批改提示词模板
│  │  └─ json.js              容错 JSON 解析
│  ├─ ai/qwen.js              调用千问（文本 + 图片）
│  └─ routes/
│     ├─ students.js  questions.js  papers.js
│     ├─ submissions.js  grading.js  batch.js
│     ├─ stats.js  todos.js  settings.js  backup.js
├─ web/
│  ├─ index.html              外壳：左侧导航 + 内容区
│  ├─ style.css               全部样式
│  ├─ core/  api.js  store.js  router.js  ui.js
│  └─ pages/  home.js  questions.js  papers.js  submissions.js
│              grading.js  stats.js  students.js  settings.js
└─ data/                      运行后自动生成
   ├─ paper.db                主数据文件
   ├─ attachments/            图片附件
   └─ backups/                备份文件
```

---

## 3. 数据模型（建表语句）

> 放在 `server/schema.sql`，由 `db.js` 在首次启动时自动执行；已存在的库跳过。

```sql
-- 题目
CREATE TABLE IF NOT EXISTS questions (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  stem         TEXT NOT NULL,
  stem_images  TEXT DEFAULT '[]',      -- JSON 数组，图片相对路径
  ref_answer   TEXT DEFAULT '',
  rubric_type  TEXT NOT NULL,          -- 'items' | 'text'
  rubric_text  TEXT DEFAULT '',        -- rubric_type='text' 时使用
  points       REAL NOT NULL DEFAULT 0,-- 总分（items 模式由子表累加）
  -- 以下四个字段是早期"题库"遗留的标签，界面上已不再出现（PRD v1.6 / A-7）。
  -- 保留列是为了不动历史数据：老记录里的值不删、读出来也不展示，编辑保存时原样保留。
  subject      TEXT DEFAULT '',
  knowledge    TEXT DEFAULT '',
  qtype        TEXT DEFAULT '',
  difficulty   TEXT DEFAULT '中',      -- 易 / 中 / 难
  created_at   TEXT NOT NULL,
  updated_at   TEXT NOT NULL
);

-- 得分点（rubric_type='items' 时使用）
CREATE TABLE IF NOT EXISTS question_items (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  question_id INTEGER NOT NULL REFERENCES questions(id) ON DELETE CASCADE,
  seq         INTEGER NOT NULL,
  text        TEXT NOT NULL,
  points      REAL NOT NULL
);

-- 试卷
CREATE TABLE IF NOT EXISTS papers (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  name         TEXT NOT NULL,
  status       TEXT NOT NULL DEFAULT 'draft', -- draft|open|collecting|grading|done
  pass_line    REAL DEFAULT 0,        -- 及格线，默认总分 60%
  created_at   TEXT NOT NULL,
  updated_at   TEXT NOT NULL
);

-- 试卷-题目
CREATE TABLE IF NOT EXISTS paper_questions (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  paper_id    INTEGER NOT NULL REFERENCES papers(id) ON DELETE CASCADE,
  question_id INTEGER NOT NULL REFERENCES questions(id),
  seq         INTEGER NOT NULL,
  points      REAL,                   -- 空则用题目自带分值
  UNIQUE(paper_id, seq)
);

-- 学生
CREATE TABLE IF NOT EXISTS students (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  name       TEXT NOT NULL,
  sno        TEXT DEFAULT '',
  class_name TEXT DEFAULT '',
  created_at TEXT NOT NULL
);

-- 答卷（一个学生一份）
CREATE TABLE IF NOT EXISTS submissions (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  paper_id     INTEGER NOT NULL REFERENCES papers(id) ON DELETE CASCADE,
  student_id   INTEGER NOT NULL REFERENCES students(id),
  source       TEXT NOT NULL,                 -- manual | self | import
  status       TEXT NOT NULL DEFAULT 'submitted', -- submitted | absent
  images       TEXT DEFAULT '[]',             -- 整份图片作答：这组照片就是整张答题卡，不挂题目（与 answers 互斥）
  submitted_at TEXT,
  updated_at   TEXT NOT NULL,
  UNIQUE(paper_id, student_id)
);

-- 学生答案（一题一条）
CREATE TABLE IF NOT EXISTS answers (
  id                INTEGER PRIMARY KEY AUTOINCREMENT,
  submission_id     INTEGER NOT NULL REFERENCES submissions(id) ON DELETE CASCADE,
  paper_question_id INTEGER NOT NULL REFERENCES paper_questions(id) ON DELETE CASCADE,
  text              TEXT DEFAULT '',
  images            TEXT DEFAULT '[]',
  updated_at        TEXT NOT NULL,
  UNIQUE(submission_id, paper_question_id)
);

-- 评分单（一份答卷一张）
CREATE TABLE IF NOT EXISTS grade_sheets (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  submission_id INTEGER NOT NULL UNIQUE REFERENCES submissions(id) ON DELETE CASCADE,
  status        TEXT NOT NULL DEFAULT 'ungraded', -- ungraded | ai_done | confirmed
  ai_total      REAL,
  final_total   REAL,
  comment       TEXT DEFAULT '',       -- 老师批注
  error         TEXT DEFAULT '',       -- 批改失败时的原因
  -- 整份图片作答的整卷评分：整卷只给一个总分，没有逐题明细
  whole_mode        TEXT DEFAULT '',   -- '' = 逐题批的；'auto' = 整卷自主评判
  whole_ai_score    REAL,
  whole_reason      TEXT DEFAULT '',
  whole_confidence  REAL,
  whole_doubt       INTEGER DEFAULT 0,
  whole_final_score REAL,              -- 老师改过的整卷分
  confirmed_at  TEXT,
  created_at    TEXT NOT NULL,
  updated_at    TEXT NOT NULL
);

-- 逐项评分明细
CREATE TABLE IF NOT EXISTS grade_items (
  id                INTEGER PRIMARY KEY AUTOINCREMENT,
  grade_sheet_id    INTEGER NOT NULL REFERENCES grade_sheets(id) ON DELETE CASCADE,
  paper_question_id INTEGER NOT NULL REFERENCES paper_questions(id) ON DELETE CASCADE,
  question_item_id  INTEGER,           -- 'text' 模式为 NULL
  mode              TEXT DEFAULT 'rubric', -- rubric | auto（这一条当时按哪种模式判的）
  ai_score          REAL,
  ai_reason         TEXT DEFAULT '',
  ai_confidence     REAL,              -- 0~1，低于阈值自动标存疑
  doubt             INTEGER DEFAULT 0, -- 0/1
  final_score       REAL,              -- 老师最终分（空=沿用 AI 分）
  teacher_note      TEXT DEFAULT ''
);

-- 批量批改任务
CREATE TABLE IF NOT EXISTS batch_jobs (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  paper_id     INTEGER NOT NULL REFERENCES papers(id) ON DELETE CASCADE,
  status       TEXT NOT NULL DEFAULT 'running', -- running | paused | done | stopped
  total        INTEGER NOT NULL DEFAULT 0,
  done         INTEGER NOT NULL DEFAULT 0,
  failed       TEXT DEFAULT '[]',      -- JSON：[{submission_id, reason}]
  cursor       INTEGER DEFAULT 0,      -- 下一个待处理序号
  created_at   TEXT NOT NULL,
  updated_at   TEXT NOT NULL
);

-- 今日计划（仅手动提醒）
CREATE TABLE IF NOT EXISTS todos (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  text       TEXT NOT NULL,
  done       INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  done_at    TEXT
);

-- 设置（键值）
CREATE TABLE IF NOT EXISTS settings (
  key   TEXT PRIMARY KEY,
  value TEXT
);

-- 操作留痕（解锁重批等）
CREATE TABLE IF NOT EXISTS audit_log (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  entity     TEXT NOT NULL,
  entity_id  INTEGER NOT NULL,
  action     TEXT NOT NULL,
  detail     TEXT DEFAULT '',
  created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_pq_paper ON paper_questions(paper_id);
CREATE INDEX IF NOT EXISTS idx_sub_paper ON submissions(paper_id);
CREATE INDEX IF NOT EXISTS idx_ans_sub   ON answers(submission_id);
CREATE INDEX IF NOT EXISTS idx_gi_sheet  ON grade_items(grade_sheet_id);
```

**关键计算口径（与 PRD 第 3、5.5、10.4 节一致）**

| 指标 | 算法 |
| --- | --- |
| 试卷总分 | Σ 每题的 `points`（题目自带或试卷覆盖值） |
| 答卷总分 | Σ 该卷每题的 `final_score`（空则取 `ai_score`） |
| 班级平均分 | 仅统计 `status='confirmed'` 的答卷 |
| 题目得分率 | 该题全班得分总和 ÷（该题满分 × 已确认答卷数） |
| 待讲评的题 | 得分率 < 50% 的题目数 |
| 及格率 | 已确认答卷中总分 ≥ `pass_line` 的比例 |
| 待你批改 | `grade_sheets.status='ungraded'` 且答卷 `status='submitted'` 的份数 |
| 待你确认 | `grade_sheets.status='ai_done'` 的份数 |
| 需复核的存疑点 | `grade_items.doubt=1` 且所属评分单未确认的条数 |

---

## 4. 后端接口清单

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/api/students` | 学生列表 |
| POST | `/api/students` | 新增 |
| PUT | `/api/students/:id` | 编辑 |
| DELETE | `/api/students/:id` | 删除 |
| POST | `/api/students/import` | 批量粘贴导入 |
| GET | `/api/students/:id/history` | 该生历次成绩 |
| GET | `/api/questions` | 列表（支持 `q` 关键词搜索；`subject` / `difficulty` 等筛选参数后端仍认，但界面上已不再用） |
| POST | `/api/questions` | 新建 |
| GET | `/api/questions/:id` | 详情（含得分点） |
| PUT | `/api/questions/:id` | 编辑 |
| DELETE | `/api/questions/:id` | 删除 |
| POST | `/api/questions/:id/duplicate` | 复制为新题 |
| GET | `/api/papers` | 试卷列表（含进度） |
| POST | `/api/papers` | 新建试卷 |
| GET | `/api/papers/:id` | 详情（含题目、分值、总分） |
| PUT | `/api/papers/:id` | 改名 / 改及格线 |
| PUT | `/api/papers/:id/questions` | 一次性设置题目顺序与分值 |
| POST | `/api/papers/:id/publish` | 发布（draft → open） |
| DELETE | `/api/papers/:id` | 删除 |
| GET | `/api/papers/:pid/submissions` | 提交情况一览 |
| POST | `/api/papers/:pid/submissions` | 新建/保存某学生答卷（含全部答案；带 `images` 就是「图片答案」的整份图片作答） |
| PUT | `/api/submissions/:id` | 修改答案 / 标记缺考 |
| DELETE | `/api/submissions/:id` | 删除答卷 |
| POST | `/api/uploads` | 图片上传（base64 入，返回相对路径） |
| POST | `/api/import/parse` | 导入文件解析（AI 识别文字，返回可修正的结构；**「图片答案」不走这个接口**） |
| POST | `/api/submissions/:id/grade` | 单份 AI 批改（逐题作答逐题判；整份图片作答整卷给一个总分） |
| POST | `/api/papers/:pid/grade-batch` | 启动批量批改，返回 jobId |
| GET | `/api/batch/:jobId` | 轮询进度 |
| POST | `/api/batch/:jobId/pause` | 暂停 |
| POST | `/api/batch/:jobId/resume` | 继续 |
| POST | `/api/batch/:jobId/retry-failed` | 重试失败的份数 |
| GET | `/api/papers/:pid/queue` | 批改队列（`filter=pending\|to_confirm\|doubt`） |
| GET | `/api/papers/:pid/queue/:seq` | 取第 seq 份（上一份/下一份） |
| PUT | `/api/grade-items/:id` | 改某一项分数 / 存疑标记（逐题答卷用） |
| PUT | `/api/grade-sheets/:id/whole` | 改**整卷那一个总分** / 整卷存疑 / 整卷理由（图片答案用；逐题答卷打它会 409） |
| PUT | `/api/grade-sheets/:id` | 写批注 |
| POST | `/api/grade-sheets/:id/confirm` | 确认锁定 |
| POST | `/api/grade-sheets/:id/unlock` | 解锁重批（写 audit_log） |
| GET | `/api/stats/home` | 首页全部数据 |
| GET | `/api/stats/papers/:id` | 班级概览 + 每题得分率 + 排名 |
| GET | `/api/stats/papers/:id/questions/:pqid/students` | 某题答错学生名单 |
| GET | `/api/todos` | 今日计划手动提醒 |
| POST | `/api/todos` | 新增提醒 |
| POST | `/api/todos/:id/toggle` | 勾选/取消 |
| DELETE | `/api/todos/:id` | 删除提醒 |
| GET | `/api/settings` | 设置（Key 打码） |
| PUT | `/api/settings` | 保存设置（Key 留空则不改） |
| POST | `/api/settings/test-ai` | 测试 AI 连接 |
| POST | `/api/backup` | 一键备份，返回文件路径 |
| GET | `/api/backups` | 备份列表 |
| POST | `/api/restore` | 从备份恢复（含二次确认标记） |

---

## 5. 里程碑计划

### M0 · 地基与骨架

**目标**：双击就能起服务、看到界面、数据能落盘。

- [ ] 创建目录结构（第 2 节）
- [ ] `server/schema.sql` 写全部建表语句
- [ ] `server/db.js`：打开 `data/paper.db`、执行 schema、封装 `all/get/run/tx`
- [ ] `server/router.js`：极简路由（方法 + 路径匹配 + JSON 解析）
- [ ] **`server/lib/cascade.js`：级联删除函数库**（`purgeSubmission` / `purgePaper` / `purgeStudent` / `purgeQuestion` / `renumberPaper`），全部在调用方 `tx()` 内执行并返回计数对象 —— 四个模块的删除接口共用（PRD 5.8）
- [ ] `server/index.js`：静态托管 `web/`、挂载 `/api`、端口 8756（被占用自动 +1）、启动后自动打开浏览器
- [ ] `启动.bat`：调用本机 Node 启动 `server/index.js`
- [ ] 私有配置读取逻辑（接口地址、模型；Key 存用户主目录 `.paper-grading/config.local.json`，**不放项目里**）
- [ ] `web/index.html` + `style.css`：左侧三组八页导航外壳，页面可切换（内容先占位）
- [ ] `web/core/router.js` 的 `NAV` 按 PRD v1.6 定型：第一组叫「批改」，依次为 `home / papers / submissions / grading / questions`（label 为 首页 / 试卷 / 提交 / 批改 / **评分标准**，**不出现「题库」**）
- [ ] `web/core/api.js`：统一 `fetch` 封装（GET/POST/PUT/DELETE、错误提示）

**产出**：可双击启动的空壳应用
**验收**：PRD 第 1、3、21 条 —— 双击起服务、浏览器自动打开、无报错；关闭重开数据仍在；除 AI 外无外部网络请求；PRD 第 27 条 —— 导航里找不到「题库」

---

### M1 · 学生名录

- [ ] 学生列表页：表格（姓名 / 学号 / 班级）+ 搜索
- [ ] 新增、编辑、删除（删除按 5.8 级联：连同他名下的答卷、作答、评分一起清掉）
- [ ] 批量导入：粘贴多行文本（每行"姓名 学号 班级"），解析后预览再入库
- [ ] 学生详情：历次成绩列表

**产出**：`routes/students.js`、`web/pages/students.js`
**验收**：能建 42 个学生；点开某个学生能看到他的历次成绩

---

### M2 · 评分标准（原「题库」，只为批改服务）

> 定位已收敛（PRD v1.6 / A-6、A-7）：这一页不是出题工具，只负责给 AI 提供打分依据。
> 数据模型与接口仍沿用 `questions` / `/api/questions`（内部命名不改，避免无谓的历史数据迁移）；
> 变的是**界面语义与字段取舍**。

- [ ] 表单只留四项：题干、参考答案、评分标准、分值
- [ ] 评分标准两种模式切换：
  - 分项：得分点行（内容 + 分值），可增删排序，总分自动累加
  - 文字：单段说明 + 题目满分
- [ ] **不再提供**：学科 / 知识点 / 题型 / 难度的录入，标签卡、标签列、按学科或难度筛选、`/api/questions/meta` 请求
- [ ] 评分标准列表：关键词搜索（题干 / 参考答案 / 评分说明）
- [ ] 编辑、删除、复制一条。**删除要级联**（`purgeQuestion`）：摘掉所有试卷上的用题位置、清掉对应的作答与评分明细、题号重新连号；二次确认里说明"会从 N 份试卷上摘掉"
- [ ] 保存时**不提交** `subject / knowledge / qtype / difficulty`：后端 `normalizePayload` 的 `pick(key, base[key])` 会原样保留老数据，不能因为界面上没这些框就把它们清空
- [ ] 保存后校验：分项模式下必须至少一个得分点且分值为正

**产出**：`routes/questions.js`、`web/pages/questions.js`
**验收**：PRD 第 2 条 —— 新建一条分项评分标准，重启电脑后内容一字不差；PRD 第 28 条 —— 页面上找不到出题味字段且老数据不被清空

---

### M3 · 试卷（挑题 + 整卷总分 + AI 分配分值）

- [ ] 新建试卷（填名称、整卷总分默认 100、及格线默认总分 60%）
- [ ] 挑题：从评分标准列表里勾选题目 → 加入试卷 → 调整顺序；**一道题都不挑也允许建卷**（图片答卷专用）
- [ ] 挑题列表展示「评分标准摘要」而不是学科/难度标签（界面已经不录这些字段）
- [ ] **评分系统：老师给一个整卷总分，AI 自动分配**（`POST /api/papers/:id/allocate`）：
  - `buildAllocateMessages()` 让 AI 按权重把总分分到每道大题（难的综合题多给、简单的少给），**不是平均分**
  - `normalizeAllocation()` 把 AI 结果按 seq 归位、夹 0~满分、按比例缩放并最后一项补差，**保证总和 = 整卷总分**；脏数据/全 0 → 退化成平均
  - 每道大题的分数再 `distributeEvenly()` **平均分给它的得分点（小题）**，写进 `paper_questions.item_points`
  - **自动触发**：`PUT /api/papers/:id/questions` 保存时，若设了整卷总分、有题目、且没手设大题分 → 自动分配；手设了大题分（带 `points`）→ 尊重手改、小题按平均重算（`recomputeItemPoints`）
- [ ] 试卷详情：题目清单（含分配的大题分 + 小题分）+ 总分 + 状态 + 提交/批改进度
- [ ] 发布：`draft → open`，发布后题目锁定（要改需先撤回）；**无题卷也能发布**
- [ ] 删除试卷（二次确认，**级联**：题目编排 + 该卷所有答卷、作答、评分单与明细、批量任务，`purgePaper`；确认里说明"会连带删掉 N 份答卷"）

**产出**：`routes/papers.js`、`lib/prompts.js`（分配部分）、`web/pages/papers.js`
**验收**：填整卷总分 100、挑两题保存 → 各题分值按权重分好、总和 = 100、小题平均；手改某题分值 → 尊重、小题重算；验收第 49~51 条

---

### M4 · 提交答卷（图片答卷为主路径）

- [ ] 三个页签，**顺序与默认档**：**图片答卷**（默认）/ 老师代录 / 学生自填
- [ ] **图片答卷**（主路径，**不用出题、不用先建卷**）：
  - 提交页默认画面：填**卷名 + 整卷总分**、选「这是谁的卷子」、一次选一组照片（压缩 + `/api/uploads` 落盘，**不调 `/api/import/parse`**）
  - 一步提交走 `POST /api/whole-submissions`：卷名对得上已有卷子就复用（草稿顺手开收、填的总分更新它），对不上就**自动建一份没有题目的卷子**
  - 照片挂到 `submissions.images`，`answers` 为空；后端 `MAX_WHOLE_IMAGES = 30`；`images` 与有内容的 `answers` 同时提交 → 400「请二选一」
  - **形态变了（逐题 ↔ 整卷）或已确认答卷的内容被改动 → 清 `grade_items` + `RESET_SHEET_SQL` 把评分单作废回 `ungraded`**
  - 提交页与批改页都标出这份答卷是「图片答卷」（没有逐题明细）
- [ ] **老师代录**：选试卷 + 选学生 → 逐题输入 → 每题可贴**多张**图（**逐张循环上传，不能只取 `files[0]`**）→ 保存并自动跳下一位
- [ ] **学生自填**：选名字 → 逐题作答 → 提交；已交学生显示已交状态
- [ ] 单文件导入：docx 从 `word/document.xml` 提取纯文本；txt 直接读（识别接口 `/api/import/parse` 保留，**前端暂不调用**）
- [ ] 图片上传：服务端写入 `data/attachments/`
- [ ] 修改已录入答案、标记缺考

**产出**：`routes/submissions.js`、`lib/prompts.js`（识别部分）、`web/pages/submissions.js`
**验收**：PRD 第 4 条 —— 三种方式各录一份，都正确归属到学生与卷；PRD 第 29 条 —— 提交页不调识别接口；PRD 第 35、36、40 条 —— 图片答卷不用出题、同名卷复用、两形态互斥

---

### M5 · AI 批改（核心）

- [ ] `server/ai/qwen.js`：调用千问 OpenAI 兼容接口，支持文本 + 图片混排
- [ ] 批改提示词（`lib/prompts.js`）：输入题干、参考答案、评分标准、学生答案 → **要求输出严格 JSON**：

```json
{
  "items": [
    { "index": 0, "score": 4, "reason": "受力图完整，判断依据正确", "confidence": 0.92 }
  ],
  "comment": "整体思路清晰"
}
```

- [ ] **两种判分模式**（PRD 5.4.2）：
  - `rubric`：学生交的是**文字** → `buildGradeMessages()`，逐条对照评分标准
  - `auto`：学生交的是**图片** → `buildAutoGradeMessages()`，**不给评分标准条目**，只要题干 + 参考答案 + 本题满分；提示词里说明"照片可能是整份答题卡连拍，只看属于这一题的部分"
  - 判定依据：`gradingModeOf(question)` 只看这一题有没有图片（`answerImages.length`）
  - `normalizeItems(parsed, question, threshold, mode)` 在 `auto` 下把期望条目固定为「整题一条」，得分夹到 `0 ~ question.points`
  - `grade_items.mode` 记下当时用的是哪种模式，批改页据此标注
- [ ] **第三种判分：整卷给分**（PRD 5.4.3，走「图片答案」交上来的答卷）：
  - 认入口：`wholeImagesOf(submission)` 读 `submissions.images`，有内容就走整卷这条路（`gradeSubmission` 里在逐题循环**之前**分流）
  - `buildWholeGradeMessages({ paperName, fullMarks, passLine, answer })`：payload 带 `task:'grade_whole'`，提示词要求**按整卷给一个总分、不要虚构题号逐题列分**，整组照片按 `image_url` 追加
  - `gradeWholeSubmission()`：一次调用，`score` 夹到 `0 ~ paperTotal`，`confidence < 阈值` 记 `whole_doubt`
  - 写库：**先 `DELETE FROM grade_items`**（与逐题明细互斥），把总分、理由、把握度、存疑、总评写进 `grade_sheets.whole_*`；逐题那条分支反过来要把 `whole_*`（含 `whole_wrong`）清空
  - 改分端点 `PUT /api/grade-sheets/:id/whole`：已确认锁定 409；`finalScore` 非负且不超 `paperTotal`；同时可改 `doubt` / `reason` / `comment`；逐题答卷打这个端点要 409 提示走逐题改分
  - 确认端点：整卷答卷用**整卷那个分**写 `final_total`（`sheetTotal(sheet)` 分流：整卷看 `whole_final_score → whole_ai_score → ai_total`，逐题才按明细求和）
- [ ] **判图片必须报错题**（PRD 5.4.3，验收 42~44）：
  - 提示词同一次调用多要一份 `wrong`：每条含 `no`（**只认卷面上写着的题号，看不清就留空、不许自己猜**）、`deduct`（扣多少分）、`where`（错在哪一处）、`issue`（错成了什么）；**优先按照片里印的评分机制扣分**、只列真错的、整份都对给 `[]`；**总分 = 满分 − 各错题 deduct 之和**
  - `prompts.js` 导出 `normalizeWrongList(raw)`：非数组当空、单条没有 `where`/`issue` 丢掉、兼容 `seq/at/reason` 别名、每段截到 200 字、最多 30 条 —— **脏数据不许进库**
  - 存 `grade_sheets.whole_wrong`（`TEXT DEFAULT '[]'`，`db.js` 用 `ensureColumn` 迁移）；`RESET_SHEET_SQL`、逐题批改分支、形态切换作废都要一并清掉
  - `gradeDetail()` 的 `whole.wrong` 用 `safeWrong()` 兜底（库里的 JSON 坏了也不能把批改页搞崩）；批改返回带 `wrong` / `wrongCount`
  - `PUT /api/grade-sheets/:id/whole` 接受 `wrong` 做**整份覆盖**：老师删掉 AI 认错的那条、或自己补一条
  - 批改页在三栏**下方**加 `wrongBlock()`：「图片评判 · AI 指出的错题」区块，只给图片答卷渲染（逐题答卷不出现）；已确认锁定时只读（不给删、不给补）
- [ ] 容错解析（`lib/json.js`）：剥离 ``` 包裹、截取首个完整 JSON、失败重试 1 次；仍失败则该份标为失败
- [ ] 存库：写入 `grade_sheets` 与 `grade_items`（`confidence < 0.75` 自动 `doubt=1`）
- [ ] **三栏批改页**：
  - 左：学生答案（图片 + 文本）
  - 中：参考答案 + 评分标准（与得分点逐条对应）；**若该题是 `auto` 模式，改为显示题干 + 「本题不看评分标准」说明，评分标准收进 `<details>` 折叠备查**
  - 右：AI 逐项给分 + 理由（存疑项高亮）；`auto` 模式的明细标「AI 自主评判」，判定用**明细自己的 mode**，不要拿 `rubricItems[i]` 硬套
  - 题号标签上给 `auto` 的题加一个小标记，老师一眼能看出哪些题没走评分标准
  - **整卷答卷另走一套布局**（`detail.kind === 'whole'`）：不渲染题号页签，改成 左=整组照片 / 中=整卷依据（试卷名、题数、满分、及格线、整卷自主评判徽标）/ 右=**唯一一个可改的总分**（理由 + 把握度 + 存疑勾选）；判据是接口返回的 `kind`，不要靠"明细条数"猜
  - **「图片评判」区块**（`wrongBlock()`）摆在三栏**下方**：逐条列「第 N 题 · 错在哪一处」+「错成了什么」，题号空的显示「题号看不清」；空清单说"AI 没有指出明显的错题"；每条带「删掉」，底部可「补一条」（题号可空 + 错在哪，**不写错在哪要拦下**）。这块**只给整卷答卷**渲染
- [ ] 改分：直接输数字或加减；改动即时落库，总分与整卷总分实时重算（PRD 第 6 条）；整卷答卷改的是 `[data-whole-score]`，改完底部总分同步
- [ ] 批注框、存疑手动切换
- [ ] 上一份 / 下一份（键盘 ← →）+ 队列筛选（待批 / 待确认 / 存疑）；队列条目要带 `whole` 标记，存疑筛选的判据是「明细存疑 **或** 整卷存疑」
- [ ] 确认锁定 / 解锁重批（解锁写 `audit_log`）
- [ ] **一键批量批改**：串行队列 + 轮询进度 + 暂停/继续 + 失败单列可重试
- [ ] 批量保护：跳过 `status='confirmed'` 的答卷；每份完成立即落库

**产出**：`routes/grading.js`、`routes/batch.js`、`services/grader.js`、`web/pages/grading.js`
**验收**：PRD 第 5、6、7 条 + 第 19、20、22~25 条 + 第 37、38 条（整卷一个总分、批改页整卷渲染）+ 第 42~44 条（报错题号与错在哪、图片评判区块、老师可核可改）

---

### M6 · 首页 + 今日计划 + 统计

- [ ] `/api/stats/home`：四张卡（待你批改 / 待你确认 / 需复核的存疑点 / 待讲评的题）+ 进行中试卷 + 双栏
- [ ] 首页四个卡片、四块区域，全部可点击下钻到对应模块的对应筛选视图
- [ ] 今日计划：自动汇总（今收答案、待批改、存疑待复核、待确认、刚发布未收卷）+ 手动提醒（增删勾）
- [ ] 自动条目「做完就消失」：直接由实时查询得出，不落库
- [ ] 统计页：班级概览（平均/最高/最低/及格率）、每题得分率排行、学生排名表
- [ ] 点某题 → 列出该题失分学生名单
- [ ] **整卷答卷（图片答案）的统计与首页口径**（PRD 5.5 / K20）：
  - `confirmedTotalOf(sheet, itemSum)`：整卷答卷按卷子上那个总分（`final_total → whole_final_score → whole_ai_score`）算，逐题答卷才用明细加总 → 平均分、最高最低、及格率、学生排名都走它
  - 学生排名行带 `whole` 标记，前端在姓名旁显示「图片答案」徽标
  - **每题得分率照旧只数逐题答卷**（`questions[].sheetCount` 不含整卷答卷），不要"顺手补齐"
  - 存疑口径两处相加：`grade_items.doubt=1` **加** `grade_sheets.whole_doubt=1`，`cardCounts()` / `progressOf()` / `focusPaper('doubt')` 三处都要改（`focusPaper` 用 `UNION ALL` 把整卷那条并进来源表）
  - `pendingWork()`：待确认列表带 `whole` 与整卷总分；存疑流用 `UNION ALL` 把整卷存疑并进来，整卷那条 `seq` 为 `null`
  - 首页存疑条目：`seq` 为 `null`（或 `whole`）时显示**「整卷」**，绝不渲染成「第 null 题」

**产出**：`routes/stats.js`、`routes/todos.js`、`web/pages/home.js`、`web/pages/stats.js`
**验收**：PRD 第 8~14 条 + 第 39 条（整卷进平均分与及格率、不进每题得分率；整卷存疑计入首页需复核卡）

---

### M7 · 设置 + 备份恢复 + 收尾

- [ ] 设置页：接口地址、模型名、API Key（打码显示，空则不覆盖；保存时写入用户主目录的私有配置文件，**不写数据库**）
- [ ] 「测试连接」按钮：调 `/api/settings/test-ai`，返回可用/不可用及原因
- [ ] 数据文件路径显示；更换位置（改完提示重启服务生效）
- [ ] `lib/zip.js`：零依赖 ZIP 打包（`zlib.deflateRawSync` + 手工写目录）
- [ ] 一键备份：打包 `paper.db`（可选含 `attachments/`）为 `backups/backup-YYYY-MM-DD-HHmm.zip`
- [ ] 备份列表、从备份恢复：**二次确认** → 自动把当前数据另存 → 覆盖 → 界面刷新
- [ ] 可选自动备份：每天首次启动备份一份，保留最近 7 份
- [ ] 全量回归：把 PRD 第 10 节 25 条逐条走一遍，记录结果

**产出**：`routes/settings.js`、`routes/backup.js`、`lib/zip.js`、`web/pages/settings.js`
**验收**：PRD 第 15~18 条

---

## 6. 关键实现要点与避坑

| 编号 | 要点 | 做法 |
| --- | --- | --- |
| K1 | `node:sqlite` 是**同步** API | 所有写操作包在 `db.exec('BEGIN')/COMMIT` 事务里；启动参数加 `--no-warnings` 抑制实验性警告 |
| K2 | AI 必须返回可解析的 JSON | 提示词里给死输出格式；代码里先剥离代码块围栏，再用括号配平截取；失败重试一次；仍失败就标记该份失败，**不污染其他份** |
| K3 | 图片上传不引依赖 | 前端把图片压到长边 ≤1600px 再转 base64 直传；服务端 `Buffer.from(b64,'base64')` 写盘；单张上限 8MB |
| K4 | 没有"保存"按钮 | 前端所有变更调 PUT，加 300ms 防抖；界面显示极轻的"已保存"提示 |
| K5 | 批量批改不能并发 | 串行队列，避免触发接口限流；进度存 `batch_jobs` 表，前端每 1.5s 轮询；暂停只置标志位，不中断当前这份 |
| K6 | 中断安全 | 每份批完立即落库，不攒批；服务重启后 `status='running'` 的任务恢复为 `paused`，由用户手动继续 |
| K7 | 端口占用 | 8756 起，被占用就 +1 重试，最多试 20 次；启动器把实际地址打印出来 |
| K8 | 自动开浏览器 | Windows：`start "" "http://127.0.0.1:<port>"` |
| K9 | Key 安全 | **代码里零 Key**（`DEFAULTS.apiKey = ''`）；Key 只存用户主目录的 `.paper-grading/config.local.json`（**项目文件夹之外**），**不进数据库、不进备份包**；`GET /api/settings` 只返回 `****后4位` + 配置文件路径；**不写日志、不写文档**。测试必须隔离 `rootDir` / `configDir`，`startApp` 会把真实项目目录直接判为错误（历史事故：测试把用户真实配置搬走并覆盖了 Key） |
| K10 | 统计口径易错 | 所有成绩类统计**只算已确认答卷**；未确认的批量结果不进统计（PRD 第 24 条） |
| K11 | docx 解析不引依赖 | 用内置 `zlib.inflateRawSync` 解压，正则取 `word/document.xml` 里的 `<w:t>` 文本 |
| K12 | 数据文件换位置 | 采用"改配置 + 提示重启"的简单方案，不做热切换，避免数据竞争 |
| K13 | **整卷拍照必须"一次上传一组"** | 一名学生的多页答题卡要放进**同一个** `images` 数组、**只调一次** `/api/import/parse`。一张一张传会丢掉跨页上下文，AI 也就没法判断题目归属。前端实现时切忌写成 `files[0]`——历史 bug：页签写了"支持图片"，实际只取第一张 |
| K14 | **界面收掉字段 ≠ 可以清空老数据** | 评分标准页删掉了学科/知识点/题型/难度，保存时就要**不提交**这些键；后端 `normalizePayload` 用 `pick(key, base[key])` 保住旧值。测试要同时断言"请求里没有这些键"和"库里旧值还在"，只测其中一头都会漏 |
| K15 | 前端页面测试的 DOM 垫片 | 垫片支持 `[data-x]` / `[data-x="v"]` / `.class`，并且能读**裸属性**（`<div data-picked>`）；元素对象按「父元素 + 位置」缓存，所以测试必须**跟页面一样从同一个父元素往下取**（例如提交页要从 `[data-tab-host]` 里取 `[data-file]`），否则拿到的是另一个对象，点不动也读不到。`select.value` 按浏览器语义返回**被选中项的 value**（读 `<option ... selected>`），否则测不出"默认选中第几张照片"这类默认值 |
| K16 | **级联删除不能只靠外键** | `paper_questions → questions`、`submissions → students` 这两条外键**故意没有** `ON DELETE CASCADE`（不然删一道题会顺手带走不相关的数据）。于是删除必须在事务里显式处理：先扫子树、再删主体，`purgeQuestion` 之后还要 `renumberPaper` 让题号连号。删除接口一律返回**删了多少东西**，前端据此写二次确认与结果提示 |
| K17 | **"能删掉"不等于"删干净"** | 四条链（评分标准 / 试卷 / 学生 / 答卷）各有各的关联面，边界必须逐个测：删一份试卷不能动另一份的答卷；删一名学生不能动同卷别人的成绩；删一道题不能动评分标准本身在别的试卷上的用法。测完顺手查一次"有没有指向已删记录的孤儿数据"（`grade_items/answers` 的 `paper_question_id` 是否都还有对应行） |
| K18 | **图片作答必须真的把图挂上去** | AI 只看 `answers.images` 有没有内容来决定用哪种判分模式。整卷拍照是"识别出文字 → 拆块 → 入库"，如果入库时只存文字（`images: []`），照片就丢了，批改只能退化成按文字判分。所以：识别前先把这组照片落盘拿路径，预览时按"每题来自第几张"挂到对应作答上，并允许老师手工改。测试要断言库里 `answers.images` 真的有值 |
| K19 | **两种作答形态互斥，切换必须作废旧批改** | 一份答卷只有一种形态：逐题作答（`answers`）**或**整份图片作答（`submissions.images`）。写库时要么清 `answers`、要么清 `images`，绝不允许"两边都有"；`images` 与有内容的 `answers` 一起提交直接 400。**形态变了，或已确认答卷的内容被改过，就把这份评分单整体作废回 `ungraded`**（清 `grade_items` + 一条 SQL 连 `whole_*` 一起清），否则会出现"锁着的 9 分挂在另一份作答上"。只原样重存（点开又保存）**不能**触发作废，不然会误清老师已确认的成绩 |
| K20 | **整卷分不能靠明细求和** | 整卷作答没有逐题明细，`sum(grade_items)` 恒为 0，直接沿用旧口径会让这份答卷"加了等于没加"。凡是要"老师看到的那个总分"的地方，都要走统一的 `sheetTotal(sheet)`：`whole_mode` 非空 → `whole_final_score → whole_ai_score → ai_total`；否则才按明细求和。涉及面比想象中广：队列总分、批改详情、确认落定的 `final_total`、`paperStats` 的平均分/及格率/排名、`pendingWork` 的待确认列表、`progressOf`/`cardCounts`/`focusPaper` 的存疑口径（**存疑要点是两处相**：`grade_items.doubt` + `grade_sheets.whole_doubt`）。唯一例外是**每题得分率**——整卷答卷不参与，这是设计如此，不是漏算 |
| K21 | **"整卷"在界面上必须有个说法** | 整卷存疑没有题号，`seq` 为 `null`。直接拼 `'第 ' + seq + ' 题'` 会渲染出「第 null 题」。所有展示题号的地方都要分流成「整卷」，同时给学生排名行标上「图片答案」徽标——否则老师会以为是数据错了 |
| K22 | **错题清单的题号只能来自卷面** | 判图片时 AI 要"报错题号 + 扣分 + 标错在哪"，但题号是它**从照片上读**的，不是我们的 `paper_questions.seq`。要求：① 提示词明说"只写卷面上学生自己写的或印着的题号，看不清就留空 `""`，绝对不要自己猜、不要按顺序编号"；② **每条错题带 `deduct`（扣多少分）**，且**总分 = 满分 − 各错题 deduct 之和**（`grader.gradeWholeSubmission` 强制算，不用 AI 的 score 字段；扣分依据优先照片里印的机制）；③ `normalizeWrongList()` 收拾脏数据——非数组当空、缺 `where`/`issue` 的单条丢掉、别名 `seq/at/reason` 兼容、`deduct` 缺省 0、每段截 200 字、最多 30 条，`safeWrong()` 再兜住库里可能存坏了的 JSON（坏了当空数组，绝不让它把批改页搞崩）；④ `whole_wrong` 要跟着形态切换一起清——`RESET_SHEET_SQL`、逐题批改分支、改回逐题作答三处都要带上，不然会有一份"幽灵错题清单"挂在另一形态的答卷上；⑤ 老师可整份覆盖：`PUT /api/grade-sheets/:id/whole` 接受 `wrong` 数组，前端 `wrongBlock()` 支持删一条、补一条，锁定后只读 |
| K23 | **AI 分配分值：小题分不能写进共享的评分标准** | 评分系统是"老师给一个整卷总分，AI 按权重分到每道大题，再**平均**分到小题"。小题（得分点）的分值**随试卷走**——同一道题在不同卷子里分到的分值不同，所以必须存进 `paper_questions.item_points`（JSON 数组），**绝不能写回 `question_items.points`**（那是评分标准自带的、被多份卷子共享）。要点：① 分配 = AI 分大题（`buildAllocateMessages` + `normalizeAllocation` 保证总和=总分、脏数据退化成平均）+ 算法分小题（`distributeEvenly`，前 n-1 项四舍五入、最后一项补差，保证精确）；② **自动触发要判"老师有没有手设分值"**：`PUT /api/papers/:id/questions` 里 `bodyHasPoints`（任意一项带 `points`）→ 尊重手改、只 `recomputeItemPoints` 重算小题；否则设了整卷总分才 AI 分配——否则每次保存都会覆盖老师手改的分值；③ **批改要改用分配后的分值**：`loadContext` 里得分点分值优先取 `item_points`（按 seq 对齐），没分配的老数据才回退 `question_items.points`；改单条得分点的满分上限也要走同一套（`grading.js` 里 `safeNumberArray` 按 seq 取）；④ 满分口径统一为 `paperFullMarks`：**整卷总分优先**，没给才有题目按各题之和、没题目按 100 |

---

## 7. 风险与对策

| 风险 | 影响 | 对策 |
| --- | --- | --- |
| AI 识别手写有误差 | 分数不准 | 定位为"初评辅助"：理由必须引用评分标准；低置信度自动标存疑；老师必须确认才进统计 |
| AI 返回格式跑偏 | 批改中断 | K2 的容错解析 + 单份失败隔离 + 一键重试 |
| 批量批改被限流 | 批量失败 | 串行 + 失败重试 + 可暂停；必要时在设置页加"每次请求间隔"参数 |
| 单文件数据库损坏 | 数据丢失 | 每次操作即时落库；一键备份 + 自动备份（保留 7 份）；恢复前自动另存 |
| 图片过大导致数据膨胀 | 性能下降 | 图片独立存 `attachments/`，压缩长边；备份可选不含图片 |
| 端口被占用 | 起不来 | K7 自动换端口 |
| `node:sqlite` 属实验特性 | 未来 API 可能变 | 只在 `db.js` 一处调用，隔离改动面；准备好降级方案（换 `better-sqlite3`） |

---

## 8. 验收对照表（PRD 第 10 节 → 里程碑）

| PRD 条目 | 归属里程碑 |
| --- | --- |
| 1、3、21 | M0 |
| 2 | M2 |
| 4 | M4 |
| 5、6、7 | M5 |
| 8、9、10、11 | M6 |
| 12、13、14 | M6 |
| 15、16、17、18 | M7 |
| 19、20 | M5 |
| 22、23、24、25 | M5 |
| 26 | M7（`test/keysafe.test.js`） |
| **27、28** | M0（导航）/ M2（评分标准页），由 `test/gradingfocus.test.js` 覆盖 |
| **29** | M4（整卷拍照），由 `test/gradingfocus.test.js` 覆盖 |
| **30** | M4（多图上传：整卷拍照 + 老师代录单题贴图），由 `test/gradingflow.test.js` 覆盖 |
| **31、32、33** | M0（`lib/cascade.js`）+ M1/M2/M3/M4（四个删除接口），由 `test/gradingflow.test.js` 覆盖 |
| **34** | M5（判分模式 `auto` / `rubric`）+ M4（照片归属标注）+ M5 批改页标注，由 `test/gradingflow.test.js` 覆盖 |
| **35、36、40** | M4（「图片答案」独立页签 + 两形态互斥），由 `test/wholeanswer.test.js` 覆盖 |
| **37、38** | M5（整卷给分 `grade_whole` + 批改页整卷渲染 + `PUT /api/grade-sheets/:id/whole`），由 `test/wholeanswer.test.js` 覆盖 |
| **39** | M6（统计与首页口径）+ M5（整卷存疑），由 `test/wholeanswer.test.js` 覆盖 |
| **41** | M0（`ensureColumn` 轻量迁移，见 `server/db.js` 的 `migrate()`），由 `test/wholeanswer.test.js` 覆盖 |
| **42、43、44** | M5（AI 报错题号与错在哪 → `whole_wrong` + `wrongBlock()`「图片评判」区块 + 老师可核可改），由 `test/wholeanswer.test.js` 覆盖 |
| **45、46、47、48** | M3（无题卷可发布 / 整卷总分是满分的唯一依据 / 总分不合法拦下 / 老数据升级补新列），由 `test/wholeanswer.test.js` 与 `test/m3.test.js` 覆盖 |
| **49、50、51** | M3（老师只给总分 AI 分到题 / 小题平均分 / 老师可手改），由 `test/allocate.test.js` 覆盖 |

---

## 9. 执行顺序建议

依赖关系是**线性的**，建议严格按顺序做，每个里程碑结束都停下来让你验一遍再往下：

```
M0 骨架 ──> M1 学生 ──> M2 评分标准 ──> M3 试卷 ──> M4 提交 ──> M5 批改 ──> M6 首页/统计 ──> M7 设置/备份
```

**第一个能看见成果的节点是 M0**：双击一下就能打开界面，八个页面的导航都在（内容是空的）。建议先只做 M0，你确认"启动方式和换页手感"没问题，再往下推——因为启动形态一旦定了，后面所有页面都建在它上面。

**第一个能跑通完整闭环的节点是 M5**：从录标准到 AI 打分到确认，主线全部打通。这一版就已经有实际使用价值了。

---

## 10. 开工前确认清单

- [ ] PRD v1.8 已认可
- [ ] 本开发计划已认可
- [ ] 明确说「开工」
- [ ] 确认第一个执行单元为 M0（骨架）
