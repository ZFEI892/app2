(function () {
  'use strict';

  /**
   * 导航只围绕「批改一份卷子」这条主线：
   * 建卷 → 收答案 → AI 批改 → 老师确认，「评分标准」是 AI 打分的依据，不再叫「题库」。
   */
  const NAV = [
    { group: '批改', items: [
      { id: 'home', label: '首页' },
      { id: 'papers', label: '试卷' },
      { id: 'submissions', label: '提交' },
      { id: 'grading', label: '批改' },
      { id: 'questions', label: '评分标准' },
    ] },
    { group: '数据', items: [
      { id: 'stats', label: '统计' },
      { id: 'students', label: '学生' },
    ] },
    { group: '系统', items: [
      { id: 'settings', label: '设置' },
    ] },
  ];

  const pages = {};
  let currentId = null;
  let currentQuery = {};

  function register(id, spec) {
    pages[id] = spec;
  }

  function parseHash() {
    const raw = (location.hash || '').replace(/^#\/?/, '');
    const [id, qs] = raw.split('?');
    return {
      id: id || 'home',
      query: Object.fromEntries(new URLSearchParams(qs || '')),
    };
  }

  function buildQuery(query) {
    const clean = {};
    Object.entries(query || {}).forEach(([k, v]) => {
      if (v !== undefined && v !== null && v !== '') clean[k] = v;
    });
    const qs = new URLSearchParams(clean).toString();
    return qs ? '?' + qs : '';
  }

  function navigate(id, query) {
    location.hash = '#/' + id + buildQuery(query);
  }

  function renderNav() {
    const nav = document.getElementById('nav');
    let html = '';
    NAV.forEach((group) => {
      html += '<div class="nav-group-title">' + ui.esc(group.group) + '</div>';
      group.items.forEach((item) => {
        html += '<a class="nav-item" data-page="' + item.id + '" href="#/' + item.id + '">' + ui.esc(item.label) + '</a>';
      });
    });
    nav.innerHTML = html;
  }

  function setActive(id) {
    document.querySelectorAll('.nav-item').forEach((el) => {
      el.classList.toggle('active', el.getAttribute('data-page') === id);
    });
  }

  async function renderRoute() {
    const { id, query } = parseHash();
    const page = pages[id] || pages.home;
    currentId = id;
    currentQuery = query;
    setActive(pages[id] ? id : 'home');
    const main = document.getElementById('main');
    main.innerHTML = ui.loading();
    try {
      await page.render(main, query);
    } catch (err) {
      main.innerHTML =
        '<div class="card"><div class="card-title">页面加载失败</div>' +
        '<div class="muted">' + ui.esc(err && err.message ? err.message : String(err)) + '</div>' +
        '<div class="mt12"><button class="btn" onclick="location.reload()">重新加载</button></div></div>';
    }
    main.scrollTop = 0;
  }

  /** 页面可调用 App.refresh() 重绘当前页 */
  async function refresh() {
    await renderRoute();
  }

  async function checkHealth() {
    const foot = document.getElementById('sidebar-foot');
    try {
      const info = await api.get('/api/health');
      foot.innerHTML =
        '<div>数据文件：本地已就绪</div>' +
        '<div>AI 模式：' + ui.esc(info.aiMode === 'mock' ? '模拟' : '真实') + '</div>';
    } catch (err) {
      foot.innerHTML = '<div style="color:var(--danger)">服务未连接</div>';
    }
  }

  function start() {
    renderNav();
    window.addEventListener('hashchange', renderRoute);
    if (!location.hash) location.hash = '#/home';
    renderRoute();
    checkHealth();
  }

  window.App = {
    NAV, register, navigate, refresh, start,
    current: () => ({ id: currentId, query: currentQuery }),
  };

  window.addEventListener('keydown', (e) => {
    const page = pages[currentId];
    if (page && typeof page.onKey === 'function') page.onKey(e);
  });
})();
