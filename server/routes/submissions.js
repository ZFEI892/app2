'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const { all, get, run, tx, nowIso } = require('../db');
const { HttpError } = require('../router');
const { round2, paperFullMarks, passLine } = require('../lib/calc');
const { docxToText, splitBlocks } = require('../lib/zipread');
const { runChat } = require('../ai/qwen');
const { payloadBlock } = require('../lib/json');
const { purgeSubmission } = require('../lib/cascade');

const SOURCES = ['manual', 'self', 'import'];
const IMAGE_EXT = ['png', 'jpg', 'jpeg', 'webp', 'gif'];
const MAX_UPLOAD_BYTES = 8 * 1024 * 1024;
/** 「图片答卷」一次最多交多少张，防止误选整个相册 */
const MAX_WHOLE_IMAGES = 30;

/** 把一份答卷的批改结果整体作废，回到待批改（逐题明细与整卷评分、错题清单一并清） */
const RESET_SHEET_SQL =
  `UPDATE grade_sheets
      SET status = 'ungraded', ai_total = NULL, final_total = NULL,
          confirmed_at = NULL, error = '',
          whole_mode = '', whole_ai_score = NULL, whole_reason = '',
          whole_confidence = NULL, whole_doubt = 0, whole_final_score = NULL,
          whole_wrong = '[]',
          updated_at = ?
    WHERE id = ?`;

function safeJsonArray(text) {
  try {
    const v = JSON.parse(text);
    return Array.isArray(v) ? v : [];
  } catch (_) {
    return [];
  }
}

function paperRow(id) {
  const row = get('SELECT * FROM papers WHERE id = ?', id);
  if (!row) throw new HttpError(404, '试卷不存在');
  return row;
}

function submissionRow(id) {
  const row = get('SELECT * FROM submissions WHERE id = ?', id);
  if (!row) throw new HttpError(404, '答卷不存在');
  return row;
}

function paperQuestionIds(paperId) {
  return all('SELECT id, seq FROM paper_questions WHERE paper_id = ? ORDER BY seq', paperId);
}

function toSubmission(row) {
  const student = get('SELECT * FROM students WHERE id = ?', row.student_id);
  const sheet = get('SELECT * FROM grade_sheets WHERE submission_id = ?', row.id);
  const images = safeJsonArray(row.images);
  return {
    id: row.id,
    paperId: row.paper_id,
    studentId: row.student_id,
    studentName: student ? student.name : '(已删除)',
    sno: student ? student.sno : '',
    className: student ? student.class_name : '',
    source: row.source,
    status: row.status,
    // 整份图片作答（不挂题目）的这组照片；逐题作答时为空
    images,
    imageCount: images.length,
    wholeMode: images.length > 0,
    submittedAt: row.submitted_at,
    updatedAt: row.updated_at,
    gradeStatus: sheet ? sheet.status : 'ungraded',
    gradeSheetId: sheet ? sheet.id : null,
  };
}

/** 写入/覆盖一份答卷的全部答案或整份图片作答 */
function upsertSubmission(paper, payload) {
  const body = payload || {};
  const studentId = Number(body.studentId);
  if (!Number.isFinite(studentId)) throw new HttpError(400, '必须指定学生');
  const student = get('SELECT * FROM students WHERE id = ?', studentId);
  if (!student) throw new HttpError(400, '学生不存在');

  const source = SOURCES.includes(body.source) ? body.source : 'manual';
  const status = body.status === 'absent' ? 'absent' : 'submitted';
  const answersInput = Array.isArray(body.answers) ? body.answers : [];

  // 「图片答卷」：整张答题卡的照片直接交上来，不挂到任何题目上。
  // 它与逐题作答是二选一的两条路——一份答卷只会是其中一种形态。
  const wholeInput = Array.isArray(body.images) ? body.images.map(String).filter(Boolean) : [];
  if (wholeInput.length > MAX_WHOLE_IMAGES) {
    throw new HttpError(400, `「图片答卷」一次最多 ${MAX_WHOLE_IMAGES} 张`);
  }
  const wholeMode = wholeInput.length > 0;
  const hasAnswerContent = answersInput.some(
    (a) => a && ((a.text !== undefined && String(a.text) !== '') || (Array.isArray(a.images) && a.images.length))
  );
  if (wholeMode && hasAnswerContent) {
    throw new HttpError(400, '「图片答卷」是整份交上来的，不能再逐题交答案，请二选一。');
  }

  const pqList = paperQuestionIds(paper.id);
  const byId = new Map(pqList.map((r) => [r.id, r]));
  const bySeq = new Map(pqList.map((r) => [r.seq, r]));

  const prepared = [];
  answersInput.forEach((raw, idx) => {
    let target = null;
    if (raw.paperQuestionId !== undefined && raw.paperQuestionId !== null) {
      target = byId.get(Number(raw.paperQuestionId));
    }
    if (!target && raw.seq !== undefined && raw.seq !== null) {
      target = bySeq.get(Number(raw.seq));
    }
    if (!target) {
      throw new HttpError(400, `第 ${idx + 1} 条答案没有对应到本试卷的题目`);
    }
    prepared.push({
      paperQuestionId: target.id,
      text: String(raw.text === undefined || raw.text === null ? '' : raw.text),
      images: Array.isArray(raw.images) ? raw.images.map(String) : [],
    });
  });

  return tx((db) => {
    const now = nowIso();
    let row = get('SELECT * FROM submissions WHERE paper_id = ? AND student_id = ?', paper.id, studentId);
    const previousWhole = row ? safeJsonArray(row.images) : [];
    let submissionId;
    if (row) {
      db.prepare(
        'UPDATE submissions SET source = ?, status = ?, images = ?, submitted_at = ?, updated_at = ? WHERE id = ?'
      ).run(source, status, JSON.stringify(wholeInput), status === 'submitted' ? now : row.submitted_at, now, row.id);
      submissionId = row.id;
    } else {
      const info = db.prepare(
        `INSERT INTO submissions(paper_id, student_id, source, status, images, submitted_at, updated_at)
         VALUES(?,?,?,?,?,?,?)`
      ).run(paper.id, studentId, source, status, JSON.stringify(wholeInput), status === 'submitted' ? now : null, now);
      submissionId = Number(info.lastInsertRowid);
    }

    // 先记下改动前的答案，用于判断这次保存有没有真的改动内容
    const previous = db.prepare(
      'SELECT paper_question_id, text, images FROM answers WHERE submission_id = ?'
    ).all(submissionId);

    if (wholeMode) {
      // 换成整份图片作答：逐题答案就没有意义了，清掉
      db.prepare('DELETE FROM answers WHERE submission_id = ?').run(submissionId);
    } else {
      const stmt = db.prepare(
        `INSERT INTO answers(submission_id, paper_question_id, text, images, updated_at)
         VALUES(?,?,?,?,?)
         ON CONFLICT(submission_id, paper_question_id)
         DO UPDATE SET text = excluded.text, images = excluded.images, updated_at = excluded.updated_at`
      );
      prepared.forEach((a) => {
        stmt.run(submissionId, a.paperQuestionId, a.text, JSON.stringify(a.images), now);
      });
    }

    let sheet = get('SELECT * FROM grade_sheets WHERE submission_id = ?', submissionId);
    if (!sheet) {
      db.prepare(
        'INSERT INTO grade_sheets(submission_id, status, created_at, updated_at) VALUES(?,?,?,?)'
      ).run(submissionId, 'ungraded', now, now);
      sheet = get('SELECT * FROM grade_sheets WHERE submission_id = ?', submissionId);
    }

    // 「形态变了」（逐题 ↔ 整份图片）→ 旧的批改结果属于另一种形态，直接作废。
    const morphChanged = (previousWhole.length > 0) !== wholeMode;
    // 同一种形态里内容被改过、而这份答卷此前已确认锁定 → 锁定的分数不再对应新内容，必须作废重批。
    // 只是原样重存（比如点开又保存了一次）不会触发，避免误清老师已确认的成绩。
    const contentChanged = wholeMode
      ? !(previousWhole.length === wholeInput.length && previousWhole.every((p, i) => p === wholeInput[i]))
      : !(prepared.length === previous.length && prepared.every((a) => {
        const prev = previous.find((p) => p.paper_question_id === a.paperQuestionId);
        return Boolean(prev) && prev.text === a.text && prev.images === JSON.stringify(a.images);
      }));

    if (morphChanged || (contentChanged && sheet.status === 'confirmed')) {
      db.prepare('DELETE FROM grade_items WHERE grade_sheet_id = ?').run(sheet.id);
      db.prepare(RESET_SHEET_SQL).run(now, sheet.id);
      if (sheet.status === 'confirmed') {
        db.prepare(
          "INSERT INTO audit_log(entity, entity_id, action, detail, created_at) VALUES('grade_sheet', ?, 'reset_on_resubmit', ?, ?)"
        ).run(sheet.id, morphChanged ? '作答形态改变，已作废原确认结果' : '答案被修改，已作废原确认结果', now);
      }
    }

    // 有新答案进来，试卷就还在进行中：从「待作答」或「已完成」回到「收卷中」
    if (status === 'submitted' && (paper.status === 'open' || paper.status === 'done')) {
      db.prepare('UPDATE papers SET status = ?, updated_at = ? WHERE id = ?').run('collecting', now, paper.id);
    }

    return submissionRow(submissionId);
  });
}

function register(router) {
  router.get('/api/papers/:pid/submissions', (ctx) => {
    const paper = paperRow(ctx.params.pid);
    const pqList = paperQuestionIds(paper.id);
    const subs = all('SELECT * FROM submissions WHERE paper_id = ?', paper.id);
    const byStudent = new Map(subs.map((s) => [s.student_id, s]));
    const answerCounts = all(
      `SELECT a.submission_id, COUNT(*) AS c FROM answers a
         JOIN submissions s ON s.id = a.submission_id
        WHERE s.paper_id = ?
        GROUP BY a.submission_id`,
      paper.id
    ).reduce((acc, r) => { acc[r.submission_id] = r.c; return acc; }, {});

    const students = all('SELECT * FROM students ORDER BY class_name, sno, name').map((stu) => {
      const sub = byStudent.get(stu.id);
      const sheet = sub ? get('SELECT * FROM grade_sheets WHERE submission_id = ?', sub.id) : null;
      return {
        studentId: stu.id,
        name: stu.name,
        sno: stu.sno || '',
        className: stu.class_name || '',
        submissionId: sub ? sub.id : null,
        status: sub ? sub.status : null,
        source: sub ? sub.source : null,
        submittedAt: sub ? sub.submitted_at : null,
        answerCount: sub ? (answerCounts[sub.id] || 0) : 0,
        imageCount: sub ? safeJsonArray(sub.images).length : 0,
        questionCount: pqList.length,
        gradeStatus: sheet ? sheet.status : null,
        gradeSheetId: sheet ? sheet.id : null,
      };
    });

    return {
      paper: { id: paper.id, name: paper.name, status: paper.status },
      questionCount: pqList.length,
      students,
      submitted: subs.filter((s) => s.status === 'submitted').length,
      absent: subs.filter((s) => s.status === 'absent').length,
      total: students.length,
    };
  });

  router.post('/api/papers/:pid/submissions', (ctx) => {
    const paper = paperRow(ctx.params.pid);
    if (paper.status === 'draft') {
      throw new HttpError(409, '试卷还是草稿，请先发布后再收答案。');
    }
    const row = upsertSubmission(paper, ctx.body);
    return { submission: toSubmission(row) };
  });

  router.post('/api/papers/:pid/submissions/import', (ctx) => {
    const paper = paperRow(ctx.params.pid);
    if (paper.status === 'draft') {
      throw new HttpError(409, '试卷还是草稿，请先发布后再收答案。');
    }
    const items = (ctx.body || {}).items;
    if (!Array.isArray(items) || !items.length) throw new HttpError(400, '没有可导入的答卷');
    const created = items.map((item) => toSubmission(upsertSubmission(paper, { ...item, source: 'import' })));
    return { created: created.length, submissions: created };
  });

  /**
   * 「图片答卷」一步提交 —— 老师**不用出题、也不用先建卷**：
   * 填一个卷名、交一组照片，就成了这份卷子上该学生的一份整卷图片作答。
   * 卷名对得上已有卷子就复用（草稿卷顺手开收），对不上就自动建一份**没有题目**的卷子。
   * 满分由 paperFullMarks 定：卷子里有题目就按题目总分算，无题卷才用提交时填的那个。
   */
  router.post('/api/whole-submissions', (ctx) => {
    const body = ctx.body || {};
    const images = Array.isArray(body.images) ? body.images.map(String).filter(Boolean) : [];
    if (!images.length) throw new HttpError(400, '请先选照片');
    const name = String(body.paperName || '').trim();

    let paper = null;
    if (body.paperId !== undefined && body.paperId !== null && body.paperId !== '') {
      paper = paperRow(Number(body.paperId));
    } else if (name) {
      paper = get('SELECT * FROM papers WHERE name = ? ORDER BY id DESC LIMIT 1', name);
    }

    if (!paper) {
      if (!name) throw new HttpError(400, '请填一个卷名（不知道填什么就写日期，比如「10 月月考」）');
      const marks = body.wholeFullMarks === undefined || body.wholeFullMarks === null || body.wholeFullMarks === ''
        ? null : Number(body.wholeFullMarks);
      if (marks !== null && (!Number.isFinite(marks) || marks <= 0)) {
        throw new HttpError(400, '整卷满分必须是大于 0 的数字');
      }
      const now = nowIso();
      // 直接建成「开放收卷」状态：这份卷子就是用来收图片答卷的，不需要再走发布
      const info = run(
        'INSERT INTO papers(name, status, pass_line, whole_full_marks, created_at, updated_at) VALUES(?,?,?,?,?,?)',
        name, 'open', 0, marks, now, now
      );
      paper = paperRow(info.lastInsertRowid);
    } else {
      // 卷子已存在：老师填的整卷总分就是这份卷子的整卷总分，照收（有无题目都认）。
      // 有题目的话，改完总分各题分值不会自动跟着变——老师可以到「试卷」页让 AI 重新分配。
      if (body.wholeFullMarks !== undefined && body.wholeFullMarks !== null && body.wholeFullMarks !== '') {
        const marks = Number(body.wholeFullMarks);
        if (!Number.isFinite(marks) || marks <= 0) throw new HttpError(400, '整卷满分必须是大于 0 的数字');
        run('UPDATE papers SET whole_full_marks = ?, updated_at = ? WHERE id = ?', marks, nowIso(), paper.id);
      }
      // 草稿卷也直接开收：图片答卷不需要挑题，卡在草稿上只会让人白跑一趟
      if (paper.status === 'draft') {
        run("UPDATE papers SET status = 'open', updated_at = ? WHERE id = ?", nowIso(), paper.id);
      }
      paper = paperRow(paper.id);
    }

    const saved = upsertSubmission(paper, {
      studentId: body.studentId,
      source: SOURCES.includes(body.source) ? body.source : 'import',
      status: 'submitted',
      images,
      answers: [],
    });
    return {
      paper: { id: paper.id, name: paper.name, status: paper.status },
      submission: toSubmission(saved),
      fullMarks: paperFullMarks(paper),
      passLine: passLine(paper),
      // 这份卷子现在有几份答卷（同名卷会复用，让老师知道这份交到哪儿、攒了几份）
      submissionCount: get('SELECT COUNT(*) AS c FROM submissions WHERE paper_id = ?', paper.id).c,
    };
  });

  router.get('/api/submissions/:id', (ctx) => {
    const row = submissionRow(ctx.params.id);
    const paper = paperRow(row.paper_id);
    const answers = all(
      `SELECT pq.id AS paper_question_id, pq.seq, COALESCE(pq.points, q.points) AS points,
              q.stem, q.ref_answer, q.rubric_type, q.rubric_text,
              a.text, a.images
         FROM paper_questions pq
         JOIN questions q ON q.id = pq.question_id
    LEFT JOIN answers a ON a.paper_question_id = pq.id AND a.submission_id = ?
        WHERE pq.paper_id = ?
        ORDER BY pq.seq`,
      row.id,
      paper.id
    ).map((r) => ({
      paperQuestionId: r.paper_question_id,
      seq: r.seq,
      points: round2(r.points || 0),
      stem: r.stem,
      refAnswer: r.ref_answer,
      rubricType: r.rubric_type,
      rubricText: r.rubric_text,
      hasText: r.text !== null && r.text !== undefined,
      text: r.text || '',
      images: safeJsonArray(r.images),
    }));

    return {
      submission: toSubmission(row),
      paper: { id: paper.id, name: paper.name, status: paper.status },
      // 整份图片作答的那组照片（逐题作答时为空）
      images: safeJsonArray(row.images),
      answers,
    };
  });

  router.put('/api/submissions/:id', (ctx) => {
    const row = submissionRow(ctx.params.id);
    const paper = paperRow(row.paper_id);
    const body = ctx.body || {};
    const merged = {
      studentId: row.student_id,
      source: body.source === undefined ? row.source : body.source,
      status: body.status === undefined ? row.status : body.status,
      answers: body.answers === undefined ? undefined : body.answers,
    };

    if (merged.answers === undefined) {
      return tx((db) => {
        db.prepare('UPDATE submissions SET status = ?, source = ?, updated_at = ? WHERE id = ?')
          .run(merged.status === 'absent' ? 'absent' : 'submitted', merged.source, nowIso(), row.id);
        return { submission: toSubmission(submissionRow(row.id)) };
      });
    }
    const saved = upsertSubmission(paper, merged);
    return { submission: toSubmission(saved) };
  });

  router.del('/api/submissions/:id', (ctx) => {
    const row = submissionRow(ctx.params.id);
    const removed = tx((db) => purgeSubmission(db, row.id));
    return { ok: true, deleted: row.id, removed };
  });

  router.post('/api/uploads', (ctx) => {
    const body = ctx.body || {};
    const raw = String(body.data || '');
    const m = raw.match(/^data:([^;]+);base64,(.*)$/);
    const base64 = m ? m[2] : raw;
    const mime = m ? m[1] : 'application/octet-stream';
    if (!base64) throw new HttpError(400, '缺少图片数据');

    let buf;
    try {
      buf = Buffer.from(base64, 'base64');
    } catch (_) {
      throw new HttpError(400, '图片数据不是合法 base64');
    }
    if (!buf.length) throw new HttpError(400, '图片内容为空');
    if (buf.length > MAX_UPLOAD_BYTES) throw new HttpError(413, '单张图片不能超过 8MB');

    let ext = String(body.ext || '').toLowerCase().replace(/^\./, '');
    if (!ext) {
      const guess = mime.split('/')[1] || 'png';
      ext = guess === 'jpeg' ? 'jpg' : guess;
    }
    if (!IMAGE_EXT.includes(ext)) throw new HttpError(400, `不支持的图片格式：${ext}`);

    const name = 'img-' + Date.now().toString(36) + '-' + crypto.randomBytes(4).toString('hex') + '.' + ext;
    fs.writeFileSync(path.join(ctx.attachmentsDir, name), buf);
    return { path: name, url: '/files/' + name, size: buf.length, mime };
  });

  /**
   * 识别接口：把一组答题卡照片（或 docx / txt）读成文字，并尽量按题号分块。
   *
   * ⚠️ 现状：**前端已经不再调它了**。提交页的主路径是「图片答卷」——
   * 一组照片直接交给 AI 看整卷给分，不拆题、不要求卷子里有题目（见 /api/whole-submissions）。
   * 这个接口留着是因为它有独立价值（识别结果按「第N题（图M）」分块、越界编号兜底），
   * 将来若要做"识别成文字再核对"的辅助功能可以直接用；目前只在测试里被直接验证。
   */
  router.post('/api/import/parse', async (ctx) => {
    const body = ctx.body || {};
    const kind = String(body.kind || 'text');
    let text = '';
    // 只有整卷拍照会有多张图；docx / txt 没有照片可挂
    let imageCount = 0;

    if (kind === 'text') {
      text = String(body.text || '');
      if (!text.trim()) throw new HttpError(400, '文本内容为空');
    } else if (kind === 'docx') {
      const base64 = String(body.data || '').replace(/^data:[^;]+;base64,/, '');
      if (!base64) throw new HttpError(400, '缺少文件数据');
      try {
        text = docxToText(Buffer.from(base64, 'base64'));
      } catch (err) {
        throw new HttpError(400, 'docx 解析失败：' + err.message);
      }
      if (!text.trim()) throw new HttpError(400, 'docx 里没有读到文字');
    } else if (kind === 'image') {
      const images = Array.isArray(body.images) ? body.images : [];
      if (!images.length) throw new HttpError(400, '缺少图片');
      imageCount = images.length;
      const content = [{ type: 'text', text: ocrPrompt(images.length) }];
      images.forEach((dataUrl) => {
        content.push({ type: 'image_url', image_url: { url: dataUrl } });
      });
      const reply = await runChat(ctx, [{ role: 'user', content }]);
      text = String(reply || '');
      if (!text.trim()) throw new HttpError(502, 'AI 没有识别出内容');
    } else {
      throw new HttpError(400, `不支持的导入类型：${kind}`);
    }

    const blocks = splitBlocks(text).map((b) => ({
      ...b,
      // 越界的照片编号当作没标（AI 偶尔会数错），宁可让老师自己选
      image: b.image && b.image >= 1 && b.image <= imageCount ? b.image : null,
    }));
    const students = all('SELECT id, name, sno, class_name FROM students');
    let suggestedStudentId = null;
    if (body.studentId) {
      suggestedStudentId = Number(body.studentId);
    } else {
      const hit = students.find((s) => text.includes(s.name));
      if (hit) suggestedStudentId = hit.id;
    }

    return {
      kind,
      raw: text,
      blocks,
      imageCount,
      suggestedStudentId,
      needsReview: true,
      message: '已识别出文字，请核对后再入库',
    };
  });
}

function ocrPrompt(imageCount) {
  return [
    '你是一个手写试卷识别的助手。下面是同一名学生的答题卡照片，可能有好几张。',
    '请把照片里学生写的答案逐题转写成文字，尽量保留原始表达，不要批改、不要评分。',
    '输出格式：每题一行，以「第N题（图M）」开头。M 是这一题的内容主要出现在第几张照片里，从 1 开始数。例如：',
    '第1题（图1） 根据 h=1/2gt² 得 t=√(2h/g)=3s',
    '第2题（图2） 受力分析如图所示，合力为零',
    '注意：题目内容在哪张照片里就必须标哪一张，一道题的内容可能跨两张照片，那就标它最主要的那张。',
    '不要漏掉任何一道在照片里出现的题，也不要自己编题号。',
    '',
    '只输出识别结果，不要添加解释。',
    payloadBlock({ task: 'ocr', imageCount }),
  ].join('\n');
}

module.exports = { register, splitBlocks, ocrPrompt, MAX_UPLOAD_BYTES };
