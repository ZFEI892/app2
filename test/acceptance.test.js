'use strict';

/**
 * PRD 第 10 节「可以实际检查的验收标准」逐条落地。
 * 前 25 条在这里，每条一个测试，测名里写明是第几条；
 * 第 26 条（API Key 不出现在项目文件夹里）归 test/keysafe.test.js 管。
 *
 * 少数条目依赖桌面环境（比如"浏览器真的自己弹出来"），
 * 测试里只能验证到能自动化的那部分，注释里会写清楚边界。
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const { spawn } = require('node:child_process');

const { startApp, ok, tempDir, ROOT_DIR } = require('./helpers');
const { loadFrontend, has, metricCards } = require('./dom');
const { readZipEntry } = require('../server/lib/zipread');
const { extractPayload } = require('../server/lib/json');
const { getDb } = require('../server/db');
const { HttpError } = require('../server/router');

const PNG_1PX = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
const SETTINGS_PAGES = ['pages/settings.js'];
const HOME_PAGES = ['pages/home.js', 'pages/stats.js', 'pages/grading.js'];

/* ------------------------------------------------------------------ 公共装置 */

const Q_ITEMS = {
  stem: '一物体从 45 m 高处自由下落，求落地时间。',
  refAnswer: 't = √(2h/g) = 3 s',
  rubricType: 'items',
  items: [
    { text: '正确写出位移公式 h = ½gt²', points: 4 },
    { text: '结果与单位规范', points: 2 },
  ],
  subject: '物理',
  knowledge: '自由落体',
};

const Q_TEXT = {
  stem: '简述牛顿第一定律。',
  refAnswer: '一切物体在没有受到外力作用时，总保持静止或匀速直线运动状态。',
  rubricType: 'text',
  rubricText: '答出「保持静止或匀速直线运动」得 3 分，答出「惯性」再得 1 分。',
  points: 4,
  subject: '物理',
};

/** 起一份有题有卷的现场 */
async function scene(ctx) {
  const q1 = ok(await ctx.api.post('/api/questions', Q_ITEMS)).question;
  const q2 = ok(await ctx.api.post('/api/questions', Q_TEXT)).question;
  const paper = ok(await ctx.api.post('/api/papers', { name: '第一次月考' })).paper;
  const saved = ok(await ctx.api.put('/api/papers/' + paper.id + '/questions', {
    questions: [{ questionId: q1.id }, { questionId: q2.id }],
  }));
  ok(await ctx.api.post('/api/papers/' + paper.id + '/publish', {}));
  return { paper, questions: saved.questions };
}

async function addStudent(ctx, name) {
  return ok(await ctx.api.post('/api/students', { name, className: '高一(1)班' })).student;
}

async function submitAnswers(ctx, paper, questions, studentId, source, firstText) {
  return ok(await ctx.api.post('/api/papers/' + paper.id + '/submissions', {
    studentId,
    source: source || 'manual',
    answers: [
      { paperQuestionId: questions[0].paperQuestionId, text: firstText || '由 h=½gt² 得 t=3 s' },
      { paperQuestionId: questions[1].paperQuestionId, text: '物体保持静止或匀速直线运动' },
    ],
  })).submission;
}

/** 批改 → 按目标改分 → 可选确认 */
async function gradeWith(ctx, submissionId, targets, confirm) {
  const t = targets || {};
  const graded = ok(await ctx.api.post('/api/submissions/' + submissionId + '/grade', {}));
  const d = graded.detail;
  if (t.q1) {
    for (let i = 0; i < t.q1.length; i += 1) {
      if (t.q1[i] !== null && t.q1[i] !== undefined) {
        ok(await ctx.api.put('/api/grade-items/' + d.questions[0].items[i].id, { finalScore: t.q1[i] }));
      }
    }
  }
  if (t.q2 !== null && t.q2 !== undefined) {
    ok(await ctx.api.put('/api/grade-items/' + d.questions[1].items[0].id, { finalScore: t.q2 }));
  }
  if (confirm) ok(await ctx.api.post('/api/grade-sheets/' + d.gradeSheet.id + '/confirm', {}));
  return d;
}

/**
 * 一个分数被钉死的假 AI：第 1 题（两项）给 3 分和 2 分，其余题给满分。
 * 用来验证"改某一项分数后总分同步"这种对具体数字敏感的验收条目。
 */
function fixedGradeAi() {
  return async (messages) => {
    const reversed = [...messages].reverse();
    const multi = reversed.find((m) => Array.isArray(m.content));
    const textPart = multi ? multi.content.find((p) => p.type === 'text') : null;
    const lastString = reversed.find((m) => typeof m.content === 'string');
    const payload = extractPayload(textPart ? textPart.text : '')
      || extractPayload(lastString ? lastString.content : '');
    if (!payload || payload.task !== 'grade') return '{}';
    // 分项评分标准那道题：第一项 3 分、第二项 2 分；整体给分那道题给满分
    const perItem = payload.rubricType === 'items' ? [3, 2] : [Number(payload.items[0].points)];
    return JSON.stringify({
      items: payload.items.map((it, i) => ({
        index: i,
        score: perItem[i],
        reason: `依据评分标准「${it.text}」判断：作答符合该条要求。`,
        confidence: 0.9,
      })),
      comment: '固定测试回包。',
    });
  };
}

/** 造一个本地假 AI 服务（OpenAI 兼容），用来验证真实调用链路 */
function startFakeAi(replyBuilder) {
  const received = [];
  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      let body = null;
      try { body = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch (_) { body = null; }
      received.push({ url: req.url, headers: req.headers, body });
      const content = replyBuilder(body);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ choices: [{ message: { role: 'assistant', content } }] }));
    });
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      resolve({ server, received, port: server.address().port, url: 'http://127.0.0.1:' + server.address().port });
    });
  });
}

/** 只允许访问本机：一旦有代码往互联网发请求，就会带着 URL 抛错 */
function guardNetwork(allowedPrefix) {
  const real = global.fetch;
  const calls = [];
  global.fetch = (url, opts) => {
    const u = String(url);
    calls.push(u);
    const local = /^https?:\/\/127\.0\.0\.1[:/]/.test(u) || /^https?:\/\/localhost[:/]/.test(u);
    if (!local && !(allowedPrefix && u.startsWith(allowedPrefix))) {
      throw new Error('检测到对外网络请求：' + u);
    }
    return real(url, opts);
  };
  return { calls, restore: () => { global.fetch = real; } };
}

/** 启动一个真正的服务子进程，用来验证"关掉服务再打开" */
async function spawnServer(env) {
  const child = spawn(process.execPath, ['--no-warnings', path.join(ROOT_DIR, 'server', 'index.js')], {
    env: {
      ...process.env,
      NO_OPEN: '1',
      // 子进程的「项目目录」和「私有配置目录」都要隔离到临时目录，
      // 否则它们会去搬动/覆盖用户真实的配置
      APP_ROOT_DIR: tempDir('pgroot-'),
      APP_CONFIG_DIR: tempDir('pgcfg-'),
      // 关键：显式走模拟 AI。否则子进程会读到「本机真实配置里的 Key」真的联网调大模型，
      // 测试就变成一个依赖外部账号、还会花钱、还未必稳定的东西了。
      APP_AI_MODE: 'mock',
      ...env,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let output = '';
  child.stdout.on('data', (d) => { output += String(d); });
  child.stderr.on('data', (d) => { output += String(d); });
  const deadline = Date.now() + 15000;
  for (;;) {
    const m = output.match(/http:\/\/127\.0\.0\.1:(\d+)/);
    if (m) return { child, port: Number(m[1]), base: 'http://127.0.0.1:' + m[1], output: () => output };
    if (Date.now() > deadline) throw new Error('服务子进程没起来：' + output);
    await new Promise((r) => setTimeout(r, 60));
  }
}

function killServer(child) {
  return new Promise((resolve) => {
    if (child.exitCode !== null || child.signalCode) return resolve();
    child.once('exit', () => resolve());
    child.kill();
    setTimeout(() => { try { child.kill('SIGKILL'); } catch (_) { /* 已经没了 */ } resolve(); }, 3000);
  });
}

/* ------------------------------------------------- 10.1 启动与持久化 */

test('验收 1 · 双击启动器能起服务并自动打开浏览器（桌面弹窗部分无法在测试里验证）', async (t) => {
  const bat = fs.readFileSync(path.join(ROOT_DIR, '启动.bat'), 'utf8');
  assert.ok(bat.includes('server\\index.js'), '启动器必须去跑服务入口');
  assert.ok(bat.includes('chcp 65001'), '中文要能正常显示');

  const { main } = require('../server/index.js');
  assert.strictEqual(typeof main, 'function');

  // 服务真能起来，并且首页能打开
  const ctx = await startApp({ port: 8756 });
  t.after(() => ctx.close());
  const index = await fetch(ctx.base + '/');
  assert.strictEqual(index.status, 200);
  const html = await index.text();
  has(html, '试卷批改');
  assert.strictEqual(ok(await ctx.api.get('/api/health')).ok, true);
  // 自动开浏览器由 index.js 在 NO_OPEN!=1 时触发；测试环境用 NO_OPEN=1 跳过
});

test('验收 2 · 关服务再重启，题目内容一字不差', async (t) => {
  const dir = tempDir('pgaccept-');
  const dbFile = path.join(dir, 'paper.db');

  let srv = await spawnServer({ APP_DB_FILE: dbFile, PORT: '0' });
  t.after(() => killServer(srv.child));

  const base1 = srv.base;
  const created = await (await fetch(base1 + '/api/questions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(Q_ITEMS),
  })).json();
  assert.ok(created.question.id, '题目应创建成功');

  // 关掉服务（相当于关掉启动窗口）
  await killServer(srv.child);

  // 再启动一次（相当于重新双击启动器）
  srv = await spawnServer({ APP_DB_FILE: dbFile, PORT: '0' });

  const list = await (await fetch(srv.base + '/api/questions')).json();
  assert.strictEqual(list.total, 1);
  const q = list.questions[0];
  assert.strictEqual(q.stem, Q_ITEMS.stem, '题干必须一字不差');
  assert.deepStrictEqual(
    q.items.map((i) => [i.text, i.points]),
    Q_ITEMS.items.map((i) => [i.text, i.points]),
    '评分标准必须一字不差'
  );
});

test('验收 3 · 关掉浏览器后重新打开，数据仍然完整', async (t) => {
  const ctx = await startApp();
  t.after(() => ctx.close());
  const { paper, questions } = await scene(ctx);
  const stu = await addStudent(ctx, '张三');
  await submitAnswers(ctx, paper, questions, stu.id);
  const before = ok(await ctx.api.get('/api/papers/' + paper.id));

  // 关掉浏览器 = 重新渲染一次页面（服务端数据不受影响）
  const { registry, root } = loadFrontend(ctx.base, HOME_PAGES);
  await registry.grading.render(root, { paper: String(paper.id) });
  has(root.innerHTML, '第一次月考');

  const after = ok(await ctx.api.get('/api/papers/' + paper.id));
  assert.deepStrictEqual(after.questions.map((q) => q.stem), before.questions.map((q) => q.stem));
  assert.strictEqual(after.paper.progress.submissionCount, 1);
});

/* ------------------------------------------------- 10.2 主线流程 */

test('验收 4 · 三种方式各录一份，都正确归属到对应学生与题目', async (t) => {
  const ctx = await startApp();
  t.after(() => ctx.close());
  const { paper, questions } = await scene(ctx);

  const s1 = await addStudent(ctx, '张三');
  const s2 = await addStudent(ctx, '李四');
  const s3 = await addStudent(ctx, '王五');

  await submitAnswers(ctx, paper, questions, s1.id, 'manual', '老师代录的答案');
  await submitAnswers(ctx, paper, questions, s2.id, 'self', '学生自填的答案');

  // 导入：先用导入解析接口处理一份「答题卡文本」，再按解析结果落库
  const parsed = ok(await ctx.api.post('/api/import/parse', {
    kind: 'text',
    text: '王五\n第1题 导入的第 1 题答案\n第2题 导入的第 2 题答案',
  }));
  assert.strictEqual(parsed.blocks.length, 2);
  assert.strictEqual(parsed.suggestedStudentId, s3.id, '文本里出现姓名就该认出学生');
  ok(await ctx.api.post('/api/papers/' + paper.id + '/submissions', {
    studentId: parsed.suggestedStudentId,
    source: 'import',
    answers: parsed.blocks.map((b) => ({ seq: Number(b.label), text: b.text })),
  }));

  const list = ok(await ctx.api.get('/api/papers/' + paper.id + '/submissions'));
  assert.strictEqual(list.submitted, 3);
  const byName = Object.fromEntries(list.students.map((s) => [s.name, s]));
  const detail1 = ok(await ctx.api.get('/api/submissions/' + byName['张三'].submissionId));
  assert.strictEqual(detail1.answers[0].text, '老师代录的答案');
  assert.strictEqual(detail1.answers[0].seq, 1);
  assert.strictEqual(detail1.answers[1].seq, 2);
  const detail3 = ok(await ctx.api.get('/api/submissions/' + byName['王五'].submissionId));
  assert.strictEqual(detail3.answers[0].text, '导入的第 1 题答案');
  assert.strictEqual(detail3.answers[1].text, '导入的第 2 题答案');
  assert.strictEqual(detail3.answers[0].points, 6, '答案要挂到正确的题上（第 1 题 6 分）');
});

test('验收 5 · 手写答题照片由 AI 自主评判：不看评分标准、不超满分，图确实当图片发出去', async (t) => {
  // 用一个本地假 AI 顶替千问，验证"真实调用链路 + 图片作答的提示词里确实没有评分标准"
  const fake = await startFakeAi(() => {
    return JSON.stringify({
      // 故意给一个超过满分的分，检验后端会夹回本题满分
      items: [{ index: 0, score: 8, reason: '位移公式写对了，单位也规范，就是没写推导过程，扣一点；按满分记', confidence: 0.92 }],
      comment: '整体正确，注意写出推导',
    });
  });
  t.after(() => new Promise((r) => fake.server.close(r)));

  const ctx = await startApp({ aiMode: 'live' });
  t.after(() => ctx.close());
  ok(await ctx.api.put('/api/settings', {
    baseUrl: fake.url, model: 'fake-vision', apiKey: 'sk-fake',
  }));

  const q = ok(await ctx.api.post('/api/questions', {
    stem: Q_ITEMS.stem, refAnswer: Q_ITEMS.refAnswer,
    rubricType: 'items', items: Q_ITEMS.items,
  })).question;
  const paper = ok(await ctx.api.post('/api/papers', { name: '手写卷' })).paper;
  const saved = ok(await ctx.api.put('/api/papers/' + paper.id + '/questions', { questions: [{ questionId: q.id }] }));
  ok(await ctx.api.post('/api/papers/' + paper.id + '/publish', {}));

  const stu = await addStudent(ctx, '张三');
  const up = ok(await ctx.api.post('/api/uploads', { data: 'data:image/png;base64,' + PNG_1PX, ext: 'png' }));
  ok(await ctx.api.post('/api/papers/' + paper.id + '/submissions', {
    studentId: stu.id,
    answers: [{ paperQuestionId: saved.questions[0].paperQuestionId, text: '', images: [up.path] }],
  }));

  const list = ok(await ctx.api.get('/api/papers/' + paper.id + '/submissions'));
  const subId = list.students.find((s) => s.name === '张三').submissionId;
  const graded = ok(await ctx.api.post('/api/submissions/' + subId + '/grade', {}));

  const q1 = graded.detail.questions[0];
  assert.strictEqual(q1.gradingMode, 'auto', '有图片的题就该走自主评判');
  assert.strictEqual(q1.items.length, 1, '自主评判整题一条，不再拆成多条得分点');
  assert.strictEqual(q1.items[0].mode, 'auto');
  assert.strictEqual(q1.items[0].aiScore, 6, 'AI 给了 8 分，要夹回本题满分 6 分');
  assert.ok(q1.items[0].aiReason.length > 0, '自主评判也要给出理由');
  assert.ok(q1.items[0].aiConfidence >= 0.9);
  assert.strictEqual(graded.detail.gradeSheet.aiTotal, 6);

  // 核对真正发给 AI 的东西：不能带评分标准，但图要按图片发
  assert.strictEqual(fake.received.length, 1);
  const sent = JSON.stringify(fake.received[0].body.messages);
  ['正确写出位移公式 h = ½gt²', '结果与单位规范', '【评分标准】'].forEach((k) => {
    assert.ok(!sent.includes(k), '图片作答的提示词里不该出现评分标准：' + k);
  });
  assert.ok(sent.includes('不要去找评分标准条目'), '要明确告诉 AI 本题不逐条对照');
  assert.ok(sent.includes('只看属于这一题的部分'), '连拍场景要说清只看属于这一题的部分');
  assert.ok(sent.includes('image_url'), '图片要以图片内容发出去，不能当文字');
  assert.ok(sent.includes('data:image/png;base64,'), '图片内容要真的带上');
  assert.strictEqual(fake.received[0].headers.authorization, 'Bearer sk-fake');
  assert.strictEqual(fake.received[0].body.model, 'fake-vision');
});

test('验收 5b · 纯文字作答仍逐条对照评分标准，理由指明依据哪一条', async (t) => {
  const fake = await startFakeAi(() => {
    return JSON.stringify({
      items: [
        { index: 0, score: 3, reason: '依据评分标准「正确写出位移公式 h = ½gt²」：公式写对了但没说明 ½ 的来源，扣 1 分', confidence: 0.92 },
        { index: 1, score: 2, reason: '依据评分标准「结果与单位规范」：结果 3 s、单位正确，给满分', confidence: 0.95 },
      ],
      comment: '整体正确，注意推导说明',
    });
  });
  t.after(() => new Promise((r) => fake.server.close(r)));

  const ctx = await startApp({ aiMode: 'live' });
  t.after(() => ctx.close());
  ok(await ctx.api.put('/api/settings', {
    baseUrl: fake.url, model: 'fake-vision', apiKey: 'sk-fake',
  }));

  const q = ok(await ctx.api.post('/api/questions', {
    stem: Q_ITEMS.stem, refAnswer: Q_ITEMS.refAnswer,
    rubricType: 'items', items: Q_ITEMS.items,
  })).question;
  const paper = ok(await ctx.api.post('/api/papers', { name: '文字卷' })).paper;
  const saved = ok(await ctx.api.put('/api/papers/' + paper.id + '/questions', { questions: [{ questionId: q.id }] }));
  ok(await ctx.api.post('/api/papers/' + paper.id + '/publish', {}));

  const stu = await addStudent(ctx, '张三');
  ok(await ctx.api.post('/api/papers/' + paper.id + '/submissions', {
    studentId: stu.id,
    answers: [{ paperQuestionId: saved.questions[0].paperQuestionId, text: '由 h=½gt² 得 t=3 s' }],
  }));

  const list = ok(await ctx.api.get('/api/papers/' + paper.id + '/submissions'));
  const subId = list.students.find((s) => s.name === '张三').submissionId;
  const graded = ok(await ctx.api.post('/api/submissions/' + subId + '/grade', {}));

  const q1 = graded.detail.questions[0];
  assert.strictEqual(q1.gradingMode, 'rubric', '只有文字的题还是按评分标准判');
  assert.strictEqual(q1.items.length, 2, '要逐项给分，不能只给总分');
  assert.deepStrictEqual(q1.items.map((i) => i.aiScore), [3, 2]);
  assert.ok(q1.items[0].aiReason.includes('正确写出位移公式'), '理由要点明是哪条评分标准');
  assert.ok(q1.items[0].aiReason.includes('扣 1 分'), '理由要说清为什么给这个分');
  assert.ok(q1.items[0].aiConfidence >= 0.9);
  assert.strictEqual(graded.detail.gradeSheet.aiTotal, 5);

  assert.strictEqual(fake.received.length, 1);
  const sent = JSON.stringify(fake.received[0].body.messages);
  assert.ok(sent.includes('正确写出位移公式 h = ½gt²'), '提示词里必须带评分标准原文');
  assert.ok(sent.includes('正确写出位移公式'), '文字作答的提示词要有得分点条目');
});

test('验收 6 · 某一项从 2 改成 3，该题与整卷总分立刻同步', async (t) => {
  // 用一个固定的 AI 回包把分数钉死：第 1 题两项 3 分 + 2 分，第 2 题满分 4 分。
  // 这样才真的复现 PRD 里那句「某一项 AI 给分从 2 改成 3」。
  const ctx = await startApp({ aiChat: fixedGradeAi() });
  t.after(() => ctx.close());

  const q1 = ok(await ctx.api.post('/api/questions', {
    ...Q_ITEMS,
    items: [{ text: '正确写出位移公式 h = ½gt²', points: 4 }, { text: '结果与单位规范', points: 4 }],
  })).question;
  const q2 = ok(await ctx.api.post('/api/questions', Q_TEXT)).question;
  const paper = ok(await ctx.api.post('/api/papers', { name: '第一次月考' })).paper;
  const saved = ok(await ctx.api.put('/api/papers/' + paper.id + '/questions', {
    questions: [{ questionId: q1.id }, { questionId: q2.id }],
  }));
  ok(await ctx.api.post('/api/papers/' + paper.id + '/publish', {}));
  const questions = saved.questions;

  const stu = await addStudent(ctx, '张三');
  const sub = await submitAnswers(ctx, paper, questions, stu.id);
  const d = await gradeWith(ctx, sub.id, {});

  assert.strictEqual(d.questions[0].questionTotal, 5, '第 1 题小计 = 3 + 2');
  assert.strictEqual(d.gradeSheet.effectiveTotal, 9, '整卷 = 5 + 4');

  const second = d.questions[0].items[1];
  assert.strictEqual(second.aiScore, 2);
  const res = ok(await ctx.api.put('/api/grade-items/' + second.id, { finalScore: 3 }));

  assert.strictEqual(res.effectiveTotal, 10, '2 → 3 之后整卷立刻变 10');

  const again = ok(await ctx.api.get('/api/papers/' + paper.id + '/queue/1'));
  assert.strictEqual(again.detail.questions[0].items[1].effectiveScore, 3);
  assert.strictEqual(again.detail.questions[0].questionTotal, 6, '该题小计同步到 6');
  assert.strictEqual(again.detail.gradeSheet.effectiveTotal, 10);

  // 反过来也要拦住：超过该项满分不给过
  const over = await ctx.api.put('/api/grade-items/' + second.id, { finalScore: 5 });
  assert.strictEqual(over.status, 400, '超过满分的改分必须被拒绝');
});

test('验收 7 · 确认后才进统计；解锁重批后重新计入', async (t) => {
  const ctx = await startApp();
  t.after(() => ctx.close());
  const { paper, questions } = await scene(ctx);
  const stu = await addStudent(ctx, '张三');
  const sub = await submitAnswers(ctx, paper, questions, stu.id);
  const d = await gradeWith(ctx, sub.id, { q1: [4, 2], q2: 4 });

  assert.strictEqual(ok(await ctx.api.get('/api/stats/paper/' + paper.id)).overview.count, 0);

  ok(await ctx.api.post('/api/grade-sheets/' + d.gradeSheet.id + '/confirm', {}));
  let stats = ok(await ctx.api.get('/api/stats/paper/' + paper.id));
  assert.strictEqual(stats.overview.count, 1);
  assert.strictEqual(stats.overview.average, 10);
  assert.strictEqual(stats.students[0].name, '张三');

  ok(await ctx.api.post('/api/grade-sheets/' + d.gradeSheet.id + '/unlock', { reason: '重判' }));
  stats = ok(await ctx.api.get('/api/stats/paper/' + paper.id));
  assert.strictEqual(stats.overview.count, 0, '解锁后先退出统计');

  await gradeWith(ctx, sub.id, { q1: [4, 2], q2: 2 }, true);
  stats = ok(await ctx.api.get('/api/stats/paper/' + paper.id));
  assert.strictEqual(stats.overview.count, 1);
  assert.strictEqual(stats.overview.average, 8, '重批后按新分数计入');
});

/* ------------------------------------------------- 10.3 首页与今日计划 */

test('验收 8 · 四张卡的数字与实际一致，点卡能跳到对应筛选视图', async (t) => {
  const ctx = await startApp();
  t.after(() => ctx.close());
  const { paper, questions } = await scene(ctx);
  const a = await addStudent(ctx, '张三');
  const b = await addStudent(ctx, '李四');
  const c = await addStudent(ctx, '王五');
  const sa = await submitAnswers(ctx, paper, questions, a.id);
  await submitAnswers(ctx, paper, questions, b.id);
  await submitAnswers(ctx, paper, questions, c.id);

  const d1 = (await gradeWith(ctx, sa.id, { q1: [4, 2], q2: 0 }, true));   // 张三确认，第 2 题 0 分
  const s2 = ok(await ctx.api.get('/api/papers/' + paper.id + '/queue')).items.find((i) => i.studentName === '李四');
  const d2 = (await gradeWith(ctx, s2.submissionId, {}, false));            // 李四批完未确认
  ok(await ctx.api.put('/api/grade-items/' + d2.questions[0].items[0].id, { doubt: true }));
  // 王五不批改

  const home = ok(await ctx.api.get('/api/stats/home'));
  assert.strictEqual(home.cards.toGrade.count, 1, '待你批改 = 已提交且未批改');
  assert.strictEqual(home.cards.toConfirm.count, 1, '待你确认 = 已批完未确认');
  assert.strictEqual(home.cards.doubt.count, 1, '需复核的存疑点 = 未确认答卷里 doubt 的个数');
  assert.strictEqual(home.cards.toReview.count, 1, '待讲评 = 已完成批改的卷里得分率 < 50% 的题');

  // 与实际数据核对
  const queue = ok(await ctx.api.get('/api/papers/' + paper.id + '/queue'));
  assert.strictEqual(home.cards.toGrade.count, queue.counts.pending);
  assert.strictEqual(home.cards.toConfirm.count, queue.counts.toConfirm);
  assert.strictEqual(home.cards.doubt.count, queue.counts.doubt);
  const stats = ok(await ctx.api.get('/api/stats/paper/' + paper.id));
  assert.strictEqual(home.cards.toReview.count, stats.ranking.filter((q) => q.rate < 0.5).length);

  // 渲染首页，检查卡片数字与跳转目标
  const { registry, root } = loadFrontend(ctx.base, HOME_PAGES);
  await registry.home.render(root, {});
  const cards = metricCards(root.innerHTML);
  assert.deepStrictEqual(
    cards.map((c) => [c.key, c.value, c.page]),
    [['toGrade', '1', 'grading'], ['toConfirm', '1', 'grading'], ['doubt', '1', 'grading'], ['toReview', '1', 'stats']],
    '四张卡的数字要与接口一致，且都给出跳转目标'
  );
  const byKey = Object.fromEntries(cards.map((c) => [c.key, c]));
  assert.deepStrictEqual(byKey.toGrade.query, { paper: paper.id, filter: 'pending', seq: 1 });
  assert.deepStrictEqual(byKey.toConfirm.query, { paper: paper.id, filter: 'to_confirm', seq: 1 });
  assert.deepStrictEqual(byKey.doubt.query, { paper: paper.id, filter: 'doubt', seq: 1 });
  assert.deepStrictEqual(byKey.toReview.query, { paper: paper.id });
});

test('验收 9 · 新收一份答卷后「待你批改」+1，今日计划出现对应条目', async (t) => {
  const ctx = await startApp();
  t.after(() => ctx.close());
  const { paper, questions } = await scene(ctx);

  const before = ok(await ctx.api.get('/api/stats/home')).cards.toGrade.count;
  const planBefore = ok(await ctx.api.get('/api/todos')).auto;

  const stu = await addStudent(ctx, '张三');
  await submitAnswers(ctx, paper, questions, stu.id);

  const after = ok(await ctx.api.get('/api/stats/home')).cards.toGrade.count;
  assert.strictEqual(after, before + 1, '待你批改应该 +1');

  const planAfter = ok(await ctx.api.get('/api/todos')).auto;
  const gradeItem = planAfter.find((i) => i.key === 'to_grade');
  assert.ok(gradeItem, '今日计划里要出现「待你批改」条目');
  assert.strictEqual(gradeItem.count, 1);
  assert.strictEqual(gradeItem.page, 'grading');
  assert.strictEqual(gradeItem.query.paper, paper.id);
  assert.strictEqual(gradeItem.query.filter, 'pending');
  assert.ok(
    planAfter.some((i) => i.key === 'today_received:' + paper.id),
    '今天收的答案也要单独列出来'
  );
  assert.ok(
    !planBefore.some((i) => i.key === 'to_grade'),
    '之前没有待批改，所以之前不该有这条'
  );
});

test('验收 10 · 批完并确认后，今日计划里对应条目自动消失', async (t) => {
  const ctx = await startApp();
  t.after(() => ctx.close());
  const { paper, questions } = await scene(ctx);
  const stu = await addStudent(ctx, '张三');
  const sub = await submitAnswers(ctx, paper, questions, stu.id);

  let plan = ok(await ctx.api.get('/api/todos')).auto;
  assert.ok(plan.some((i) => i.key === 'to_grade'), '刚收卷时应有待批改');
  assert.ok(plan.some((i) => i.key.startsWith('today_received:')));

  const d = await gradeWith(ctx, sub.id, {}, false);
  plan = ok(await ctx.api.get('/api/todos')).auto;
  assert.ok(!plan.some((i) => i.key === 'to_grade'), '批完了，待批改条目该消失');
  assert.ok(plan.some((i) => i.key === 'to_confirm'), '换成待确认条目');

  ok(await ctx.api.post('/api/grade-sheets/' + d.gradeSheet.id + '/confirm', {}));
  plan = ok(await ctx.api.get('/api/todos')).auto;
  assert.ok(!plan.some((i) => i.key === 'to_confirm'), '确认后待确认条目该消失');
  assert.deepStrictEqual(plan, [], '今天的事情都做完了，今日计划应为空');
});

test('验收 11 · 点首页任一条目能跳到对应模块的具体记录', async (t) => {
  const ctx = await startApp();
  t.after(() => ctx.close());
  const { paper, questions } = await scene(ctx);
  const a = await addStudent(ctx, '张三');
  const b = await addStudent(ctx, '李四');
  const sa = await submitAnswers(ctx, paper, questions, a.id);
  await submitAnswers(ctx, paper, questions, b.id);

  const d = await gradeWith(ctx, sa.id, { q1: [4, 2], q2: 0 }, true);   // 张三确认，用于产生待讲评的题
  const list = ok(await ctx.api.get('/api/papers/' + paper.id + '/queue'));
  const li = list.items.find((i) => i.studentName === '李四');
  const d2 = await gradeWith(ctx, li.submissionId, {}, false);
  ok(await ctx.api.put('/api/grade-items/' + d2.questions[0].items[0].id, { doubt: true }));

  const { registry, root } = loadFrontend(ctx.base, HOME_PAGES);
  await registry.home.render(root, {});
  const html = root.innerHTML;

  // 左栏「需要你处理」：待确认的那份要能带着 sub 精确跳到该生
  assert.ok(
    html.includes('data-go-query=\'{&quot;paper&quot;:' + paper.id + ',&quot;filter&quot;:&quot;to_confirm&quot;,&quot;sub&quot;:' + li.submissionId + '}\''),
    '待确认条目要能定位到具体那一份答卷'
  );
  // 存疑处也要能定位
  assert.ok(html.includes('&quot;filter&quot;:&quot;doubt&quot;,&quot;sub&quot;:'), '存疑条目要能定位');
  // 右栏「最需要讲的题」要能带着题目 id 跳到统计页
  const low = ok(await ctx.api.get('/api/stats/home')).right.lowRateQuestions[0];
  assert.ok(
    html.includes('data-go-query=\'{&quot;paper&quot;:' + low.paperId + ',&quot;question&quot;:' + low.paperQuestionId + '}\''),
    '待讲评的题要能直接跳到该题的失分名单'
  );

  // 用 sub 定位到批改队列时，序号要算对
  const queue = ok(await ctx.api.get('/api/papers/' + paper.id + '/queue?filter=to_confirm'));
  const hit = queue.items.find((i) => String(i.submissionId) === String(li.submissionId));
  assert.ok(hit, '该答卷应在待确认队列里');
  const at = ok(await ctx.api.get('/api/papers/' + paper.id + '/queue/' + hit.seq + '?filter=to_confirm'));
  assert.strictEqual(at.entry.studentName, '李四', '按序号取回来的必须是同一个人');

  // 统计页确实会按 question 参数弹失分明细
  const { registry: r2, root: root2, captured } = loadFrontend(ctx.base, HOME_PAGES);
  await r2.stats.render(root2, { paper: String(low.paperId), question: String(low.paperQuestionId) });
  assert.ok(captured.modal && captured.modal.includes('失分学生名单'));
});

/* ------------------------------------------------- 10.4 统计准确性 */

/** 三个人：甲 10 分、乙 3 分、丙 7 分（第 2 题：甲 4、乙 0、丙 1） */
async function threeGraded(ctx) {
  const { paper, questions } = await scene(ctx);
  const a = await addStudent(ctx, '甲');
  const b = await addStudent(ctx, '乙');
  const c = await addStudent(ctx, '丙');
  const sa = await submitAnswers(ctx, paper, questions, a.id);
  const sb = await submitAnswers(ctx, paper, questions, b.id);
  const sc = await submitAnswers(ctx, paper, questions, c.id);
  await gradeWith(ctx, sa.id, { q1: [4, 2], q2: 4 }, true);
  await gradeWith(ctx, sb.id, { q1: [2, 1], q2: 0 }, true);
  await gradeWith(ctx, sc.id, { q1: [4, 2], q2: 1 }, true);
  return { paper, questions };
}

test('验收 12 · 班级平均 / 最高 / 最低与手算一致', async (t) => {
  const ctx = await startApp();
  t.after(() => ctx.close());
  const { paper } = await threeGraded(ctx);

  const stats = ok(await ctx.api.get('/api/stats/paper/' + paper.id));
  const totals = stats.students.map((s) => s.total);
  assert.deepStrictEqual(totals.slice().sort((x, y) => y - x), [10, 7, 3]);

  // 手算： (10 + 7 + 3) / 3 = 6.666… → 6.67
  assert.strictEqual(stats.overview.average, 6.67);
  assert.strictEqual(stats.overview.highest, Math.max(10, 7, 3));
  assert.strictEqual(stats.overview.lowest, Math.min(10, 7, 3));
  assert.strictEqual(stats.overview.passLine, 6);
  assert.strictEqual(stats.overview.passCount, 2);
  assert.strictEqual(stats.overview.passRate, 0.67);
  // 用接口给的数字再算一遍，确保是同一口径
  const apiAvg = Math.round(((totals.reduce((x, y) => x + y, 0) / totals.length) + Number.EPSILON) * 100) / 100;
  assert.strictEqual(stats.overview.average, apiAvg);
});

test('验收 13 · 某题得分率 = 该题全班得分总和 ÷ 该题满分总和', async (t) => {
  const ctx = await startApp();
  t.after(() => ctx.close());
  const { paper } = await threeGraded(ctx);
  const stats = ok(await ctx.api.get('/api/stats/paper/' + paper.id));

  const q1 = stats.questions.find((q) => q.seq === 1);   // 6 分：6 / 3 / 6 → 15 / 18
  const q2 = stats.questions.find((q) => q.seq === 2);   // 4 分：4 / 0 / 1 → 5 / 12

  assert.strictEqual(q1.scoreSum, 15);
  assert.strictEqual(q1.fullSum, 6 * 3);
  assert.strictEqual(q1.rate, Math.round(((15 / 18) + Number.EPSILON) * 100) / 100);
  assert.strictEqual(q1.rate, 0.83);

  assert.strictEqual(q2.scoreSum, 5);
  assert.strictEqual(q2.fullSum, 4 * 3);
  assert.strictEqual(q2.rate, Math.round(((5 / 12) + Number.EPSILON) * 100) / 100);
  assert.strictEqual(q2.rate, 0.42);
});

test('验收 14 · 点某题列出的失分名单与批改结果一致', async (t) => {
  const ctx = await startApp();
  t.after(() => ctx.close());
  const { paper, questions } = await threeGraded(ctx);

  const d = ok(await ctx.api.get('/api/stats/paper/' + paper.id + '/question/' + questions[1].paperQuestionId));
  assert.strictEqual(d.seq, 2);
  assert.strictEqual(d.points, 4);
  assert.strictEqual(d.lostCount, 2);
  // 按失分从多到少：乙 失 4 分、丙 失 3 分；甲满分不在名单里
  assert.deepStrictEqual(d.students.map((s) => [s.name, s.score, s.lost]), [['乙', 0, 4], ['丙', 1, 3]]);
  assert.ok(d.students[0].items[0].reason.length > 0, '名单里要能看到当时的判分理由');

  // 与批改页的明细逐项核对
  const list = ok(await ctx.api.get('/api/papers/' + paper.id + '/queue'));
  const yi = list.items.find((i) => i.studentName === '乙');
  const detail = ok(await ctx.api.get('/api/papers/' + paper.id + '/queue/' + yi.seq));
  assert.strictEqual(detail.detail.questions[1].questionTotal, 0, '乙的第 2 题确实是 0 分');
});

/* ------------------------------------------------- 10.5 数据文件与备份 */

test('验收 15 · 设置页显示数据文件完整路径，磁盘上找得到', async (t) => {
  const ctx = await startApp();
  t.after(() => ctx.close());
  const s = ok(await ctx.api.get('/api/settings'));
  assert.ok(path.isAbsolute(s.dataFile), '必须是完整路径');
  assert.ok(fs.existsSync(s.dataFile), '用文件管理器应该能找到这个文件');
  assert.strictEqual(fs.statSync(s.dataFile).isFile(), true);
  assert.ok(s.dbSize > 0);

  const { registry, root } = loadFrontend(ctx.base, SETTINGS_PAGES);
  await registry.settings.render(root, {});
  has(root.innerHTML, s.dataFile);
  has(root.innerHTML, s.attachmentsDir);
  has(root.innerHTML, s.backupDir);
});

test('验收 16 · 一键备份生成单个文件，另存到别处可独立存在', async (t) => {
  const ctx = await startApp();
  t.after(() => ctx.close());
  await scene(ctx);

  const res = ok(await ctx.api.post('/api/backups', { includeAttachments: true }));
  const src = path.join(ctx.backupsDir, res.name);
  assert.ok(fs.existsSync(src));

  // 模拟"复制到别处"：拷到一个完全无关的目录
  const elsewhere = path.join(tempDir('pgelsewhere-'), res.name);
  fs.copyFileSync(src, elsewhere);
  assert.ok(fs.existsSync(elsewhere));

  // 该文件可独立打开，里面装着完整数据
  const buf = fs.readFileSync(elsewhere);
  const manifest = JSON.parse(readZipEntry(buf, 'manifest.json').toString('utf8'));
  assert.strictEqual(manifest.counts.papers, 1);
  const dbBytes = readZipEntry(buf, 'paper.db');
  assert.strictEqual(dbBytes.slice(0, 15).toString('utf8'), 'SQLite format 3');
  assert.ok(manifest.createdAt);
});

test('验收 17 · 删掉数据文件后用备份恢复，数据与备份时完全一致', async (t) => {
  const dir = tempDir('pgaccept-');
  const dbFile = path.join(dir, 'paper.db');

  // 第一次运行：造数据 → 备份 → 关服务
  let srv = await spawnServer({ APP_DB_FILE: dbFile, PORT: '0' });
  t.after(() => killServer(srv.child));

  const api1 = (m, p, b) => fetch(srv.base + p, {
    method: m,
    headers: b ? { 'Content-Type': 'application/json' } : {},
    body: b ? JSON.stringify(b) : undefined,
  }).then((r) => r.json());

  const q = (await api1('POST', '/api/questions', Q_ITEMS)).question;
  const paper = (await api1('POST', '/api/papers', { name: '恢复测试卷' })).paper;
  const saved = await api1('PUT', '/api/papers/' + paper.id + '/questions', { questions: [{ questionId: q.id }] });
  await api1('POST', '/api/papers/' + paper.id + '/publish', {});
  const stu = (await api1('POST', '/api/students', { name: '张三', className: '高一(1)班' })).student;
  const sub = (await api1('POST', '/api/papers/' + paper.id + '/submissions', {
    studentId: stu.id,
    answers: [{ paperQuestionId: saved.questions[0].paperQuestionId, text: 't = 3 s' }],
  })).submission;
  const graded = (await api1('POST', '/api/submissions/' + sub.id + '/grade', {})).detail;
  const itemId = graded.questions[0].items[0].id;
  await api1('PUT', '/api/grade-items/' + itemId, { finalScore: 4 });
  await api1('PUT', '/api/grade-sheets/' + graded.gradeSheet.id, { comment: '步骤完整，很规范' });
  await api1('POST', '/api/grade-sheets/' + graded.gradeSheet.id + '/confirm', {});

  const before = await api1('GET', '/api/stats/paper/' + paper.id);
  const commentsBefore = (await api1('GET', '/api/papers/' + paper.id + '/queue/1')).detail.gradeSheet.comment;
  const bak = await api1('POST', '/api/backups', { includeAttachments: true });

  await killServer(srv.child);

  // 手动删掉数据文件，再启动（相当于用户搞丢了数据）
  fs.unlinkSync(dbFile);
  assert.ok(!fs.existsSync(dbFile));

  srv = await spawnServer({ APP_DB_FILE: dbFile, PORT: '0' });
  const api2 = (m, p, b) => fetch(srv.base + p, {
    method: m,
    headers: b ? { 'Content-Type': 'application/json' } : {},
    body: b ? JSON.stringify(b) : undefined,
  }).then((r) => r.json());

  const emptyStats = await api2('GET', '/api/stats/paper/' + paper.id);
  assert.ok(emptyStats.error || emptyStats.overview.count === 0, '新数据文件里应该什么都没有');

  const restored = await api2('POST', '/api/backups/restore', { name: bak.name });
  assert.strictEqual(restored.ok, true);

  const after = await api2('GET', '/api/stats/paper/' + paper.id);
  assert.strictEqual(after.paper.name, '恢复测试卷');
  assert.strictEqual(after.overview.average, before.overview.average);
  assert.strictEqual(after.overview.count, before.overview.count);
  assert.deepStrictEqual(
    after.questions.map((x) => [x.seq, x.points, x.scoreSum]),
    before.questions.map((x) => [x.seq, x.points, x.scoreSum]),
    '题目、分值、得分全部一致'
  );
  assert.strictEqual(
    after.students.map((x) => [x.name, x.total]).join('|'),
    before.students.map((x) => [x.name, x.total]).join('|'),
    '学生成绩一致'
  );
  const detail = await api2('GET', '/api/papers/' + paper.id + '/queue/1');
  assert.strictEqual(detail.detail.gradeSheet.comment, commentsBefore, '老师的批注也要一并回来');
  assert.strictEqual(detail.detail.gradeSheet.status, 'confirmed', '确认状态也要保留');
  assert.strictEqual(detail.detail.questions[0].items[0].finalScore, 4, '老师的改分也要保留');
  const qs = await api2('GET', '/api/questions');
  assert.strictEqual(qs.questions[0].stem, Q_ITEMS.stem);
  assert.deepStrictEqual(qs.questions[0].items.map((i) => i.text), Q_ITEMS.items.map((i) => i.text));
});

test('验收 18 · 恢复有二次确认，且恢复前自动另存了当前数据', async (t) => {
  const ctx = await startApp();
  t.after(() => ctx.close());
  await scene(ctx);
  const bak = ok(await ctx.api.post('/api/backups', {}));

  // 后端：恢复时必定先另存一份当前数据
  const res = ok(await ctx.api.post('/api/backups/restore', { name: bak.name }));
  assert.match(res.preRestore, /^pre-restore-/);
  assert.ok(fs.existsSync(path.join(ctx.backupsDir, res.preRestore)));
  const list = ok(await ctx.api.get('/api/backups')).backups;
  assert.ok(list.some((b) => b.name === res.preRestore && b.kind === 'pre-restore'));
  assert.ok(list.some((b) => b.name === bak.name && b.kind === 'backup'));

  // 前端：点「恢复」必须先弹二次确认，确认文案要把风险说清楚
  const { registry, root, captured } = loadFrontend(ctx.base, SETTINGS_PAGES);
  await registry.settings.render(root, {});
  const btns = root.querySelectorAll('[data-restore="' + bak.name + '"]');
  assert.strictEqual(btns.length, 1, '设置页要给出恢复入口');
  has(root.innerHTML, '备份与恢复');

  const backupsBefore = ok(await ctx.api.get('/api/backups')).backups.length;
  await btns[0].fire('click');
  assert.strictEqual(captured.confirmCalls.length, 1, '点恢复必须先弹一次确认');
  const ask = captured.confirmCalls[0];
  assert.strictEqual(ask.title, '从备份恢复');
  assert.ok(ask.message.includes(bak.name), '确认框要说清恢复的是哪一份备份');
  assert.ok(ask.message.includes('覆盖当前数据'), '必须点明会覆盖当前数据');
  assert.ok(ask.message.includes('另存'), '必须说明当前数据会先被另存，让老师敢点');
  assert.strictEqual(ask.okText, '确认覆盖');

  // 这里 captured.confirmResult 默认 false（相当于老师点了「取消」）→ 不该真去覆盖
  const backupsAfter = ok(await ctx.api.get('/api/backups')).backups.length;
  assert.strictEqual(backupsAfter, backupsBefore, '取消后不该产生任何恢复动作');

  // 老师点「确认覆盖」时才真的恢复，并且恢复前照样自动另存
  captured.confirmResult = true;
  await btns[0].fire('click');
  const list2 = ok(await ctx.api.get('/api/backups')).backups;
  assert.ok(list2.length > backupsAfter, '确认后应多出一份恢复前的另存');
  assert.ok(list2.some((b) => b.kind === 'pre-restore'), '新增的那份必须是 pre-restore');
  assert.ok(captured.toasts.some((x) => x.text.includes('已恢复')), '恢复完要给出提示');
});

/* ------------------------------------------------- 10.6 边界与异常 */

test('验收 19 · 断网时 AI 评分给出明确提示，不崩、不丢数据', async (t) => {
  const ctx = await startApp({
    aiMode: 'mock',
    aiChat: async () => { throw new HttpError(502, '无法连接 AI 服务，请检查网络或 API Key'); },
  });
  t.after(() => ctx.close());
  const { paper, questions } = await scene(ctx);
  const stu = await addStudent(ctx, '张三');
  const sub = await submitAnswers(ctx, paper, questions, stu.id);

  const res = await ctx.api.post('/api/submissions/' + sub.id + '/grade', {});
  assert.strictEqual(res.status, 502);
  assert.ok(res.data.error.includes('无法连接 AI 服务'), '提示要明确：' + res.data.error);
  assert.ok(res.data.error.includes('API Key'));

  // 没崩：其他接口照常可用
  assert.strictEqual(ok(await ctx.api.get('/api/health')).ok, true);
  // 没丢数据：答案还在，评分单退回未批改，不会留下半份评分
  const detail = ok(await ctx.api.get('/api/submissions/' + sub.id));
  assert.strictEqual(detail.answers.length, 2);
  assert.strictEqual(getDb().prepare('SELECT COUNT(*) AS c FROM grade_items').get().c, 0);
  assert.strictEqual(
    getDb().prepare('SELECT status FROM grade_sheets WHERE submission_id = ?').get(sub.id).status,
    'ungraded'
  );
});

test('验收 20 · 没填 API Key 时点 AI 评分，提示先去设置页配置', async (t) => {
  const rootDir = tempDir('pgroot-');
  const ctx = await startApp({ aiMode: 'live', rootDir });
  t.after(() => ctx.close());
  assert.strictEqual(ok(await ctx.api.get('/api/settings')).apiKeySet, false, '临时目录里没有预置 Key');

  const { paper, questions } = await scene(ctx);
  const stu = await addStudent(ctx, '张三');
  const sub = await submitAnswers(ctx, paper, questions, stu.id);

  const res = await ctx.api.post('/api/submissions/' + sub.id + '/grade', {});
  assert.strictEqual(res.status, 400);
  assert.ok(res.data.error.includes('API Key'));
  assert.ok(res.data.error.includes('设置'), '要告诉用户去哪儿配：' + res.data.error);
});

test('验收 21 · 除 AI 评分外不对互联网发任何请求，也没有登录界面', async (t) => {
  const guard = guardNetwork();
  t.after(() => guard.restore());

  const ctx = await startApp({ aiMode: 'mock' });
  t.after(() => ctx.close());
  ok(await ctx.api.put('/api/settings', { baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1', apiKey: 'sk-x' }));

  // 走一遍完整主流程（模拟 AI 模式，不应该有任何外部请求）
  const { paper, questions } = await scene(ctx);
  const stu = await addStudent(ctx, '张三');
  const sub = await submitAnswers(ctx, paper, questions, stu.id);
  await gradeWith(ctx, sub.id, {}, true);
  await ctx.api.get('/api/stats/home');
  await ctx.api.get('/api/todos');
  await ctx.api.post('/api/backups', {});
  await ctx.api.get('/api/settings');

  const external = guard.calls.filter((u) => !/^https?:\/\/(127\.0\.0\.1|localhost)[:/]/.test(u));
  assert.deepStrictEqual(external, [], '除 AI 评分外，不该有任何对外请求');
  assert.ok(guard.calls.length > 0, '本机请求是有的，否则说明这个检查没生效');

  // 无登录界面：导航里没有登录/账号入口，所有接口都不需要凭证
  const routerSrc = fs.readFileSync(path.join(ROOT_DIR, 'web', 'core', 'router.js'), 'utf8');
  assert.ok(!/登录|登陆|注册|signin|sign-in|login|logout|账号/.test(routerSrc), '导航里不该有登录相关入口');
  const indexHtml = fs.readFileSync(path.join(ROOT_DIR, 'web', 'index.html'), 'utf8');
  assert.ok(!/登录|password|token/i.test(indexHtml), '页面上不该有登录表单');
  // 不带任何凭证也能正常读写
  assert.strictEqual(ok(await ctx.api.get('/api/papers')).total, 1);
});

test('验收 22 · 批量批改按「第 X / N 份」推进，能暂停能继续', async (t) => {
  const ctx = await startApp();
  t.after(() => ctx.close());
  const { paper, questions } = await scene(ctx);
  for (const n of ['甲', '乙', '丙', '丁']) {
    const s = await addStudent(ctx, n);
    await submitAnswers(ctx, paper, questions, s.id);
  }
  // 每份之间稍微等一会儿，方便观察进度与暂停（并行后要留足窗口）
  ok(await ctx.api.put('/api/settings', { aiDelayMs: 300 }));

  const started = ok(await ctx.api.post('/api/papers/' + paper.id + '/grade-batch', {}));
  const jobId = started.job.id;
  assert.strictEqual(started.job.total, 4);
  assert.match(started.job.progressText, /^第 \d+ \/ 4 份$/, '进度文案应为「第 X / N 份」：' + started.job.progressText);

  // 等它跑起来一点
  await new Promise((r) => setTimeout(r, 260));
  const mid = ok(await ctx.api.get('/api/batch/' + jobId)).job;
  if (mid.status === 'running') {
    const paused = ok(await ctx.api.post('/api/batch/' + jobId + '/pause', {})).job;
    assert.strictEqual(paused.status, 'paused');
    assert.strictEqual(paused.message, '已暂停');
    const snapshot = ok(await ctx.api.get('/api/batch/' + jobId)).job;
    await new Promise((r) => setTimeout(r, 300));
    const still = ok(await ctx.api.get('/api/batch/' + jobId)).job;
    assert.strictEqual(still.done, snapshot.done, '暂停后不该继续往前走');

    ok(await ctx.api.post('/api/batch/' + jobId + '/resume', {}));
  }

  // 等它跑完
  const deadline = Date.now() + 12000;
  for (;;) {
    const job = ok(await ctx.api.get('/api/batch/' + jobId)).job;
    if (job.finished) {
      assert.strictEqual(job.done, 4);
      assert.strictEqual(job.failedCount, 0);
      assert.strictEqual(job.status, 'done');
      break;
    }
    if (Date.now() > deadline) throw new Error('批量任务没跑完：' + JSON.stringify(job));
    await new Promise((r) => setTimeout(r, 40));
  }
});

test('验收 23 · 批量进行中关掉页面再打开，已批完的分数仍在', async (t) => {
  const ctx = await startApp();
  t.after(() => ctx.close());
  const { paper, questions } = await scene(ctx);
  const ids = [];
  for (const n of ['甲', '乙', '丙']) {
    const s = await addStudent(ctx, n);
    const sub = await submitAnswers(ctx, paper, questions, s.id);
    ids.push(sub.id);
  }
  await gradeWith(ctx, ids[0], {}, true);   // 假设批量已经批完第一份并确认

  // 重新打开页面（重新拉一次队列）
  const { registry, root } = loadFrontend(ctx.base, HOME_PAGES);
  await registry.grading.render(root, { paper: String(paper.id), filter: 'to_confirm' });

  const queue = ok(await ctx.api.get('/api/papers/' + paper.id + '/queue'));
  const done = queue.items.find((i) => i.submissionId === ids[0]);
  assert.strictEqual(done.gradeStatus, 'confirmed');
  assert.strictEqual(done.total, 7.5, '已经批好的分数必须还在');
  assert.strictEqual(getDb().prepare('SELECT COUNT(*) AS c FROM grade_items').get().c > 0, true);
});

test('验收 24 · 批量完成后处于「待确认」，未确认前不进统计', async (t) => {
  const ctx = await startApp();
  t.after(() => ctx.close());
  const { paper, questions } = await scene(ctx);
  for (const n of ['甲', '乙']) {
    const s = await addStudent(ctx, n);
    await submitAnswers(ctx, paper, questions, s.id);
  }

  const started = ok(await ctx.api.post('/api/papers/' + paper.id + '/grade-batch', {}));
  const deadline = Date.now() + 10000;
  for (;;) {
    const job = ok(await ctx.api.get('/api/batch/' + started.job.id)).job;
    if (job.finished) break;
    if (Date.now() > deadline) throw new Error('批量任务没跑完');
    await new Promise((r) => setTimeout(r, 40));
  }

  const queue = ok(await ctx.api.get('/api/papers/' + paper.id + '/queue'));
  assert.strictEqual(queue.counts.toConfirm, 2, '批量完成后都应是待确认');
  assert.strictEqual(queue.counts.confirmed, 0);
  assert.strictEqual(ok(await ctx.api.get('/api/stats/paper/' + paper.id)).overview.count, 0, '未确认不进统计');
  assert.strictEqual(ok(await ctx.api.get('/api/stats/home')).cards.toConfirm.count, 2);

  // 确认其中一份 → 只算这一份
  const sheets = ok(await ctx.api.get('/api/papers/' + paper.id + '/queue?filter=to_confirm')).items;
  ok(await ctx.api.post('/api/grade-sheets/' + sheets[0].gradeSheetId + '/confirm', {}));
  const stats = ok(await ctx.api.get('/api/stats/paper/' + paper.id));
  assert.strictEqual(stats.overview.count, 1);
  assert.strictEqual(stats.overview.average, 7.5);
});

test('验收 25 · 已确认锁定的答卷不会被批量批改覆盖', async (t) => {
  const ctx = await startApp();
  t.after(() => ctx.close());
  const { paper, questions } = await scene(ctx);
  const a = await addStudent(ctx, '甲');
  const b = await addStudent(ctx, '乙');
  const sa = await submitAnswers(ctx, paper, questions, a.id);
  await submitAnswers(ctx, paper, questions, b.id);

  // 甲：老师手工改成满分并确认
  await gradeWith(ctx, sa.id, { q1: [4, 2], q2: 4 }, true);
  const sheet0 = getDb()
    .prepare('SELECT status, final_total FROM grade_sheets WHERE submission_id = ?')
    .get(sa.id);
  assert.strictEqual(sheet0.status, 'confirmed');
  assert.strictEqual(sheet0.final_total, 10, '老师确认的是满分');
  assert.strictEqual(ok(await ctx.api.get('/api/stats/paper/' + paper.id)).overview.average, 10);

  const started = ok(await ctx.api.post('/api/papers/' + paper.id + '/grade-batch', {}));
  assert.strictEqual(started.job.targetCount, 1, '已确认的那份不该进批量队列');
  const deadline = Date.now() + 10000;
  for (;;) {
    const job = ok(await ctx.api.get('/api/batch/' + started.job.id)).job;
    if (job.finished) break;
    if (Date.now() > deadline) throw new Error('批量任务没跑完');
    await new Promise((r) => setTimeout(r, 40));
  }

  const sheet = getDb().prepare('SELECT status, final_total FROM grade_sheets WHERE submission_id = ?').get(sa.id);
  assert.strictEqual(sheet.status, 'confirmed', '确认状态不能被批量任务改掉');
  assert.strictEqual(sheet.final_total, 10, '老师确认过的分数不能被覆盖');
  assert.strictEqual(ok(await ctx.api.get('/api/stats/paper/' + paper.id)).overview.average, 10);

  // 再点一次批量：只剩乙没确认，但仍然不会碰甲
  const again = ok(await ctx.api.post('/api/papers/' + paper.id + '/grade-batch', {}));
  assert.strictEqual(again.job.targetCount, 1);
  assert.strictEqual(
    getDb().prepare('SELECT final_total FROM grade_sheets WHERE submission_id = ?').get(sa.id).final_total,
    10
  );
});
