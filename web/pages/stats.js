(function () {
  'use strict';

  function pct(rate) {
    if (rate === null || rate === undefined) return '—';
    return Math.round(rate * 100) + '%';
  }

  function rateBar(rate) {
    const v = rate === null || rate === undefined ? 0 : Math.round(rate * 100);
    const cls = v < 50 ? 'progress danger' : (v < 75 ? 'progress warn' : 'progress ok');
    return '<div class="row nowrap" style="gap:8px">' +
      '<div class="' + cls + '" style="width:78px"><i style="width:' + v + '%"></i></div>' +
      '<span class="small">' + pct(rate) + '</span></div>';
  }

  function overviewHtml(s) {
    const o = s.overview;
    const cells = [
      ['班级平均分', o.average === null ? '—' : ui.num(o.average), '/' + ui.num(s.fullMarks)],
      ['最高分', o.highest === null ? '—' : ui.num(o.highest), ''],
      ['最低分', o.lowest === null ? '—' : ui.num(o.lowest), ''],
      ['及格率', o.passRate === null ? '—' : pct(o.passRate), o.passCount + ' / ' + o.count + ' 人'],
    ];
    return '<div class="grid grid-4">' + cells.map((c) => (
      '<div class="metric metric-static"><div class="metric-label">' + c[0] + '</div>' +
      '<div class="metric-value">' + c[1] + '<span class="metric-unit">' + ui.esc(c[2]) + '</span></div></div>'
    )).join('') + '</div>' +
      '<div class="row mt12 small muted">' +
      '<span>已确认 ' + o.confirmed + ' 份</span>' +
      '<span>已收到 ' + o.submitted + ' 份</span>' +
      '<span>待批改 ' + o.ungraded + '</span>' +
      '<span>待确认 ' + o.toConfirm + '</span>' +
      '<span>缺考 ' + o.absent + '</span>' +
      '<span>及格线 ' + ui.num(o.passLine) + '</span>' +
      (o.ungraded + o.toConfirm > 0
        ? '<span class="badge badge-warn">还有 ' + (o.ungraded + o.toConfirm) + ' 份没走完，暂不计入统计</span>'
        : '') +
      '</div>';
  }

  function rankingHtml(s) {
    if (!s.ranking.length) {
      return '<div class="card"><div class="card-title">每题得分率排行</div>' +
        ui.emptyState('还没有可统计的数据', '确认一份答卷后就有了') + '</div>';
    }
    return '<div class="card"><div class="card-title-row">' +
      '<div class="card-title">每题得分率排行</div>' +
      '<span class="small muted">得分率 = 该题得分总和 ÷ 该题满分总和，低的排前面</span></div>' +
      '<table class="data"><thead><tr>' +
      '<th>题号</th><th>题目</th><th class="num">满分</th><th class="num">平均分</th>' +
      '<th>得分率</th><th class="num">失分人数</th><th class="right">操作</th>' +
      '</tr></thead><tbody>' +
      s.ranking.map((q) => '<tr>' +
        '<td>' + q.seq + '</td>' +
        '<td>' + ui.esc((q.stem || '').slice(0, 40)) +
        (q.knowledge ? ' <span class="badge">' + ui.esc(q.knowledge) + '</span>' : '') + '</td>' +
        '<td class="num">' + ui.num(q.points) + '</td>' +
        '<td class="num">' + (q.average === null ? '—' : ui.num(q.average)) + '</td>' +
        '<td>' + rateBar(q.rate) + '</td>' +
        '<td class="num">' + q.lostCount + '</td>' +
        '<td class="right"><button class="btn btn-sm" data-question="' + q.paperQuestionId + '">看失分名单</button></td>' +
        '</tr>').join('') +
      '</tbody></table></div>';
  }

  function studentsHtml(s) {
    if (!s.students.length) {
      return '<div class="card"><div class="card-title">学生成绩排名</div>' +
        ui.emptyState('还没有已确认的成绩', '确认答卷后这里会自动排出名次') + '</div>';
    }
    return '<div class="card"><div class="card-title-row">' +
      '<div class="card-title">学生成绩排名</div>' +
      '<span class="small muted">只算已确认的答卷</span></div>' +
      '<table class="data"><thead><tr>' +
      '<th class="num">名次</th><th>姓名</th><th>班级</th>' +
      '<th class="num">总分</th><th>得分率</th><th>是否及格</th><th class="right">操作</th>' +
      '</tr></thead><tbody>' +
      s.students.map((st) => '<tr>' +
        '<td class="num">' + st.rank + '</td>' +
        '<td>' + ui.esc(st.name) +
        (st.whole ? ' <span class="badge" title="整张答题卡的照片整组交上来，没拆到题上，只有整卷总分">图片答卷</span>' : '') +
        '</td>' +
        '<td>' + ui.esc(st.className || '—') + '</td>' +
        '<td class="num"><b>' + ui.num(st.total) + '</b> / ' + ui.num(s.fullMarks) + '</td>' +
        '<td>' + rateBar(st.percent) + '</td>' +
        '<td>' + (st.passed ? '<span class="badge badge-ok">及格</span>' : '<span class="badge badge-danger">未及格</span>') + '</td>' +
        '<td class="right"><button class="btn btn-sm" data-open-grade="' + st.submissionId + '">看批改</button></td>' +
        '</tr>').join('') +
      '</tbody></table></div>';
  }

  function questionDetailHtml(d) {
    const head = '<div class="row"><span class="badge">第 ' + d.seq + ' 题</span>' +
      '<span class="badge badge-accent">满分 ' + ui.num(d.points) + '</span>' +
      '<span class="badge ' + ((d.rate || 0) < 0.5 ? 'badge-danger' : 'badge') + '">得分率 ' + pct(d.rate) + '</span>' +
      '<span class="badge">平均 ' + ui.num(d.average) + '</span>' +
      '<span class="badge badge-warn">' + d.lostCount + ' 人失分</span></div>';
    const stem = '<div class="mt12 small" style="white-space:pre-wrap">' + ui.esc(d.stem) + '</div>';
    const rubric = d.rubricType === 'items'
      ? '<ol class="small" style="padding-left:18px;margin:6px 0 0">' + d.rubricItems.map((it) =>
        '<li>' + ui.esc(it.text) + ' <span class="muted">' + ui.num(it.points) + ' 分</span></li>').join('') + '</ol>'
      : '<div class="small muted" style="white-space:pre-wrap">' + ui.esc(d.rubricText) + '</div>';

    const list = d.students.length
      ? d.students.map((s) => '<div class="item-row">' +
        '<div class="item-head"><span><b>' + ui.esc(s.name) + '</b>' +
        (s.className ? ' <span class="small muted">' + ui.esc(s.className) + '</span>' : '') +
        (s.doubtCount ? ' <span class="badge badge-warn">存疑 ' + s.doubtCount + '</span>' : '') +
        '</span><span class="nowrap">得 <b>' + ui.num(s.score) + '</b> / ' + ui.num(d.points) +
        ' · 失 <b style="color:var(--danger)">' + ui.num(s.lost) + '</b> 分</span></div>' +
        '<div class="item-reason">' + s.items.map((i) => (
          '<div>' + ui.esc(i.criterion) + '：' + ui.num(i.score) + ' / ' + ui.num(i.max) +
          (i.reason ? ' <span class="muted">— ' + ui.esc(i.reason.slice(0, 80)) + '</span>' : '') + '</div>'
        )).join('') + '</div></div>').join('')
      : '<div class="empty">这道题全班都拿满分了</div>';

    return '<h3>失分学生名单</h3>' + head + stem + rubric +
      '<div class="mt16">' + list + '</div>' +
      '<div class="modal-actions"><button class="btn" data-close>关闭</button></div>';
  }

  async function openQuestion(root, paperId, pqid) {
    try {
      const d = await api.get('/api/stats/paper/' + paperId + '/question/' + pqid);
      await ui.modal(questionDetailHtml(d));
    } catch (err) {
      ui.toast(err.message, 'error');
    }
    void root;
  }

  function bindQuestionButtons(root, paperId) {
    root.querySelectorAll('[data-question]').forEach((b) => b.addEventListener('click', () => {
      openQuestion(root, paperId, b.getAttribute('data-question'));
    }));
  }

  /** 还没选试卷时的选择页 */
  async function renderPicker(root) {
    let papers = [];
    try {
      papers = (await api.get('/api/papers')).papers.filter((p) => p.status !== 'draft');
    } catch (err) {
      root.innerHTML = ui.pageHead('统计') + '<div class="card">' + ui.esc(err.message) + '</div>';
      return;
    }

    const rows = await Promise.all(papers.map(async (p) => {
      let average = null;
      let count = 0;
      if (p.progress && p.progress.confirmed > 0) {
        try {
          const s = await api.get('/api/stats/paper/' + p.id);
          average = s.overview.average;
          count = s.overview.count;
        } catch (_) { /* 单份取不到就不显示平均分 */ }
      }
      return { p, average, count };
    }));

    root.innerHTML = ui.pageHead('统计', '先选一份试卷') + '<div class="card">' +
      (rows.length
        ? '<table class="data"><thead><tr>' +
          '<th>试卷</th><th>状态</th><th class="num">已确认</th><th class="num">平均分</th><th class="right">操作</th>' +
          '</tr></thead><tbody>' + rows.map((r) => '<tr>' +
            '<td>' + ui.esc(r.p.name) + '</td>' +
            '<td>' + ui.statusBadge(r.p.status) + '</td>' +
            '<td class="num">' + r.count + ' / ' + (r.p.progress ? r.p.progress.studentCount : 0) + '</td>' +
            '<td class="num">' + (r.average === null ? '—' : ui.num(r.average)) + '</td>' +
            '<td class="right">' + (r.count
              ? '<button class="btn btn-sm btn-primary" data-pick="' + r.p.id + '">看统计</button>'
              : '<span class="small muted">还没有确认的成绩</span>') + '</td>' +
            '</tr>').join('') + '</tbody></table>'
        : ui.emptyState('还没有可统计的试卷', '先去「试卷」页组卷发布，并在「提交」页收答案')) +
      '</div>';

    root.querySelectorAll('[data-pick]').forEach((b) => b.addEventListener('click', () => {
      App.navigate('stats', { paper: b.getAttribute('data-pick') });
    }));
  }

  App.register('stats', {
    async render(root, query) {
      if (!query.paper) {
        await renderPicker(root);
        return;
      }

      let s;
      try {
        s = await api.get('/api/stats/paper/' + query.paper);
      } catch (err) {
        root.innerHTML = ui.pageHead('统计') + '<div class="card">' + ui.esc(err.message) + '</div>' +
          '<div class="row"><button class="btn" data-act="switch">换一份试卷</button></div>';
        root.querySelector('[data-act="switch"]').addEventListener('click', () => App.navigate('stats'));
        return;
      }

      const paperId = s.paper.id;
      root.innerHTML =
        ui.pageHead('统计', s.paper.name + ' · 满分 ' + ui.num(s.fullMarks),
          '<button class="btn btn-sm" data-act="switch">换试卷</button>' +
          '<button class="btn btn-sm btn-primary" data-act="grading">去看批改</button>') +
        '<div class="card">' + overviewHtml(s) + '</div>' +
        rankingHtml(s) +
        studentsHtml(s);

      root.querySelector('[data-act="switch"]').addEventListener('click', () => App.navigate('stats'));
      root.querySelector('[data-act="grading"]').addEventListener('click', () => {
        App.navigate('grading', { paper: paperId });
      });

      // 学生表里点「看批改」直接定位到该生的答卷
      root.querySelectorAll('[data-open-grade]').forEach((btn) => btn.addEventListener('click', () => {
        App.navigate('grading', {
          paper: paperId,
          filter: 'all',
          sub: btn.getAttribute('data-open-grade'),
        });
      }));

      bindQuestionButtons(root, paperId);

      if (query.question) await openQuestion(root, paperId, query.question);
    },
  });
})();
