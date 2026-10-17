(function () {
  'use strict';

  const CARDS = [
    { key: 'toGrade', label: '待你批改', unit: '份', page: 'grading', filter: 'pending' },
    { key: 'toConfirm', label: '待你确认', unit: '份', page: 'grading', filter: 'to_confirm' },
    { key: 'doubt', label: '需复核的存疑点', unit: '个', page: 'grading', filter: 'doubt' },
    { key: 'toReview', label: '待讲评的题', unit: '道', page: 'stats', filter: null },
  ];

  /** 卡片点下去要跳到哪个页面的哪个筛选视图 */
  function targetOf(card, focus) {
    if (card.page === 'stats') {
      return { page: 'stats', query: focus ? { paper: focus.paperId } : { paperList: 1 } };
    }
    if (!focus) return { page: 'grading', query: { filter: card.filter } };
    return { page: 'grading', query: { paper: focus.paperId, filter: card.filter, seq: 1 } };
  }

  /** 把跳转目标写进 DOM，点击时直接读，不用再查一次接口 */
  function goAttrs(target) {
    return ' data-go-page="' + ui.esc(target.page) + '"' +
      " data-go-query='" + ui.esc(JSON.stringify(target.query)) + "'";
  }

  function cardsHtml(cards) {
    return '<div class="grid grid-4">' + CARDS.map((meta) => {
      const card = cards[meta.key] || { count: 0, focus: null };
      const n = card.count || 0;
      const focus = n ? card.focus : null;
      const hint = !n
        ? '<div class="metric-hint">暂时没有</div>'
        : (focus ? '<div class="metric-hint">《' + ui.esc(focus.paperName) + '》' +
          (focus.count && focus.count !== n ? ' 等 ' + n + ' 处' : '') + '</div>'
          : '<div class="metric-hint">点开查看</div>');
      return '<div class="metric' + (n ? '' : ' metric-idle') + '" data-metric="' + meta.key + '"' +
        (n ? goAttrs(targetOf(meta, focus)) : '') + '>' +
        '<div class="metric-label">' + meta.label + '</div>' +
        '<div class="metric-value">' + n + '<span class="metric-unit">' + meta.unit + '</span></div>' +
        hint +
        '</div>';
    }).join('') + '</div>';
  }

  function planHtml(plan) {
    const auto = plan.auto || [];
    const manual = plan.manual || [];
    const rows = [];

    if (!auto.length && !manual.length) {
      rows.push('<li>' + ui.emptyState('今天没有待办', '答案都批完确认了，可以歇一会儿') + '</li>');
    }
    auto.forEach((item) => {
      rows.push('<li class="clickable"' + goAttrs({ page: item.page, query: item.query }) + '>' +
        '<span class="badge badge-accent nowrap">自动</span>' +
        '<span class="grow">' + ui.esc(item.text) +
        (item.hint ? ' <span class="small muted">（' + ui.esc(item.hint) + '）</span>' : '') +
        '</span></li>');
    });
    manual.forEach((t) => {
      rows.push('<li><label class="row" style="gap:8px;flex:1">' +
        '<input type="checkbox" data-todo-done="' + t.id + '">' +
        '<span class="grow">' + ui.esc(t.text) + '</span></label>' +
        '<button class="btn-link" data-todo-del="' + t.id + '">删除</button></li>');
    });

    return '<div class="card">' +
      '<div class="card-title-row"><div class="card-title">今日计划</div>' +
      '<span class="small muted">' + ui.esc(plan.date || '') + ' · 做完自动消失</span></div>' +
      '<ul class="list-plain">' + rows.join('') + '</ul>' +
      '<div class="row mt12">' +
      '<input class="grow" type="text" data-todo-input maxlength="200" placeholder="临时加一条提醒，例如：下午找张老师对第 2 题">' +
      '<button class="btn" data-todo-add>添加</button>' +
      ((plan.manualDone || []).length
        ? '<button class="btn btn-sm" data-todo-clear>清空已勾（' + plan.manualDone.length + '）</button>'
        : '') +
      '</div></div>';
  }

  function papersHtml(papers) {
    if (!papers.length) {
      return '<div class="card"><div class="card-title">进行中的试卷</div>' +
        ui.emptyState('还没有进行中的试卷', '先去「试卷」页组卷发布') + '</div>';
    }
    return '<div class="card"><div class="card-title">进行中的试卷</div>' +
      '<div class="grid grid-2">' + papers.map((p) => {
        const pr = p.progress || {};
        const percent = pr.progressPercent || 0;
        return '<div class="pane clickable" data-paper="' + p.id + '">' +
          '<div class="row"><b>' + ui.esc(p.name) + '</b>' + ui.statusBadge(p.status) +
          '<div class="spacer"></div><span class="small muted">' +
          ui.num(pr.confirmed || 0) + ' / ' + ui.num(pr.studentCount || 0) + ' 份已确认</span></div>' +
          '<div class="progress mt8"><i style="width:' + percent + '%"></i></div>' +
          '<div class="row mt8 small muted">' +
          '<span>已收 ' + ui.num(pr.submissionCount || 0) + ' 份</span>' +
          '<span>待批改 ' + ui.num(pr.ungraded || 0) + '</span>' +
          '<span>待确认 ' + ui.num(pr.toConfirm || 0) + '</span>' +
          '<span>缺考 ' + ui.num(pr.absentCount || 0) + '</span>' +
          '<div class="spacer"></div>' +
          '<span>当前平均分 <b>' + (p.average === null || p.average === undefined ? '—' : ui.num(p.average)) +
          '</b> / ' + ui.num(p.fullMarks) + '</span>' +
          '</div></div>';
      }).join('') + '</div></div>';
  }

  function workHtml(left) {
    const sheets = left.sheets || [];
    const doubts = left.doubts || [];
    const rows = [];

    sheets.forEach((s) => {
      rows.push('<li class="clickable"' + goAttrs({
        page: 'grading',
        query: { paper: s.paperId, filter: 'to_confirm', sub: s.submissionId },
      }) + '><span class="grow">' +
        '<b>' + ui.esc(s.studentName) + '</b>' +
        (s.className ? ' <span class="small muted">' + ui.esc(s.className) + '</span>' : '') +
        ' <span class="small muted">《' + ui.esc(s.paperName) + '》</span>' +
        (s.whole ? ' <span class="badge">图片答卷</span>' : '') +
        '</span>' +
        '<span class="nowrap">' + ui.num(s.effectiveTotal) + ' / ' + ui.num(s.fullMarks) +
        (s.doubtCount ? ' <span class="badge badge-warn">存疑 ' + s.doubtCount + '</span>' : '') +
        ' <span class="badge badge-accent">待确认</span></span></li>');
    });
    doubts.forEach((d) => {
      // 整卷存疑没有题号 —— 它说的是「整份卷子的总分」，不是某一道题
      const where = (d.whole || d.seq === null || d.seq === undefined) ? '整卷' : ('第 ' + d.seq + ' 题');
      rows.push('<li class="clickable"' + goAttrs({
        page: 'grading',
        query: { paper: d.paperId, filter: 'doubt', sub: d.submissionId },
      }) + '><span class="grow">' +
        '<b>' + ui.esc(d.studentName) + '</b>' +
        (d.className ? ' <span class="small muted">' + ui.esc(d.className) + '</span>' : '') +
        ' ' + where + ' <span class="small muted">《' + ui.esc(d.paperName) + '》</span>' +
        '<div class="small muted">' + ui.esc((d.reason || '').slice(0, 60)) + '</div>' +
        '</span><span class="badge badge-warn nowrap">' + ui.num(d.score) + ' 分待定</span></li>');
    });

    return '<div class="card"><div class="card-title">需要你处理</div>' +
      (rows.length ? '<ul class="list-plain">' + rows.join('') + '</ul>'
        : ui.emptyState('暂时没有待你处理的', '待确认的答卷和 AI 存疑的地方会出现在这里')) +
      '</div>';
  }

  function reviewHtml(right) {
    const list = right.lowRateQuestions || [];
    return '<div class="card"><div class="card-title">最需要讲的题</div>' +
      (list.length
        ? '<ul class="list-plain">' + list.map((q) => (
          '<li class="clickable"' + goAttrs({
            page: 'stats',
            query: { paper: q.paperId, question: q.paperQuestionId },
          }) + '><span class="grow">' +
          '第 ' + q.seq + ' 题 <span class="small">' + ui.esc((q.stem || '').slice(0, 34)) + '</span>' +
          '<div class="small muted">《' + ui.esc(q.paperName) + '》 平均 ' + ui.num(q.average) + ' / ' +
          ui.num(q.points) + ' 分 · ' + q.lostCount + ' 人失分</div>' +
          '</span><span class="badge badge-danger nowrap">得分率 ' +
          Math.round((q.rate || 0) * 100) + '%</span></li>'
        )).join('') + '</ul>'
        : ui.emptyState('还没有值得讲的题', '得等试卷批完确认，才看得出哪道题问题最大')) +
      '</div>';
  }

  function bindGo(root) {
    root.querySelectorAll('[data-go-page]').forEach((el) => el.addEventListener('click', (e) => {
      if (e.target.closest('button, input')) return;
      let query = {};
      try {
        query = JSON.parse(el.getAttribute('data-go-query') || '{}');
      } catch (_) { /* 保持空查询 */ }
      App.navigate(el.getAttribute('data-go-page'), query);
    }));
  }

  App.register('home', {
    async render(root) {
      let home;
      let plan;
      try {
        const res = await Promise.all([api.get('/api/stats/home'), api.get('/api/todos')]);
        home = res[0];
        plan = res[1];
      } catch (err) {
        root.innerHTML = ui.pageHead('首页', ui.todayLabel()) +
          '<div class="card">' + ui.esc(err.message) + '</div>';
        return;
      }

      root.innerHTML =
        ui.pageHead('首页', ui.todayLabel(), '<button class="btn btn-sm" data-act="reload">刷新</button>') +
        '<div class="card">' + cardsHtml(home.cards || {}) + '</div>' +
        planHtml(plan) +
        papersHtml(home.papers || []) +
        '<div class="grid grid-2">' + workHtml(home.left || {}) + reviewHtml(home.right || {}) + '</div>';

      bindGo(root);
      root.querySelector('[data-act="reload"]').addEventListener('click', () => App.refresh());

      const input = root.querySelector('[data-todo-input]');
      async function addTodo() {
        const text = (input.value || '').trim();
        if (!text) {
          ui.toast('请先写下要提醒的事', 'error');
          return;
        }
        try {
          await api.post('/api/todos', { text });
          ui.toast('已加入今日计划', 'ok');
          await App.refresh();
        } catch (err) {
          ui.toast(err.message, 'error');
        }
      }
      root.querySelector('[data-todo-add]').addEventListener('click', addTodo);
      input.addEventListener('keydown', (e) => { if (e.key === 'Enter') addTodo(); });

      root.querySelectorAll('[data-todo-done]').forEach((box) => box.addEventListener('change', async () => {
        try {
          await api.put('/api/todos/' + box.getAttribute('data-todo-done'), { done: true });
          ui.toast('已完成', 'ok');
          await App.refresh();
        } catch (err) {
          ui.toast(err.message, 'error');
        }
      }));

      root.querySelectorAll('[data-todo-del]').forEach((b) => b.addEventListener('click', async () => {
        try {
          await api.del('/api/todos/' + b.getAttribute('data-todo-del'));
          await App.refresh();
        } catch (err) {
          ui.toast(err.message, 'error');
        }
      }));

      const clearBtn = root.querySelector('[data-todo-clear]');
      if (clearBtn) clearBtn.addEventListener('click', async () => {
        try {
          const res = await api.post('/api/todos/clear-done', {});
          ui.toast('已清掉 ' + res.removed + ' 条', 'ok');
          await App.refresh();
        } catch (err) {
          ui.toast(err.message, 'error');
        }
      });

      root.querySelectorAll('[data-paper].clickable').forEach((el) => el.addEventListener('click', () => {
        App.navigate('grading', { paper: el.getAttribute('data-paper') });
      }));
    },
  });
})();
