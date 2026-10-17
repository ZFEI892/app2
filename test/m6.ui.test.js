'use strict';

/**
 * 前端页面渲染测试。
 * 用最小的 DOM 垫片 + 真实的后端接口，把 home / stats 两个页面真的跑一遍 render()，
 * 检查产出的 HTML 里有没有该有的东西、有没有抛异常。
 * 不引第三方依赖，也不需要浏览器。
 */

const test = require('node:test');
const assert = require('node:assert');

const { startApp, ok } = require('./helpers');
const { loadFrontend, has } = require('./dom');

const PAGES = ['pages/home.js', 'pages/stats.js'];

async function seed(ctx) {
  const q1 = ok(await ctx.api.post('/api/questions', {
    stem: '一物体从 45 m 高处自由下落，求落地时间。',
    rubricType: 'items',
    items: [{ text: '写出位移公式', points: 4 }, { text: '结果与单位规范', points: 2 }],
  })).question;
  const q2 = ok(await ctx.api.post('/api/questions', {
    stem: '简述牛顿第一定律。', rubricType: 'text', rubricText: '答出要点得 4 分', points: 4,
  })).question;
  const paper = ok(await ctx.api.post('/api/papers', { name: '第一次月考' })).paper;
  const saved = ok(await ctx.api.put('/api/papers/' + paper.id + '/questions', {
    questions: [{ questionId: q1.id }, { questionId: q2.id }],
  }));
  ok(await ctx.api.post('/api/papers/' + paper.id + '/publish', {}));

  async function submit(name) {
    const stu = ok(await ctx.api.post('/api/students', { name, className: '高一(1)班' })).student;
    return ok(await ctx.api.post('/api/papers/' + paper.id + '/submissions', {
      studentId: stu.id,
      answers: [{ paperQuestionId: saved.questions[0].paperQuestionId, text: 't = 3 s' }],
    })).submission;
  }

  /** 批改 → 改分 → 可选确认；返回该份答卷的 gradeSheetId */
  async function gradeIt(sub, q1s, q2s, confirm) {
    const g = ok(await ctx.api.post('/api/submissions/' + sub.id + '/grade', {}));
    for (let i = 0; i < q1s.length; i += 1) {
      ok(await ctx.api.put('/api/grade-items/' + g.detail.questions[0].items[i].id, { finalScore: q1s[i] }));
    }
    ok(await ctx.api.put('/api/grade-items/' + g.detail.questions[1].items[0].id, { finalScore: q2s }));
    if (confirm) ok(await ctx.api.post('/api/grade-sheets/' + g.detail.gradeSheet.id + '/confirm', {}));
    return g;
  }

  // 张三 6 分（第 2 题 0 分）、李四 7 分 —— 都已确认，进统计
  await gradeIt(await submit('张三'), [4, 2], 0, true);
  await gradeIt(await submit('李四'), [4, 2], 1, true);

  // 王五批完了但没确认，并留一处存疑 → 制造「待你确认」和「需复核的存疑点」
  const wangwu = await submit('王五');
  const g3 = await gradeIt(wangwu, [4, 2], 2, false);
  ok(await ctx.api.put('/api/grade-items/' + g3.detail.questions[1].items[0].id, { doubt: true }));

  // 赵六只交卷没批改 → 制造「待你批改」
  await submit('赵六');

  void wangwu;
  return { paper, questions: saved.questions };
}

test('M6·前端 · 首页把四张卡、今日计划、进行中试卷、双栏都渲染出来', async (t) => {
  const ctx = await startApp();
  t.after(() => ctx.close());
  const { paper } = await seed(ctx);

  const { registry, root, sandbox } = loadFrontend(ctx.base, PAGES);
  assert.ok(registry.home, '首页脚本应注册到 App');
  await registry.home.render(root, {});

  const html = root.innerHTML;
  ['待你批改', '待你确认', '需复核的存疑点', '待讲评的题',
    '今日计划', '进行中的试卷', '需要你处理', '最需要讲的题'].forEach((k) => has(html, k));

  // 卡片数字：待批改 1（赵六）、待确认 1（王五）、存疑 1、待讲评 1（第 2 题得分率 13%）
  const nums = html.match(/metric-value">(\d+)/g).map((s) => s.replace(/[^\d]/g, ''));
  assert.deepStrictEqual(nums, ['1', '1', '1', '1']);

  has(html, '《第一次月考》');
  has(html, '高一(1)班');
  has(html, '王五');
  has(html, '得分率 13%');
  has(html, '第 2 题');

  // 卡片带上了可下钻的目标
  has(html, 'data-go-page="grading"');
  has(html, 'data-go-page="stats"');
  has(html, '&quot;filter&quot;:&quot;pending&quot;');
  assert.ok(html.includes('data-go-query'), '摘要卡点击需要能跳转');
  assert.ok(
    html.includes('data-go-query=\'{&quot;paper&quot;:' + paper.id +
      ',&quot;filter&quot;:&quot;pending&quot;,&quot;seq&quot;:1}\''),
    '待批改卡片应指向该试卷的待批列表'
  );
  void sandbox;
});

test('M6·前端 · 首页空数据时给的是引导，不是一堆 0', async (t) => {
  const ctx = await startApp();
  t.after(() => ctx.close());

  const { registry, root } = loadFrontend(ctx.base, PAGES);
  await registry.home.render(root, {});

  const html = root.innerHTML;
  has(html, '今天没有待办');
  has(html, '还没有进行中的试卷');
  has(html, '暂时没有待你处理的');
  has(html, '还没有值得讲的题');
  assert.ok(!html.includes('data-go-page'), '没数据时卡片不该可点');
});

test('M6·前端 · 统计页：选卷 → 概览 / 排行 / 排名 全都出得来', async (t) => {
  const ctx = await startApp();
  t.after(() => ctx.close());
  const { paper } = await seed(ctx);

  const { registry, root } = loadFrontend(ctx.base, PAGES);

  // 没指定试卷 → 先给选择页
  await registry.stats.render(root, {});
  has(root.innerHTML, '先选一份试卷');
  has(root.innerHTML, '第一次月考');
  has(root.innerHTML, '看统计');

  // 指定试卷 → 出统计
  await registry.stats.render(root, { paper: String(paper.id) });
  const html = root.innerHTML;
  ['班级平均分', '最高分', '最低分', '及格率', '每题得分率排行', '学生成绩排名'].forEach((k) => has(html, k));
  has(html, '张三');
  has(html, '得分率');          // 表头
  has(html, '13%');            // 第 2 题的得分率
  has(html, 'progress danger'); // 低于 50% 用红色标出
  has(html, '看失分名单');
  has(html, '看批改');
  has(html, '还有');   // 提示还有没走完的答卷
});

test('M6·前端 · 统计页：点某道题弹出失分学生名单', async (t) => {
  const ctx = await startApp();
  t.after(() => ctx.close());
  const { paper, questions } = await seed(ctx);

  const { registry, root, captured } = loadFrontend(ctx.base, PAGES);
  await registry.stats.render(root, {
    paper: String(paper.id),
    question: String(questions[1].paperQuestionId),
  });

  assert.ok(captured.modal, '应弹出失分明细');
  has(captured.modal, '失分学生名单');
  has(captured.modal, '第 2 题');
  has(captured.modal, '满分 4');
  has(captured.modal, '张三');
  has(captured.modal, '整体给分');
  has(captured.modal, '>4</b> 分');   // 「失 4 分」，分数外面套了加粗标签
});
