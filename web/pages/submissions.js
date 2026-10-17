(function () {
  'use strict';

  /**
   * 「提交」页 = 老师把学生的作答收进来。
   *
   * 主路径是**图片答卷**：不用出题、不用先建卷 —— 填个卷名、把这名学生的整组
   * 答题卡照片交上来，就是一份「整份图片作答」。批改时 AI 看整卷给一个总分，
   * 并把做错的题挑出来。卷名对得上已有卷子就挂到那份卷子上，对不上就自动建一份
   * **没有题目**的卷子（满分由卷上的「整卷满分」定）。
   *
   * 另外两条备用路径要先有题目：老师代录（键盘录入 + 单题贴图）、学生自填。
   */

  // 主路径是直接交图片，所以默认停在这一档
  let activeTab = 'whole';
  let currentPaperId = null;

  const TABS = [
    { id: 'whole', label: '图片答卷' },
    { id: 'manual', label: '老师代录' },
    { id: 'self', label: '学生自填' },
  ];

  /** 「图片答卷」一次最多交多少张，跟后端 MAX_WHOLE_IMAGES 保持一致 */
  const MAX_WHOLE_IMAGES = 30;

  function readFileAsDataUrl(file) {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(reader.result);
      reader.onerror = () => reject(new Error('读取文件失败'));
      reader.readAsDataURL(file);
    });
  }

  /**
   * 长边压到 1600px 再上传：手写答题卡需要足够清晰，AI 才认得准（漏判少）。
   * 之前为躲「深度思考」超时压到过 1024，现已关闭思考、1600px 批一份约 40 秒，
   * 清晰度比体积更值得保。
   */
  function compressImage(file, maxDim) {
    return readFileAsDataUrl(file).then((dataUrl) => new Promise((resolve) => {
      const img = new Image();
      img.onload = () => {
        const limit = maxDim || 1600;
        let { width, height } = img;
        const scale = Math.min(1, limit / Math.max(width, height));
        width = Math.round(width * scale);
        height = Math.round(height * scale);
        const canvas = document.createElement('canvas');
        canvas.width = width;
        canvas.height = height;
        const ctx = canvas.getContext('2d');
        ctx.drawImage(img, 0, 0, width, height);
        resolve(canvas.toDataURL('image/jpeg', 0.85));
      };
      img.onerror = () => resolve(dataUrl);
      img.src = dataUrl;
    }));
  }

  function thumbHtml(src, alt) {
    return '<img class="answer-img" style="max-height:110px;margin-right:8px" src="' +
      ui.esc(src) + '" alt="' + ui.esc(alt) + '">';
  }

  /** 学生下拉的两个来源（全库学生 / 某份卷子的学生）统一成同一种形状 */
  function studentOptions(students) {
    return students.map((s) =>
      '<option value="' + s.id + '">' + ui.esc(s.name) +
      (s.className ? '（' + ui.esc(s.className) + '）' : '') +
      (s.hasSubmission ? ' · 已有答卷' : '') + '</option>').join('');
  }

  /* ============================ 图片答卷（主路径） ============================ */

  /**
   * 「图片答卷」那张卡。
   * @param {object} opts
   *   - students：可选学生
   *   - papers：已有卷子（自由模式用来做卷名建议）
   *   - fixedPaper：已选定的卷子（在卷子工作区里用时传），null = 自由模式（自己填卷名）
   */
  function wholeFormHtml(opts) {
    const fixed = opts.fixedPaper;
    const papers = opts.papers || [];

    const marksLine = fixed
      ? '<span class="badge">' + ui.esc(fixed.name) + '</span>' +
        '<span class="small muted" data-marks-hint>' +
        (fixed.questionCount
          ? '这份卷子有 ' + fixed.questionCount + ' 道题，满分按各题分值之和 ' + ui.num(fixed.fullMarks) + ' 分算。'
          : '这份卷子还没有题目（专门用来收图片答卷），满分 ' + ui.num(fixed.fullMarks) + ' 分。') +
        '</span>'
      : '<label class="field" style="margin-bottom:0;flex:1"><span>卷名</span>' +
        '<input type="text" data-f="paper-name" list="whole-paper-names" placeholder="比如：10 月月考数学">' +
        '</label>' +
        '<label class="field" style="margin-bottom:0;width:150px"><span>整卷满分</span>' +
        '<input type="number" min="1" step="1" data-f="full-marks" value="100" style="width:100%">' +
        '</label>' +
        '<datalist id="whole-paper-names">' +
        papers.map((p) => '<option value="' + ui.esc(p.name) + '"></option>').join('') +
        '</datalist>' +
        '<p class="small muted" style="margin:0 0 10px;flex-basis:100%" data-marks-hint>' +
        '卷名对得上已有卷子就用那份卷子；对不上会自动新建一份<b>没有题目</b>的卷子。' +
        '卷子里有题目时，满分按各题分值之和算，这里填的不生效。</p>';

    return '<div class="card">' +
      '<div class="card-title">图片答卷（不用出题，直接交）</div>' +
      '<p class="muted small" style="margin-top:0">' +
      '把一名学生的答题卡<b>整组拍照直接交上来</b>：不用出题、不用先建卷子，交完就能批。' +
      '批改时 AI 看这组照片给<b>一个总分</b>，并把<b>做错的题、错在哪里</b>挑出来，' +
      '老师再改分、标存疑、确认。</p>' +
      '<div class="row mb12">' + marksLine + '</div>' +
      '<div class="row mb12">' +
      '<label class="field" style="margin-bottom:0;flex:1"><span>这是谁的卷子</span>' +
      '<select data-f="student"><option value="">请选择…</option>' +
      studentOptions(opts.students) +
      '</select></label>' +
      (fixed ? '<button class="btn btn-sm" data-act="absent">标记缺考</button>' : '') +
      '</div>' +
      '<div class="dropzone" data-drop>点击选择照片，或把这组照片一起拖进来<br>' +
      '<span class="small">一次可选多张，最多 ' + MAX_WHOLE_IMAGES + ' 张</span></div>' +
      '<input type="file" multiple accept="image/*" data-file style="display:none">' +
      '<div data-progress class="mt12"></div>' +
      '<div data-shots class="mt12"></div>' +
      '<div class="row mt12"><button class="btn btn-primary" data-act="submit">提交这份图片答卷</button>' +
      '<button class="btn" data-act="clear">清空重选</button>' +
      '<span class="small muted" data-hint></span></div>' +
      '</div>';
  }

  /** 绑定「图片答卷」那张卡上的所有交互 */
  function bindWholeForm(root, opts) {
    const fixed = opts.fixedPaper;
    const papers = opts.papers || [];
    let studentId = '';
    let shotPaths = [];   // 已落盘的附件路径（提交时用的就是这些）
    let previews = [];    // 对应的缩略图 dataURL

    const drop = root.querySelector('[data-drop]');
    const fileInput = root.querySelector('[data-file]');
    const sel = root.querySelector('[data-f="student"]');
    const hint = root.querySelector('[data-hint]');
    const nameInput = root.querySelector('[data-f="paper-name"]');
    const marksInput = root.querySelector('[data-f="full-marks"]');
    const marksHint = root.querySelector('[data-marks-hint]');

    function paintHint() {
      hint.textContent = shotPaths.length
        ? '已选 ' + shotPaths.length + ' 张' + (studentId ? '' : '，还差"这是谁的卷子"')
        : '还没有选照片';
    }

    function paintShots() {
      root.querySelector('[data-shots]').innerHTML = previews.length
        ? '<div class="small muted mb8">本组 ' + previews.length + ' 张，已按选择顺序编号</div>' +
          previews.map((src, i) => thumbHtml(src, '第 ' + (i + 1) + ' 张')).join('')
        : '';
    }

    /**
     * 自由模式下卷名一改，满分提示就跟着变：
     * 卷名撞上已有卷子 → 回填它当前的整卷满分（仍可改），没撞上 → 就用你填的建新卷。
     */
    function syncMarksHint() {
      if (fixed || !nameInput || !marksInput || !marksHint) return;
      const name = nameInput.value.trim();
      const hit = name ? papers.find((p) => p.name === name) : null;
      marksInput.disabled = false;
      if (hit) {
        const current = hit.wholeFullMarks ? hit.wholeFullMarks : (hit.progress.total || 100);
        // 只在第一次撞上这个卷名时回填，别把老师手动改的满分又盖回去
        if (marksInput.__synced !== name) {
          marksInput.value = current;
          marksInput.__synced = name;
        }
        marksHint.innerHTML = '已有「' + ui.esc(hit.name) + '」，当前整卷满分 <b>' + ui.num(current) + ' 分</b>' +
          (hit.progress.questionCount ? '（' + hit.progress.questionCount + ' 道题）。改这里就更新它；有题目的话，改完记得去「试卷」页让 AI 重新分配。' : '（图片答卷专用卷）。');
      } else {
        marksInput.__synced = null;
        marksHint.innerHTML = '卷名对不上已有卷子 → 会自动新建一份<b>没有题目</b>的卷子，按这个满分算。';
      }
    }

    sel.addEventListener('change', () => { studentId = sel.value; paintHint(); });
    if (nameInput) {
      nameInput.addEventListener('input', syncMarksHint);
      nameInput.addEventListener('change', syncMarksHint);
    }

    drop.addEventListener('click', () => fileInput.click());
    drop.addEventListener('dragover', (e) => { e.preventDefault(); drop.classList.add('over'); });
    drop.addEventListener('dragleave', () => drop.classList.remove('over'));
    drop.addEventListener('drop', async (e) => {
      e.preventDefault();
      drop.classList.remove('over');
      await handleFiles(e.dataTransfer && e.dataTransfer.files);
    });
    fileInput.addEventListener('change', async () => { await handleFiles(fileInput.files); });

    async function handleFiles(fileList) {
      const all = Array.from(fileList || []);
      const files = all.filter((f) => /^image\//.test(f.type));
      if (!files.length) { ui.toast('这里只收图片', 'error'); return; }
      // 图片里混了别的文件：整批退回去，免得老师以为那份也一起交上去了
      if (files.length !== all.length) {
        ui.toast('这里只收图片 —— 一次选一组答题卡照片', 'error');
        return;
      }
      if (files.length > MAX_WHOLE_IMAGES) {
        ui.toast('一次最多 ' + MAX_WHOLE_IMAGES + ' 张', 'error');
        return;
      }
      const progress = root.querySelector('[data-progress]');
      try {
        progress.innerHTML = '<span class="badge badge-accent">正在处理 ' + files.length + ' 张照片…</span>';
        // 换一组就整组替换，避免上一组的照片混进来
        shotPaths = [];
        previews = [];
        for (const file of files) {
          const dataUrl = await compressImage(file);
          const up = await api.post('/api/uploads', { data: dataUrl, ext: 'jpg' });
          shotPaths.push(up.path);
          previews.push(dataUrl);
        }
        paintShots();
        paintHint();
        progress.innerHTML = '';
        ui.toast('已收下 ' + files.length + ' 张照片', 'ok');
      } catch (err) {
        progress.innerHTML = '';
        shotPaths = [];
        previews = [];
        paintShots();
        paintHint();
        ui.toast(err.message, 'error');
      }
    }

    root.querySelector('[data-act="clear"]').addEventListener('click', () => {
      shotPaths = [];
      previews = [];
      fileInput.value = '';
      paintShots();
      paintHint();
    });

    const absentBtn = root.querySelector('[data-act="absent"]');
    if (absentBtn) {
      absentBtn.addEventListener('click', async () => {
        if (!sel.value) { ui.toast('请先选择学生', 'error'); return; }
        try {
          await api.post('/api/papers/' + fixed.id + '/submissions', {
            studentId: Number(sel.value), source: 'manual', status: 'absent', answers: [],
          });
          ui.toast('已标记缺考', 'ok');
          await App.refresh();
        } catch (err) { ui.toast(err.message, 'error'); }
      });
    }

    root.querySelector('[data-act="submit"]').addEventListener('click', async () => {
      if (!sel.value) { ui.toast('请先选择学生', 'error'); return; }
      if (!shotPaths.length) { ui.toast('请先选照片', 'error'); return; }
      const body = { studentId: Number(sel.value), images: shotPaths, source: 'import' };
      if (fixed) {
        body.paperId = fixed.id;
      } else {
        const paperName = (nameInput.value || '').trim();
        if (!paperName) { ui.toast('请先填一个卷名', 'error'); nameInput.focus(); return; }
        body.paperName = paperName;
        // 整卷满分就是这份卷子的整卷总分：新建用它，撞上已有卷子也会更新它
        if (marksInput.value !== '') body.wholeFullMarks = Number(marksInput.value);
      }
      const btn = root.querySelector('[data-act="submit"]');
      btn.disabled = true;
      try {
        const res = await api.post('/api/whole-submissions', body);
        ui.toast('已把 ' + shotPaths.length + ' 张照片交到「' + res.paper.name + '」，这份卷子现在有 ' +
          (res.submissionCount || 1) + ' 份答卷', 'ok');
        await App.refresh();
      } catch (err) {
        btn.disabled = false;
        ui.toast(err.message, 'error');
      }
    });

    syncMarksHint();
    paintHint();
  }

  /** 提交页的默认画面：直接交图片答卷 + 下方列出可以逐题录的卷子 */
  async function renderWholeEntry(root) {
    let papers = [];
    let rawStudents = [];
    try {
      const results = await Promise.all([api.get('/api/papers'), api.get('/api/students')]);
      papers = results[0].papers;
      rawStudents = results[1].students;
    } catch (err) {
      root.innerHTML = ui.pageHead('提交答卷') + '<div class="card">' + ui.esc(err.message) + '</div>';
      return;
    }

    const students = rawStudents.map((s) => ({
      id: s.id, name: s.name, className: s.className, hasSubmission: s.submissionCount > 0,
    }));
    const usable = papers.filter((p) => p.status !== 'draft');

    root.innerHTML =
      ui.pageHead('提交答卷', '不用出题 —— 拍好整卷，直接交') +
      wholeFormHtml({ students, papers, fixedPaper: null }) +
      '<div class="card">' +
      '<div class="card-title">要逐题录、或让学生自己填？</div>' +
      '<p class="muted small" style="margin-top:0">那两条路要先有一份<b>挑好题目</b>的卷子。</p>' +
      (usable.length
        ? '<table class="data"><thead><tr><th>试卷</th><th>状态</th><th class="num">题目</th><th class="num">已收</th><th class="right">操作</th></tr></thead><tbody>' +
          usable.map((p) =>
            '<tr><td>' + ui.esc(p.name) + '</td><td>' + ui.statusBadge(p.status) + '</td>' +
            '<td class="num">' + p.progress.questionCount + '</td>' +
            '<td class="num">' + p.progress.submissionCount + ' / ' + p.progress.studentCount + '</td>' +
            '<td class="right"><button class="btn btn-sm btn-primary" data-pick="' + p.id + '">打开这份</button></td></tr>'
          ).join('') + '</tbody></table>'
        : ui.emptyState('还没有挑好题目的卷子', '只收图片答卷的话，上面填个卷名就能交，不必来这里')) +
      '</div>';

    bindWholeForm(root, { students, papers, fixedPaper: null });

    root.querySelectorAll('[data-pick]').forEach((b) => b.addEventListener('click', () => {
      App.navigate('submissions', { paper: b.getAttribute('data-pick') });
    }));
  }

  /* ========================= 某一份卷子的工作区（三个页签） ========================= */

  async function renderPaperWorkspace(root, query) {
    currentPaperId = query.paper;
    if (query.tab && TABS.some((t) => t.id === query.tab)) activeTab = query.tab;

    let detail;
    let subList;
    try {
      const results = await Promise.all([
        api.get('/api/papers/' + query.paper),
        api.get('/api/papers/' + query.paper + '/submissions'),
      ]);
      detail = results[0];
      subList = results[1];
    } catch (err) {
      root.innerHTML = ui.pageHead('提交答卷') + '<div class="card">' + ui.esc(err.message) + '</div>';
      return;
    }

    const questions = detail.questions;
    const students = subList.students.map((s) => ({
      id: s.studentId,
      name: s.name,
      className: s.className,
      hasSubmission: Boolean(s.submissionId),
      status: s.status,
    }));

    root.innerHTML =
      ui.pageHead('提交答卷', detail.paper.name + ' · 共 ' + students.length + ' 位学生',
        '<button class="btn btn-sm" data-act="back">回到直接交图片</button>' +
        '<button class="btn btn-sm" data-act="grade">去批改</button>') +
      '<div class="card" style="padding:12px 18px">' +
      '<div class="row"><span class="badge">' + ui.esc(detail.paper.name) + '</span>' +
      ui.statusBadge(detail.paper.status) +
      '<span class="small muted">题目 ' + questions.length + ' 道 · 满分 ' + ui.num(detail.total) + '</span>' +
      '<div class="spacer"></div>' +
      '<span class="small muted">已收 ' + subList.submitted + ' · 缺考 ' + subList.absent + ' · 未交 ' +
      (students.length - subList.submitted - subList.absent) + '</span></div></div>' +
      '<div class="tabs mb12">' +
      TABS.map((t) => '<button data-tab="' + t.id + '" class="' + (activeTab === t.id ? 'active' : '') + '">' + t.label + '</button>').join('') +
      '</div>' +
      '<div data-tab-host></div>';

    const host = root.querySelector('[data-tab-host]');
    root.querySelector('[data-act="back"]').addEventListener('click', () => App.navigate('submissions'));
    root.querySelector('[data-act="grade"]').addEventListener('click', () => App.navigate('grading', { paper: query.paper }));
    root.querySelectorAll('[data-tab]').forEach((b) => b.addEventListener('click', () => {
      activeTab = b.getAttribute('data-tab');
      root.querySelectorAll('[data-tab]').forEach((x) => x.classList.toggle('active', x === b));
      renderTab();
    }));

    function renderTab() {
      if (activeTab === 'manual') renderManual();
      else if (activeTab === 'self') renderSelf();
      else renderWhole();
    }

    /** 这一档只在有题目时才有意义 */
    function requireQuestions() {
      if (questions.length) return false;
      host.innerHTML = '<div class="card">' +
        ui.emptyState('这份卷子没有题目', '它只能收「图片答卷」。要逐题录或让学生自填，请先到「试卷」页给它挑题目。') +
        '</div>';
      return true;
    }

    function renderWhole() {
      const fullMarks = detail.total;
      host.innerHTML = wholeFormHtml({
        students,
        papers: [],
        fixedPaper: {
          id: detail.paper.id,
          name: detail.paper.name,
          questionCount: questions.length,
          fullMarks,
        },
      });
      bindWholeForm(host, {
        students,
        papers: [],
        fixedPaper: {
          id: detail.paper.id,
          name: detail.paper.name,
          questionCount: questions.length,
          fullMarks,
        },
      });
    }

    /* ---------------------------------- 老师代录 ---------------------------------- */

    function renderManual() {
      if (requireQuestions()) return;
      const state = {
        studentId: '',
        answers: questions.map(() => ({ text: '', images: [] })),
      };
      host.innerHTML =
        '<div class="card">' +
        '<div class="row mb12">' +
        '<label class="field" style="margin-bottom:0;flex:1"><span>选择学生</span>' +
        '<select data-f="student"><option value="">请选择…</option>' +
        studentOptions(students) +
        '</select></label>' +
        '<button class="btn btn-sm" data-act="absent">标记缺考</button>' +
        '</div>' +
        '<div data-answers>' +
        questions.map((q, i) =>
          '<div class="card" style="background:var(--panel-2);border:none;margin-bottom:10px">' +
          '<div class="small muted mb8">第 ' + q.seq + ' 题 · ' + ui.num(q.points) + ' 分</div>' +
          '<div class="mb8">' + ui.esc(q.stem.slice(0, 120)) + (q.stem.length > 120 ? '…' : '') + '</div>' +
          '<textarea rows="3" data-ans="' + i + '" placeholder="粘贴或输入这名学生这一题的答案"></textarea>' +
          '<div class="row mt8"><input type="file" accept="image/*" multiple data-img="' + i + '">' +
          '<div data-imgs="' + i + '" class="small muted"></div></div>' +
          '</div>'
        ).join('') +
        '</div>' +
        '<div class="row mt12"><button class="btn btn-primary" data-act="save">保存并录下一位</button>' +
        '<span class="small muted" data-hint>也可以直接贴这一题的照片，一题可以贴多张；贴了照片的题，AI 批改时直接看图自主判分</span></div>' +
        '</div>';

      const sel = host.querySelector('[data-f="student"]');
      sel.addEventListener('change', () => { state.studentId = sel.value; });

      const paintImages = (idx) => {
        host.querySelector('[data-imgs="' + idx + '"]').innerHTML =
          state.answers[idx].images.map((p, n) => thumbHtml('/files/' + p, '第 ' + (n + 1) + ' 张')).join('');
      };

      host.querySelectorAll('[data-ans]').forEach((ta) => ta.addEventListener('input', () => {
        state.answers[Number(ta.getAttribute('data-ans'))].text = ta.value;
      }));

      host.querySelectorAll('[data-img]').forEach((input) => input.addEventListener('change', async () => {
        const idx = Number(input.getAttribute('data-img'));
        const files = Array.from(input.files || []);
        if (!files.length) return;
        try {
          for (const file of files) {
            const dataUrl = await compressImage(file);
            const up = await api.post('/api/uploads', { data: dataUrl, ext: 'jpg' });
            state.answers[idx].images.push(up.path);
          }
          paintImages(idx);
          ui.toast('已贴 ' + files.length + ' 张图', 'ok');
        } catch (err) {
          ui.toast(err.message, 'error');
        }
      }));

      host.querySelector('[data-act="absent"]').addEventListener('click', async () => {
        if (!sel.value) { ui.toast('请先选择学生', 'error'); return; }
        try {
          await api.post('/api/papers/' + currentPaperId + '/submissions', {
            studentId: Number(sel.value), source: 'manual', status: 'absent', answers: [],
          });
          ui.toast('已标记缺考', 'ok');
          await App.refresh();
        } catch (err) { ui.toast(err.message, 'error'); }
      });

      host.querySelector('[data-act="save"]').addEventListener('click', async () => {
        if (!sel.value) { ui.toast('请先选择学生', 'error'); return; }
        const answers = state.answers.map((a, i) => ({
          paperQuestionId: questions[i].paperQuestionId,
          text: a.text,
          images: a.images,
        }));
        try {
          await api.post('/api/papers/' + currentPaperId + '/submissions', {
            studentId: Number(sel.value), source: 'manual', status: 'submitted', answers,
          });
          const idx = students.findIndex((s) => String(s.id) === String(sel.value));
          const next = students.slice(idx + 1).find((s) => !s.hasSubmission);
          ui.toast('已保存' + (next ? '，下一位：' + next.name : ''), 'ok');
          if (next) {
            sel.value = String(next.id);
            state.studentId = sel.value;
            state.answers = questions.map(() => ({ text: '', images: [] }));
            host.querySelectorAll('[data-ans]').forEach((ta) => { ta.value = ''; });
            host.querySelectorAll('[data-imgs]').forEach((d) => { d.innerHTML = ''; });
          } else {
            await App.refresh();
          }
        } catch (err) { ui.toast(err.message, 'error'); }
      });
    }

    /* ---------------------------------- 学生自填 ---------------------------------- */

    function renderSelf() {
      if (requireQuestions()) return;
      host.innerHTML =
        '<div class="card">' +
        '<div class="card-title">学生自填模式</div>' +
        '<p class="muted small">把屏幕交给学生：点自己的名字 → 逐题作答 → 提交。交过的会显示「已交」。</p>' +
        '<table class="data"><thead><tr><th>姓名</th><th>班级</th><th>状态</th><th class="right">操作</th></tr></thead><tbody>' +
        students.map((s) =>
          '<tr><td>' + ui.esc(s.name) + '</td><td>' + ui.esc(s.className || '—') + '</td>' +
          '<td>' + (s.status === 'absent' ? ui.statusBadge('absent') : (s.hasSubmission ? ui.statusBadge('submitted') : '<span class="badge">未交</span>')) + '</td>' +
          '<td class="right"><button class="btn btn-sm" data-self="' + s.id + '"' + (s.status === 'absent' ? ' disabled' : '') + '>进入作答</button></td></tr>'
        ).join('') +
        '</tbody></table></div>';

      host.querySelectorAll('[data-self]').forEach((b) => b.addEventListener('click', () => {
        openSelfForm(students.find((s) => String(s.id) === b.getAttribute('data-self')));
      }));
    }

    function openSelfForm(student) {
      const html =
        '<h3>' + ui.esc(student.name) + ' · 作答</h3>' +
        '<p class="muted small" style="margin-top:0">' + ui.esc(detail.paper.name) + '</p>' +
        questions.map((q, i) =>
          '<label class="field"><span>第 ' + q.seq + ' 题（' + ui.num(q.points) + ' 分）</span>' +
          '<div class="small muted mb8">' + ui.esc(q.stem.slice(0, 120)) + '</div>' +
          '<textarea rows="3" data-self-ans="' + i + '"></textarea></label>'
        ).join('') +
        '<div class="modal-actions"><button class="btn" data-close>取消</button>' +
        '<button class="btn btn-primary" data-submit-self>提交</button></div>';

      ui.modal(html, {
        onMount(box, done) {
          box.querySelector('[data-submit-self]').addEventListener('click', async () => {
            const answers = questions.map((q, i) => ({
              paperQuestionId: q.paperQuestionId,
              text: box.querySelector('[data-self-ans="' + i + '"]').value,
              images: [],
            }));
            try {
              await api.post('/api/papers/' + currentPaperId + '/submissions', {
                studentId: student.id, source: 'self', status: 'submitted', answers,
              });
              done(true);
            } catch (err) { ui.toast(err.message, 'error'); }
          });
        },
      }).then(async (r) => {
        if (r) {
          ui.toast('已提交', 'ok');
          await App.refresh();
        }
      });
    }

    renderTab();
  }

  App.register('submissions', {
    async render(root, query) {
      if (query.paper) {
        await renderPaperWorkspace(root, query);
        return;
      }
      await renderWholeEntry(root);
    },
  });
})();
