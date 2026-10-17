'use strict';

/**
 * 「以批改试卷为主题」的定位回归测试。
 *
 * 这一组用例守的是三件事：
 * 1. 导航不再有「题库」——只剩批改主线，评分标准排在批改之后；
 * 2. 评分标准页只留题干 / 参考答案 / 评分标准 / 分值，不再有学科、难度、标签这些出题味的东西，
 *    并且编辑老数据时不会顺手把这些字段清空；
 * 3. 提交页的主路径是「图片答卷」——**不用出题、不用先建卷**：填个卷名、交一组照片就成，
 *    全程不调识别接口、不往题目上挂东西；卷名撞上已有卷子时满分按题目总分算。
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const { ROOT_DIR, startApp, ok } = require('./helpers');
const { loadFrontend, has } = require('./dom');

/* ---------------------------------- 公共部分 ---------------------------------- */

/** 单独把 router.js 跑起来，只为拿到 NAV */
function readNav() {
  const sandbox = {
    console,
    document: { getElementById: () => ({ innerHTML: '' }), querySelectorAll: () => [] },
    location: { hash: '' },
    addEventListener() {},
  };
  sandbox.window = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(
    fs.readFileSync(path.join(ROOT_DIR, 'web', 'core', 'router.js'), 'utf8'),
    sandbox,
    { filename: 'web/core/router.js' }
  );
  return sandbox.App.NAV;
}

/** 造一道「带老标签」的评分标准，用来验证这些字段不会被新页面抹掉 */
function legacyQuestionBody() {
  return {
    stem: '一物体从 45 m 高处自由下落，求落地时间。',
    refAnswer: '由 h=½gt² 得 t=3 s',
    rubricType: 'items',
    items: [{ text: '写出位移公式', points: 4 }, { text: '结果与单位规范', points: 2 }],
    subject: '物理',
    knowledge: '自由落体',
    qtype: '计算题',
    difficulty: '难',
  };
}

async function seedPaper(ctx) {
  const q1 = ok(await ctx.api.post('/api/questions', legacyQuestionBody())).question;
  const q2 = ok(await ctx.api.post('/api/questions', {
    stem: '简述牛顿第一定律。', rubricType: 'text', rubricText: '答出要点得 4 分', points: 4,
  })).question;
  const paper = ok(await ctx.api.post('/api/papers', { name: '第一次月考' })).paper;
  const saved = ok(await ctx.api.put('/api/papers/' + paper.id + '/questions', {
    questions: [{ questionId: q1.id }, { questionId: q2.id }],
  }));
  const stu = ok(await ctx.api.post('/api/students', { name: '张三', className: '高一(1)班' })).student;
  ok(await ctx.api.post('/api/papers/' + paper.id + '/publish', {}));
  return { paper, questions: saved.questions, stu };
}

/** 假的照片文件：__dataUrl 让 FileReader 垫片有东西可读 */
function fakeShot(name, marker) {
  return { name, type: 'image/jpeg', __dataUrl: 'data:image/jpeg;base64,' + marker };
}

/**
 * 提交页把内容渲染在 [data-tab-host] 里。垫片是按「父元素 + 位置」缓存元素对象的，
 * 所以测试要跟页面一样从 host 往下取，才能拿到同一个对象（否则点不动、读到的也是空的）。
 */
function tabHost(root) {
  return root.querySelector('[data-tab-host]');
}

function countParseCalls(captured) {
  return captured.requests.filter((r) => r.url.includes('/api/import/parse')).length;
}

/* ------------------------------- 1 · 导航定位 ------------------------------- */

test('定位·导航 只剩批改主线，「题库」改叫「评分标准」并排在批改之后', () => {
  const nav = readNav();
  const all = nav.flatMap((g) => g.items);
  const labels = all.map((i) => i.label);

  assert.ok(!labels.includes('题库'), '导航里不该再出现「题库」');
  assert.ok(labels.includes('评分标准'), '应有「评分标准」');

  const main = nav[0];
  assert.strictEqual(main.group, '批改', '第一组应改名叫「批改」');
  // NAV 来自沙箱里的另一个 realm，比较前先搬回宿主数组
  assert.deepStrictEqual(
    Array.from(main.items, (i) => i.id),
    ['home', 'papers', 'submissions', 'grading', 'questions']
  );
  assert.ok(
    main.items.findIndex((i) => i.id === 'questions') > main.items.findIndex((i) => i.id === 'grading'),
    '评分标准应排在「批改」后面'
  );

  // 导航里每一项都得有对应的页面脚本，否则点进去是空白
  const html = fs.readFileSync(path.join(ROOT_DIR, 'web', 'index.html'), 'utf8');
  all.forEach((i) => assert.ok(html.includes('/pages/' + i.id + '.js'), '缺少页面脚本：' + i.id));
});

/* --------------------------- 2 · 评分标准页（只服务批改） --------------------------- */

test('评分标准·编辑页 只留题干、参考答案、评分标准、分值', async (t) => {
  const ctx = await startApp();
  t.after(() => ctx.close());
  const q = ok(await ctx.api.post('/api/questions', legacyQuestionBody())).question;

  const { registry, root, captured } = loadFrontend(ctx.base, ['pages/questions.js']);
  assert.ok(registry.questions, '评分标准页应注册到 App');
  await registry.questions.render(root, { edit: String(q.id) });

  const html = root.innerHTML;
  ['题干', '参考答案', '评分标准', '分项得分点', '一段文字说明', '满分'].forEach((k) => has(html, k));
  ['学科', '知识点', '题型', '难度', '标签', '题库', '新建题目', '存入题库'].forEach((k) => {
    assert.ok(!html.includes(k), '评分标准页不该再出现「' + k + '」');
  });

  // 老数据要照样读得出来
  has(html, '自由下落');
  has(html, 't=3 s');

  assert.strictEqual(
    captured.requests.filter((r) => r.url.includes('/api/questions/meta')).length, 0,
    '页面不该再去请求只给出题用的 meta 接口'
  );
});

test('评分标准·列表 不再按学科/难度筛选，也没有「标签」列', async (t) => {
  const ctx = await startApp();
  t.after(() => ctx.close());
  ok(await ctx.api.post('/api/questions', legacyQuestionBody()));

  const { registry, root, captured } = loadFrontend(ctx.base, ['pages/questions.js']);
  await registry.questions.render(root, {});

  const html = root.innerHTML;
  has(html, '评分标准');
  has(html, '共 1 条');
  has(html, '写出位移公式');
  has(html, 'data-act="q"');            // 搜索还在
  ['全部学科', '全部难度', '标签', '题库'].forEach((k) => {
    assert.ok(!html.includes(k), '列表页不该再出现「' + k + '」');
  });
  assert.strictEqual(
    captured.requests.filter((r) => r.url.includes('/meta')).length, 0,
    '列表页也不该请求 meta'
  );
});

test('评分标准·保存 不再提交学科/难度等字段，老数据不会被清空', async (t) => {
  const ctx = await startApp();
  t.after(() => ctx.close());
  const q = ok(await ctx.api.post('/api/questions', legacyQuestionBody())).question;

  const { registry, root, captured } = loadFrontend(ctx.base, ['pages/questions.js']);
  await registry.questions.render(root, { edit: String(q.id) });

  // 模拟老师在页面上改题干、把第 1 条得分点从 4 分改成 3 分，然后保存
  root.querySelector('[data-f="stem"]').value = '改过的题干：45 m 自由下落求时间';
  const rows = root.querySelectorAll('.q-item-row');
  assert.strictEqual(rows.length, 2, '应能取到两条得分点输入行');
  rows[0].querySelector('[data-item-text]').value = '写出位移公式';
  rows[0].querySelector('[data-item-points]').value = '3';

  await root.querySelector('[data-act="save"]').click();

  const saves = captured.requests.filter(
    (r) => r.method === 'PUT' && /\/api\/questions\/\d+$/.test(r.url)
  );
  assert.strictEqual(saves.length, 1, '应当只发一次保存请求');
  const body = JSON.parse(saves[0].body);
  ['subject', 'knowledge', 'qtype', 'difficulty'].forEach((k) => {
    assert.ok(!(k in body), '保存时不该再提交 ' + k);
  });
  assert.strictEqual(body.stem, '改过的题干：45 m 自由下落求时间');
  assert.deepStrictEqual(body.items, [{ text: '写出位移公式', points: 3 }, { text: '结果与单位规范', points: 2 }]);

  // 后端要原样保住老标签和改后的分值
  const after = ok(await ctx.api.get('/api/questions/' + q.id)).question;
  assert.strictEqual(after.subject, '物理');
  assert.strictEqual(after.knowledge, '自由落体');
  assert.strictEqual(after.qtype, '计算题');
  assert.strictEqual(after.difficulty, '难');
  assert.strictEqual(after.points, 5, '3 + 2 = 5');
});

/* ------------------------------ 3 · 图片答卷（不用出题） ------------------------------ */

test('提交·图片答卷 不用选卷、不用出题就能交，老师代录仍支持一题贴多张', async (t) => {
  const ctx = await startApp();
  t.after(() => ctx.close());
  const { paper } = await seedPaper(ctx);

  const { registry, root } = loadFrontend(ctx.base, ['pages/submissions.js']);

  // 不带 paper 进页面：直接落在「图片答卷」上，不需要先去建一份卷子
  await registry.submissions.render(root, {});
  const html = root.innerHTML;
  has(html, '图片答卷');
  has(html, '不用出题');
  has(html, '提交这份图片答卷');
  assert.ok(html.includes('data-f="paper-name"'), '要在页面上直接填卷名');
  assert.ok(html.includes('data-f="full-marks"'), '要能在页面上直接填整卷满分');
  assert.ok(
    /<input type="file"[^>]*multiple[^>]*accept="image\/\*"[^>]*data-file/.test(html),
    '照片框一次多选、且只收图片'
  );
  assert.ok(!html.includes('data-tab="import"'), '「整卷拍照」那一档已经并进「图片答卷」，不该再有');
  assert.ok(!html.includes('data-tab="whole"'), '没选卷子时不该摆出页签');

  // 打开某一份卷子的工作区：三个页签，「图片答卷」排第一且默认
  await registry.submissions.render(root, { paper: String(paper.id) });
  const ws = root.innerHTML;
  has(ws, '老师代录');
  has(ws, '学生自填');
  assert.ok(/data-tab="whole" class="active"/.test(ws), '默认应停在「图片答卷」');
  assert.ok(
    ws.indexOf('data-tab="whole"') < ws.indexOf('data-tab="manual"'),
    '图片答卷应排在第一位'
  );
  has(tabHost(root).innerHTML, '提交这份图片答卷');

  // 切到老师代录：每一题都能贴多张图
  await registry.submissions.render(root, { paper: String(paper.id), tab: 'manual' });
  const manualPanel = tabHost(root).innerHTML;
  has(manualPanel, '一题可以贴多张');
  const imgInputs = tabHost(root).querySelectorAll('[data-img]');
  assert.strictEqual(imgInputs.length, 2, '两道题各有一个贴图入口');
  assert.ok(
    manualPanel.includes('<input type="file" accept="image/*" multiple data-img="0">'),
    '单题贴图也要能多选'
  );
});

test('提交·图片答卷 一组 3 张照片先落盘再提交，卷名与满分一起送，全程不调识别接口', async (t) => {
  const ctx = await startApp();
  t.after(() => ctx.close());
  const { stu } = await seedPaper(ctx);

  const { registry, root, captured } = loadFrontend(ctx.base, ['pages/submissions.js']);
  await registry.submissions.render(root, {});

  root.querySelector('[data-f="paper-name"]').value = '10 月月考';
  root.querySelector('[data-f="full-marks"]').value = '120';
  root.querySelector('[data-f="student"]').value = String(stu.id);

  const input = root.querySelector('[data-file]');
  input.files = [fakeShot('p1.jpg', 'SHOT-A'), fakeShot('p2.jpg', 'SHOT-B'), fakeShot('p3.jpg', 'SHOT-C')];
  await input.fire('change');

  assert.strictEqual(
    captured.requests.filter((r) => r.url.endsWith('/api/uploads')).length, 3,
    '三张照片都要落盘'
  );
  assert.strictEqual(countParseCalls(captured), 0, '图片答卷不拆题，就不该调识别接口');
  assert.strictEqual(
    (root.querySelector('[data-shots]').innerHTML.match(/<img /g) || []).length, 3,
    '三张缩略图都要回显'
  );

  await root.querySelector('[data-act="submit"]').click();

  const posted = captured.requests.filter(
    (r) => r.method === 'POST' && r.url.endsWith('/api/whole-submissions')
  );
  assert.strictEqual(posted.length, 1, '只该发一次提交请求');
  const body = JSON.parse(posted[0].body);
  assert.strictEqual(body.paperName, '10 月月考');
  assert.strictEqual(body.wholeFullMarks, 120);
  assert.strictEqual(body.studentId, stu.id);
  assert.deepStrictEqual(body.images.length, 3, '整组照片一起交上去');

  // 库里：卷名对不上已有卷子 → 自动建一份**没有题目**的卷子，满分按填的算
  const papers = ok(await ctx.api.get('/api/papers')).papers;
  const made = papers.find((p) => p.name === '10 月月考');
  assert.ok(made, '卷名对不上已有卷子时应自动建一份');
  assert.strictEqual(made.progress.questionCount, 0, '这份卷子不用出题，一道题都没有');
  assert.strictEqual(made.progress.total, 120, '满分按提交时填的算');
  assert.strictEqual(made.wholeFullMarks, 120);
  assert.notStrictEqual(made.status, 'draft', '建出来就能收卷，不该卡在草稿（收到第一份就进收集中）');

  // 照片挂在这名学生的答卷上，题目上一条答案都没有
  const list = ok(await ctx.api.get('/api/papers/' + made.id + '/submissions'));
  const row = list.students.find((s) => s.studentId === stu.id);
  assert.strictEqual(row.imageCount, 3);
  assert.strictEqual(row.answerCount, 0, '一题都没逐题交过');
  const detail = ok(await ctx.api.get('/api/submissions/' + row.submissionId));
  assert.strictEqual(detail.submission.wholeMode, true);
  assert.ok(captured.refreshed >= 1, '交完要刷新页面');
});

test('提交·图片答卷 只收图片：混着选、漏填卷名、漏选学生都会被拦下', async (t) => {
  const ctx = await startApp();
  t.after(() => ctx.close());
  const { stu } = await seedPaper(ctx);

  const { registry, root, captured } = loadFrontend(ctx.base, ['pages/submissions.js']);
  await registry.submissions.render(root, {});
  const input = root.querySelector('[data-file]');

  // 图片 + txt 混着选：整批退回，一张都不落盘
  input.files = [fakeShot('p1.jpg', 'MIX-1'), { name: 'note.txt', type: 'text/plain', __text: '你好' }];
  await input.fire('change');
  assert.strictEqual(
    captured.requests.filter((r) => r.url.endsWith('/api/uploads')).length, 0,
    '混着选一张都不该落盘'
  );
  assert.ok(
    captured.toasts.some((x) => x.kind === 'error' && x.text.includes('只收图片')),
    '应该明确提示这里只收图片'
  );

  // 照片 + 卷名都齐了，就是没选学生 → 拦下
  input.files = [fakeShot('p1.jpg', 'ONLY-ONE')];
  await input.fire('change');
  root.querySelector('[data-f="paper-name"]').value = '随手一卷';
  await root.querySelector('[data-act="submit"]').click();
  assert.ok(
    captured.toasts.some((x) => x.kind === 'error' && x.text.includes('请先选择学生')),
    '没选学生要拦住'
  );

  // 选了学生但卷名空着 → 拦下
  root.querySelector('[data-f="student"]').value = String(stu.id);
  root.querySelector('[data-f="paper-name"]').value = '';
  await root.querySelector('[data-act="submit"]').click();
  assert.ok(
    captured.toasts.some((x) => x.kind === 'error' && x.text.includes('请先填一个卷名')),
    '卷名不能空着'
  );

  // 三次都没交出去，也没多建卷子
  assert.strictEqual(
    captured.requests.filter((r) => r.url.endsWith('/api/whole-submissions')).length, 0,
    '被拦下就不该发提交请求'
  );
  assert.strictEqual(ok(await ctx.api.get('/api/papers')).total, 1, '不该凭空多出卷子');
});

test('提交·图片答卷 卷名撞上已有卷子 → 回填当前整卷满分，改了会更新', async (t) => {
  const ctx = await startApp();
  t.after(() => ctx.close());
  // 「第一次月考」两道题：4+2 与 4，共 10 分；没显式设整卷总分
  const { paper, stu } = await seedPaper(ctx);

  const { registry, root, captured } = loadFrontend(ctx.base, ['pages/submissions.js']);
  await registry.submissions.render(root, {});

  const nameInput = root.querySelector('[data-f="paper-name"]');
  nameInput.value = '第一次月考';
  await nameInput.fire('input');

  const marks = root.querySelector('[data-f="full-marks"]');
  assert.strictEqual(Number(marks.value), 10, '撞上已有卷子回填它当前的整卷满分（这里没设过，就是题目总分 10）');
  assert.strictEqual(marks.disabled, false, '满分框仍可改');
  has(root.querySelector('[data-marks-hint]').innerHTML, '整卷满分');

  // 老师把整卷满分改成 20，提交时这个新值要一起发出去
  marks.value = '20';
  root.querySelector('[data-f="student"]').value = String(stu.id);
  const input = root.querySelector('[data-file]');
  input.files = [fakeShot('p1.jpg', 'AAAA')];
  await input.fire('change');
  await root.querySelector('[data-act="submit"]').click();

  const posted = captured.requests.filter(
    (r) => r.method === 'POST' && r.url.endsWith('/api/whole-submissions')
  );
  assert.strictEqual(posted.length, 1);
  const body = JSON.parse(posted[0].body);
  assert.strictEqual(body.paperName, '第一次月考');
  assert.strictEqual(body.wholeFullMarks, 20, '改了整卷满分就发新值');

  // 没有新建卷子，答卷落在原来那份卷子上；整卷总分更新成 20
  assert.strictEqual(ok(await ctx.api.get('/api/papers')).total, 1, '撞上已有卷子就不该新建');
  const list = ok(await ctx.api.get('/api/papers/' + paper.id + '/submissions'));
  const row = list.students.find((s) => s.studentId === stu.id);
  assert.strictEqual(row.imageCount, 1);
  const detail = ok(await ctx.api.get('/api/papers/' + paper.id));
  assert.strictEqual(detail.total, 20, '整卷总分就是老师填的那个');
  assert.strictEqual(detail.paper.wholeFullMarks, 20);
});

test('试卷页·一道题都不挑也能存下来；设了整卷总分再挑题，保存时 AI 自动分配', async (t) => {
  const ctx = await startApp();
  t.after(() => ctx.close());
  // legacyQuestionBody 里是 4 + 2 分、两个得分点
  const q1 = ok(await ctx.api.post('/api/questions', legacyQuestionBody())).question;

  const { registry, root } = loadFrontend(ctx.base, ['pages/papers.js']);
  await registry.papers.render(root, { new: '1' });

  // 页面要么把数字写在 HTML 里，要么之后用 textContent 刷新，两种都读得到
  const shownTotal = () => {
    const el = root.querySelector('[data-total]');
    return String(el.textContent || el.innerHTML || '');
  };
  const shownNote = () => {
    const el = root.querySelector('[data-total-note]');
    return String(el.textContent || el.innerHTML || '');
  };

  has(root.innerHTML, '整卷满分');
  const nameEl = root.querySelector('[data-f="name"]');
  const marksEl = root.querySelector('[data-f="wholeFullMarks"]');
  assert.strictEqual(marksEl.value, '100', '整卷满分默认 100');
  assert.strictEqual(shownTotal(), '100', '一道题都没挑时，满分就是整卷满分');
  has(shownNote(), '整卷满分');

  // 改整卷满分 → 满分跟着走
  nameEl.value = '只收图片的卷';
  marksEl.value = '150';
  await marksEl.fire('input');
  assert.strictEqual(shownTotal(), '150');

  await root.querySelector('[data-act="save"]').click();
  const paper = ok(await ctx.api.get('/api/papers')).papers.find((p) => p.name === '只收图片的卷');
  assert.ok(paper, '一道题都不挑也能存下来（这份卷子就是用来收图片答卷的）');
  assert.strictEqual(paper.wholeFullMarks, 150);
  assert.strictEqual(paper.progress.questionCount, 0);
  assert.strictEqual(paper.progress.total, 150);
  assert.strictEqual(paper.progress.passLine, 90, '及格线按整卷满分的 60%');

  // 再打开这份卷子，挑上一道题保存：设了整卷总分 → AI 自动把 150 分整份分给这唯一一道大题，
  // 再平均分给它的两个得分点（各 75）
  await registry.papers.render(root, { edit: String(paper.id) });
  const poolHost = root.querySelector('[data-pool]');
  await poolHost.querySelector('[data-add="' + q1.id + '"]').click();
  await root.querySelector('[data-act="save"]').click();

  const after = ok(await ctx.api.get('/api/papers/' + paper.id));
  assert.strictEqual(after.total, 150, '设了整卷总分，满分就是它');
  assert.strictEqual(after.paper.wholeFullMarks, 150);
  assert.strictEqual(after.questions.length, 1);
  assert.strictEqual(after.questions[0].points, 150, 'AI 把整卷总分整份给了这唯一一道大题');
  assert.deepStrictEqual(after.questions[0].itemPoints, [75, 75], '两个得分点平均各 75');
  assert.deepStrictEqual(
    after.questions[0].rubricItems.map((it) => it.points), [75, 75],
    '得分点分值 = 平均分配'
  );
});

