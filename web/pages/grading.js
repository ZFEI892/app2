(function () {
  'use strict';

  const FILTER_LABEL = { all: '全部', pending: '待批改', to_confirm: '待确认', doubt: '存疑' };
  let pollTimer = null;

  function clearPoll() {
    if (pollTimer) {
      clearInterval(pollTimer);
      pollTimer = null;
    }
  }

  function paneStudent(q) {
    const imgs = (q.answerImages || []).map((p) =>
      '<img class="answer-img" src="/files/' + ui.esc(p) + '">').join('');
    return '<div class="pane"><div class="pane-title">学生答案 · 第 ' + q.seq + ' 题</div>' +
      (imgs || '') +
      (q.answerText
        ? '<div style="white-space:pre-wrap">' + ui.esc(q.answerText) + '</div>'
        : (imgs ? '<div class="small muted">（仅图片作答）</div>' : '<div class="small muted">（这一题没有作答）</div>')) +
      '</div>';
  }

  /**
   * 中栏：题目依据。
   * 纯文字作答走「逐条对照评分标准」，这一栏就是老师的核对表；
   * 图片作答走「AI 自主评判」，AI 根本不看评分标准，那就不能还把它摆在台面上当依据，
   * 改为突出题干和满分，评分标准收进折叠里备查（老师想自己核一遍时还能翻出来）。
   */
  function paneStandard(q) {
    const rubric = q.rubricType === 'items'
      ? '<ol style="padding-left:18px;margin:8px 0 0">' + q.rubricItems.map((it) =>
        '<li>' + ui.esc(it.text) + ' <span class="muted small">' + ui.num(it.points) + ' 分</span></li>').join('') + '</ol>'
      : '<div class="small" style="white-space:pre-wrap">' + ui.esc(q.rubricText) + '</div>';

    if (q.gradingMode === 'auto') {
      return '<div class="pane"><div class="pane-title">题目 · 本题不看评分标准</div>' +
        '<div style="white-space:pre-wrap">' + (q.stem ? ui.esc(q.stem) : '<span class="muted small">（未记录题干）</span>') + '</div>' +
        '<div class="mt12">' + ui.statusBadge('auto') +
        '<span class="small muted"> 学生交的是照片，AI 直接看图判分，满分 ' + ui.num(q.points) + ' 分。</span></div>' +
        '<details class="mt12"><summary class="small muted" style="cursor:pointer">展开评分标准备查</summary>' + rubric + '</details>' +
        '</div>';
    }

    return '<div class="pane"><div class="pane-title">参考答案 · 评分标准</div>' +
      '<div style="white-space:pre-wrap">' + (q.refAnswer ? ui.esc(q.refAnswer) : '<span class="muted small">（未提供）</span>') + '</div>' +
      '<div class="mt12 small muted">评分标准（满分 ' + ui.num(q.points) + ' 分）</div>' + rubric + '</div>';
  }

  function paneAi(q, locked) {
    if (!q.items || !q.items.length) {
      return '<div class="pane ai"><div class="pane-title">AI 评分</div><div class="small muted">还没有批改结果</div></div>';
    }
    const auto = q.gradingMode === 'auto';
    return '<div class="pane ai"><div class="pane-title">AI 评分（可修改）' +
      (auto ? ' · 自主评判' : '') + '</div>' +
      q.items.map((it, i) => {
        // 逐条看这条明细当时是怎么判的：图片作答的明细没有对应的评分标准条目，
        // 硬套 rubricItems[i] 会张冠李戴，所以按明细自己的 mode 判断。
        const itemAuto = (it.mode || q.gradingMode) === 'auto';
        const criterion = itemAuto
          ? '整题自主评判'
          : (q.rubricType === 'items'
            ? (q.rubricItems[i] ? q.rubricItems[i].text : '第 ' + (i + 1) + ' 项')
            : '整体给分');
        const max = itemAuto
          ? q.points
          : (q.rubricType === 'items'
            ? (q.rubricItems[i] ? q.rubricItems[i].points : q.points)
            : q.points);
        return '<div class="item-row ' + (it.doubt ? 'doubt' : '') + '">' +
          '<div class="item-head"><span>' + ui.esc(criterion) +
          (itemAuto ? ' ' + ui.statusBadge('auto') : '') + '</span>' +
          '<span class="nowrap">' +
          '<input class="score-input" type="number" min="0" step="0.5" data-score="' + it.id + '" value="' + ui.num(it.effectiveScore) + '"' + (locked ? ' disabled' : '') + '>' +
          ' <span class="muted small">/ ' + ui.num(max) + '</span></span></div>' +
          '<div class="item-reason">' + ui.esc(it.aiReason || '（没有理由）') +
          (it.aiConfidence !== null && it.aiConfidence !== undefined
            ? ' <span class="badge">把握 ' + ui.num(it.aiConfidence, 2) + '</span>' : '') +
          (it.doubt ? ' <span class="badge badge-warn">存疑</span>' : '') + '</div>' +
          '<div class="row mt8"><label class="small muted"><input type="checkbox" data-doubt="' + it.id + '"' +
          (it.doubt ? ' checked' : '') + (locked ? ' disabled' : '') + '> 标记存疑</label></div>' +
          '</div>';
      }).join('') +
      '<div class="mt8 right small">本题小计 <b data-q-total>' + ui.num(q.questionTotal) + '</b> / ' + ui.num(q.points) + '</div>' +
      '</div>';
  }

  /* --------------------------- 「图片答案」形态（整卷给分） --------------------------- */

  /**
   * 左栏：整份图片。这组照片就是这名学生的整张答题卡，没有拆到任何题目上。
   */
  function paneWholeImages(whole) {
    const paths = whole && Array.isArray(whole.images) ? whole.images : [];
    const imgs = paths.map((p, i) =>
      '<a href="/files/' + ui.esc(p) + '" target="_blank" rel="noopener" title="第 ' + (i + 1) + ' 张，点开看大图">' +
      '<img class="answer-img" style="max-height:150px;margin:0 6px 6px 0" src="/files/' + ui.esc(p) + '" alt="第 ' +
      (i + 1) + ' 张"></a>').join('');
    return '<div class="pane"><div class="pane-title">学生答案 · 整份图片（' + paths.length + ' 张）</div>' +
      (imgs || '<div class="small muted">（照片找不到了，请让老师重新上传）</div>') +
      '<div class="small muted mt8">这组照片就是这名学生的整张答题卡，没有拆到题上。</div></div>';
  }

  /**
   * 中栏：整卷的依据。整卷不拆题，就不摆逐条评分标准当台面依据，
   * 只把这份卷子的规模和判分方式交代清楚。
   */
  function paneWholeStandard(detail) {
    return '<div class="pane"><div class="pane-title">批改依据 · 整卷</div>' +
      '<div class="small muted">这份答卷是「图片答卷」：整张答题卡的照片整组交上来，没有按题目切分。' +
      '所以不逐条对照评分标准，由 AI 看整组照片按整卷给一个总分，并把做错的题挑出来。' +
      '挑出来的错题在页面下方「图片评判」区块里，可以核对、删改。</div>' +
      '<div class="mt12 small">试卷 <b>' + ui.esc(detail.paper.name) + '</b></div>' +
      '<div class="small">题目 ' + detail.questions.length + ' 道 · 满分 ' + ui.num(detail.fullMarks) + ' 分</div>' +
      '<div class="small">及格线 ' + ui.num(detail.passLine) + ' 分</div>' +
      '<div class="mt12">' + ui.statusBadge('auto') + '<span class="small muted"> 整卷自主评判</span></div>' +
      '<div class="small muted mt8">这份答卷算进平均分和及格率，但不进「每题得分率」——错题清单只是给老师看的线索，不是逐题成绩。</div>' +
      '</div>';
  }

  /** 右栏：整卷那一个总分。整卷只有这一处可改、这一处可标存疑。 */
  function paneWholeAi(detail, locked) {
    const whole = detail.whole;
    const sheet = detail.gradeSheet;
    if (!sheet || sheet.status === 'ungraded') {
      return '<div class="pane ai"><div class="pane-title">AI 整卷评分</div>' +
        '<div class="small muted">还没有批改结果</div></div>';
    }
    const value = whole && whole.effectiveScore !== null && whole.effectiveScore !== undefined
      ? whole.effectiveScore : 0;
    const doubt = Boolean(whole && whole.doubt);
    const aiScore = whole && whole.aiScore !== null && whole.aiScore !== undefined ? whole.aiScore : null;
    const finalScore = whole && whole.finalScore !== null && whole.finalScore !== undefined ? whole.finalScore : null;
    return '<div class="pane ai"><div class="pane-title">AI 整卷评分（可修改）' + ui.statusBadge('auto') + '</div>' +
      '<div class="small muted">AI 给分 <b>' + (aiScore !== null ? ui.num(aiScore) : '—') + ' 分</b>' +
      (finalScore !== null
        ? ' · 人工改后 <b>' + ui.num(finalScore) + ' 分</b>'
        : ' · 尚未人工改分') + '</div>' +
      '<div class="item-row' + (doubt ? ' doubt' : '') + '">' +
      '<div class="item-head"><span>整卷总分</span>' +
      '<span class="nowrap"><input class="score-input" type="number" min="0" step="0.5" data-whole-score value="' +
      ui.num(value) + '"' + (locked ? ' disabled' : '') + '>' +
      ' <span class="muted small">/ ' + ui.num(detail.fullMarks) + '</span></span></div>' +
      '<div class="item-reason">' + ui.esc((whole && whole.reason) || '（没有理由）') +
      (whole && whole.confidence !== null && whole.confidence !== undefined
        ? ' <span class="badge">把握 ' + ui.num(whole.confidence, 2) + '</span>' : '') +
      (doubt ? ' <span class="badge badge-warn">存疑</span>' : '') + '</div>' +
      '<div class="row mt8"><label class="small muted"><input type="checkbox" data-whole-doubt' +
      (doubt ? ' checked' : '') + (locked ? ' disabled' : '') + '> 标记存疑</label></div>' +
      '</div>' +
      '<div class="mt8 right small">整卷得分 <b data-whole-total>' + ui.num(value) + '</b> / ' +
      ui.num(detail.fullMarks) + '</div>' +
      '</div>';
  }

  /**
   * 「图片评判」独立区块：AI 从整卷照片上读出来的错题 —— 哪一题、错在哪一处、错成了什么。
   * 整卷仍然只有一个总分，这里只报错处（不给每题分数），所以它跟右上角那个总分是两回事。
   * AI 认错了题号，老师可以删掉；也能自己补一条。
   */
  function wrongBlock(detail, locked) {
    const whole = detail.whole || {};
    const list = Array.isArray(whole.wrong) ? whole.wrong : [];
    const sheet = detail.gradeSheet;
    const graded = Boolean(sheet && sheet.status !== 'ungraded');

    const rows = list.map((w, i) =>
      '<div class="item-row">' +
      '<div class="item-head">' +
      '<span>' + (w.no ? '第 ' + ui.esc(w.no) + ' 题' : '<span class="muted">题号看不清</span>') +
      (w.deduct ? ' <b style="color:var(--danger)">− ' + ui.num(w.deduct) + ' 分</b>' : '') +
      (w.where ? ' <span class="small muted">· ' + ui.esc(w.where) + '</span>' : '') + '</span>' +
      (locked ? '' : '<button class="btn btn-sm" data-wrong-del="' + i + '">删掉</button>') +
      '</div>' +
      '<div class="item-reason">' + ui.esc(w.issue || '（没有写清错在哪）') + '</div>' +
      '</div>').join('');

    return '<div class="card" data-wrong-host>' +
      '<div class="card-title-row"><div class="card-title">图片评判 · AI 指出的错题</div>' +
      '<span class="small muted">题号是 AI 从卷面上读出来的；每道错题标了扣分，总分 = 满分 − 扣分之和</span></div>' +
      (graded
        ? (list.length
          ? '<div class="mt8">' + rows + '</div>'
          : '<div class="small muted">AI 没有指出明显的错题。</div>')
        : '<div class="small muted">还没有批改结果，批完再看 AI 挑出了哪些错题。</div>') +
      (graded && !locked
        ? '<div class="row mt12">' +
          '<input type="text" data-wrong-no placeholder="题号，可留空" style="max-width:130px">' +
          '<input type="number" min="0" step="0.5" data-wrong-deduct placeholder="扣分" style="max-width:84px">' +
          '<input class="grow" type="text" data-wrong-issue placeholder="错在哪：哪一步、错成了什么">' +
          '<button class="btn btn-sm" data-wrong-add>补一条</button></div>'
        : '') +
      '</div>';
  }

  /** 首页等地方可以直接点名某份答卷（?sub=），这里换算成它在当前筛选里的序号 */
  function resolveSeq(queue, query) {
    if (query.sub) {
      const hit = queue.items.find((i) => String(i.submissionId) === String(query.sub));
      if (hit) return hit.seq;
    }
    return Number(query.seq || 1);
  }

  async function pollBatch(jobId, onDone) {
    clearPoll();
    pollTimer = setInterval(async () => {
      try {
        const res = await api.get('/api/batch/' + jobId);
        const job = res.job;
        const host = document.querySelector('[data-batch-host]');
        if (host) host.innerHTML = batchBarHtml(job);
        bindBatchButtons(jobId);
        if (job.status === 'done' || job.status === 'paused' || job.status === 'stopped') {
          clearPoll();
          if (job.status === 'done') {
            ui.toast('批量批改完成：成功 ' + (job.done - job.failedCount) + ' 份，失败 ' + job.failedCount + ' 份', 'ok');
            if (onDone) onDone();
          }
        }
      } catch (err) {
        clearPoll();
        ui.toast(err.message, 'error');
      }
    }, 1500);
  }

  function batchBarHtml(job) {
    const percent = job.total ? Math.round((job.done / job.total) * 100) : 0;
    return '<div class="row mb8"><span class="badge badge-accent">' + ui.esc(job.message || '批量批改') + '</span>' +
      '<span class="small muted">' + ui.esc(job.progressText) + '</span>' +
      (job.failedCount ? '<span class="badge badge-danger">失败 ' + job.failedCount + '</span>' : '') +
      '<div class="spacer"></div>' +
      (job.status === 'running' ? '<button class="btn btn-sm" data-batch="pause">暂停</button>' : '') +
      (job.status === 'paused' ? '<button class="btn btn-sm" data-batch="resume">继续</button>' : '') +
      (job.failedCount ? '<button class="btn btn-sm" data-batch="retry">重试失败的</button>' : '') +
      '</div>' +
      '<div class="progress"><i style="width:' + percent + '%"></i></div>';
  }

  function bindBatchButtons(jobId) {
    document.querySelectorAll('[data-batch]').forEach((b) => {
      b.addEventListener('click', async () => {
        const act = b.getAttribute('data-batch');
        try {
          await api.post('/api/batch/' + jobId + '/' + act, {});
          ui.toast(act === 'pause' ? '已暂停' : (act === 'resume' ? '已继续' : '正在重试'), 'ok');
          if (act === 'resume' || act === 'retry') {
            pollBatch(jobId, () => App.refresh());
          } else if (act === 'pause') {
            clearPoll();
            await App.refresh();
          }
        } catch (err) {
          ui.toast(err.message, 'error');
        }
      });
    });
  }

  App.register('grading', {
    async render(root, query) {
      clearPoll();
      if (!query.paper) {
        let papers;
        try {
          papers = (await api.get('/api/papers')).papers.filter((p) => p.status !== 'draft');
        } catch (err) {
          root.innerHTML = ui.pageHead('批改') + '<div class="card">' + ui.esc(err.message) + '</div>';
          return;
        }
        root.innerHTML = ui.pageHead('批改', '先选一份试卷') + '<div class="card">' +
          (papers.length
            ? '<table class="data"><thead><tr><th>试卷</th><th>状态</th><th class="num">已收</th><th class="num">待批改</th><th class="num">待确认</th><th class="right">操作</th></tr></thead><tbody>' +
              papers.map((p) => '<tr><td>' + ui.esc(p.name) + '</td><td>' + ui.statusBadge(p.status) + '</td>' +
                '<td class="num">' + p.progress.submissionCount + '</td>' +
                '<td class="num">' + p.progress.ungraded + '</td>' +
                '<td class="num">' + p.progress.toConfirm + '</td>' +
                '<td class="right"><button class="btn btn-sm btn-primary" data-pick="' + p.id + '">去批改</button></td></tr>').join('') +
              '</tbody></table>'
            : ui.emptyState('还没有可批改的试卷', '先去「试卷」页组卷发布，并在「提交」页收答案')) +
          '</div>';
        root.querySelectorAll('[data-pick]').forEach((b) => b.addEventListener('click', () => {
          App.navigate('grading', { paper: b.getAttribute('data-pick') });
        }));
        return;
      }

      const filter = FILTER_LABEL[query.filter] ? query.filter : 'all';
      let queue;
      try {
        queue = await api.get('/api/papers/' + query.paper + '/queue?filter=' + filter);
      } catch (err) {
        root.innerHTML = ui.pageHead('批改') + '<div class="card">' + ui.esc(err.message) + '</div>';
        return;
      }

      const seq = Math.max(1, Math.min(resolveSeq(queue, query), Math.max(queue.total, 1)));

      let detailRes = null;
      if (queue.total > 0) {
        try {
          detailRes = await api.get('/api/papers/' + query.paper + '/queue/' + seq + '?filter=' + filter);
        } catch (err) {
          ui.toast(err.message, 'error');
        }
      }

      const head =
        ui.pageHead('批改', detailRes && detailRes.detail
          ? detailRes.detail.paper.name + ' · ' + ui.esc(detailRes.detail.student.name)
          : '共 ' + queue.total + ' 份',
          '<button class="btn btn-sm" data-act="switch">换试卷</button>' +
          '<button class="btn btn-sm btn-primary" data-act="batch">一键批量批改</button>' +
          '<button class="btn btn-sm" data-act="del" style="color:var(--danger)">删除试卷</button>') +
        '<div class="card" style="padding:12px 18px">' +
        '<div class="tabs">' +
        Object.keys(FILTER_LABEL).map((f) =>
          '<button data-filter="' + f + '" class="' + (filter === f ? 'active' : '') + '">' +
          FILTER_LABEL[f] + '（' + (f === 'all' ? queue.counts.all
            : (f === 'pending' ? queue.counts.pending
              : (f === 'to_confirm' ? queue.counts.toConfirm : queue.counts.doubt))) + '）</button>').join('') +
        '</div>' +
        '<div class="mt16" data-batch-host><div class="small muted">批量批改会依次处理本卷所有已交、未确认的答卷。</div></div>' +
        '</div>';

      if (queue.total === 0) {
        root.innerHTML = head + '<div class="card">' + ui.emptyState('这个筛选下没有答卷', '换个筛选条件看看') + '</div>';
        bindHead();
        return;
      }

      const entry = detailRes.entry;
      const detail = detailRes.detail;
      const qi = Math.max(0, Math.min(Number(query.qi || 0), detail ? detail.questions.length - 1 : 0));
      const question = detail ? detail.questions[qi] : null;
      const locked = detail && detail.gradeSheet && detail.gradeSheet.status === 'confirmed';
      // 「图片答案」形态：整份照片作答、不拆题，整卷只有一个总分
      const isWhole = Boolean(detail && detail.kind === 'whole');

      // 底部那条总分/批注/确认条，两种形态共用（总分取的就是老师看到的那个总分）
      const stickyBar = detail
        ? '<div class="sticky-bar">' +
          '<div><span class="muted small">总分</span> <b style="font-size:20px" data-total>' +
          ui.num(detail.gradeSheet ? detail.gradeSheet.effectiveTotal : 0) + '</b> <span class="muted small">/ ' +
          ui.num(detail.fullMarks) + '</span>' +
          '<span class="small muted">（及格线 ' + ui.num(detail.passLine) + '）</span></div>' +
          '<input type="text" class="grow" data-f="comment" placeholder="写一句给学生的批注（可选）" value="' +
          ui.esc(detail.gradeSheet ? detail.gradeSheet.comment : '') + '"' + (locked ? ' disabled' : '') + '>' +
          (locked
            ? '<button class="btn" data-act="unlock">解锁重批</button>' +
              '<span class="badge badge-ok">已确认锁定</span>'
            : '<button class="btn" data-act="comment">保存批注</button>' +
              (detail.gradeSheet && detail.gradeSheet.status === 'ai_done'
                ? '<button class="btn btn-primary" data-act="confirm">确认并锁定</button>'
                : '<button class="btn btn-primary" data-act="grade">开始 AI 批改</button>')) +
          '</div>'
        : '';

      root.innerHTML = head +
        '<div class="card" style="padding:10px 18px">' +
        '<div class="row">' +
        '<button class="btn btn-sm" data-nav="prev"' + (seq <= 1 ? ' disabled' : '') + '>← 上一份</button>' +
        '<button class="btn btn-sm" data-nav="next"' + (seq >= queue.total ? ' disabled' : '') + '>下一份 →</button>' +
        '<span class="small muted">第 ' + seq + ' / ' + queue.total + ' 份</span>' +
        '<span class="badge">' + ui.esc(entry.studentName) + (entry.className ? ' · ' + ui.esc(entry.className) : '') + '</span>' +
        (entry.gradeStatus ? ui.statusBadge(entry.gradeStatus) : '<span class="badge">未批改</span>') +
        (entry.submissionStatus === 'absent' ? ui.statusBadge('absent') : '') +
        (isWhole ? '<span class="badge badge-accent">图片答卷 · 整卷给分</span>' : '') +
        '<div class="spacer"></div>' +
        '<span class="small muted">快捷键 ' + '<span class="kbd">←</span> <span class="kbd">→</span></span>' +
        '</div></div>' +
        (detail && !isWhole
          ? '<div class="card" style="padding:10px 18px"><div class="tabs">' +
            detail.questions.map((q, i) =>
              '<button data-qi="' + i + '" class="' + (i === qi ? 'active' : '') + '"' +
              (q.gradingMode === 'auto' ? ' title="学生交的是照片，AI 自主评判"' : '') + '>第 ' + q.seq + ' 题' +
              (q.gradingMode === 'auto'
                ? '<span class="small" style="color:var(--accent);margin-left:5px">自主</span>' : '') +
              '</button>').join('') +
            '</div></div>'
          : '') +
        (detail
          ? '<div class="cols-3">' +
            (isWhole
              ? paneWholeImages(detail.whole) + paneWholeStandard(detail) + paneWholeAi(detail, locked)
              : paneStudent(question) + paneStandard(question) + paneAi(question, locked)) +
            '</div>' +
            // 「图片评判」单独一个区块，摆在三栏下方：图片答卷才有
            (isWhole ? wrongBlock(detail, locked) : '') + stickyBar
          : '<div class="card">' +
            ui.emptyState('这份答卷还没有批改结果', '点下面的按钮让 AI 逐题给分') +
            '<div class="right"><button class="btn btn-primary" data-act="grade">开始 AI 批改</button></div>' +
            '</div>');

      bindHead();
      bindBody();

      function bindHead() {
        root.querySelector('[data-act="switch"]').addEventListener('click', () => App.navigate('grading'));
        root.querySelector('[data-act="del"]').addEventListener('click', async () => {
          try {
            // 先拿到这份卷子的代价（几份答卷、几道题），摆出来再让老师确认
            const info = await api.get('/api/papers/' + query.paper);
            const paper = info.paper;
            const g = paper.progress || {};
            const lines = ['确定删除「' + paper.name + '」吗？', ''];
            if (g.submissionCount) {
              lines.push('这份试卷下现有 ' + g.submissionCount + ' 份答卷' +
                (g.graded ? '（其中已批改 ' + g.graded + ' 份）' : '') + '，删除后：');
              lines.push('· 这些答卷、每题作答、AI 评分与批注全部删除');
            } else {
              lines.push('这份试卷还没有收上来的答卷。');
            }
            if (g.questionCount) lines.push('· 试卷上的 ' + g.questionCount + ' 道题编排一并清除（评分标准本身保留）');
            lines.push('', '删除后不可撤销。');
            const yes = await ui.confirmDialog('删除试卷', lines.join('\n'), '删除');
            if (!yes) return;
            const res = await api.del('/api/papers/' + query.paper);
            const detail = res && res.removed ? ui.describeRemoved(res.removed) : '';
            ui.toast('已删除' + (detail ? '，同时清掉 ' + detail : ''), 'ok');
            App.navigate('grading');
          } catch (err) { ui.toast(err.message, 'error'); }
        });
        root.querySelector('[data-act="batch"]').addEventListener('click', async () => {
          try {
            const res = await api.post('/api/papers/' + query.paper + '/grade-batch', {});
            ui.toast('已开始批量批改', 'ok');
            const host = root.querySelector('[data-batch-host]');
            host.innerHTML = batchBarHtml(res.job);
            bindBatchButtons(res.job.id);
            pollBatch(res.job.id, () => App.refresh());
          } catch (err) {
            ui.toast(err.message, 'error');
          }
        });
        root.querySelectorAll('[data-filter]').forEach((b) => b.addEventListener('click', () => {
          App.navigate('grading', { paper: query.paper, filter: b.getAttribute('data-filter'), seq: 1 });
        }));
      }

      function bindBody() {
        root.querySelectorAll('[data-nav]').forEach((b) => b.addEventListener('click', () => {
          const dir = b.getAttribute('data-nav') === 'prev' ? -1 : 1;
          App.navigate('grading', { paper: query.paper, filter, seq: seq + dir, qi: 0 });
        }));
        root.querySelectorAll('[data-qi]').forEach((b) => b.addEventListener('click', () => {
          App.navigate('grading', { paper: query.paper, filter, seq, qi: b.getAttribute('data-qi') });
        }));

        root.querySelectorAll('[data-score]').forEach((input) => input.addEventListener('change', async () => {
          try {
            const res = await api.put('/api/grade-items/' + input.getAttribute('data-score'), {
              finalScore: input.value === '' ? null : Number(input.value),
            });
            const totalEl = root.querySelector('[data-total]');
            if (totalEl) totalEl.textContent = ui.num(res.effectiveTotal);
            ui.toast('已保存', 'ok');
          } catch (err) {
            ui.toast(err.message, 'error');
          }
        }));

        root.querySelectorAll('[data-doubt]').forEach((box) => box.addEventListener('change', async () => {
          try {
            await api.put('/api/grade-items/' + box.getAttribute('data-doubt'), { doubt: box.checked });
            await App.refresh();
          } catch (err) {
            ui.toast(err.message, 'error');
          }
        }));

        // 「图片答案」形态：整卷只有一个总分、一处存疑，改的是 grade_sheets 上的整卷分
        const wholeScore = root.querySelector('[data-whole-score]');
        if (wholeScore) wholeScore.addEventListener('change', async () => {
          try {
            const res = await api.put('/api/grade-sheets/' + detail.gradeSheet.id + '/whole', {
              finalScore: wholeScore.value === '' ? null : Number(wholeScore.value),
            });
            const totalEl = root.querySelector('[data-total]');
            if (totalEl) totalEl.textContent = ui.num(res.effectiveTotal);
            const wholeTotalEl = root.querySelector('[data-whole-total]');
            if (wholeTotalEl) wholeTotalEl.textContent = ui.num(res.effectiveTotal);
            ui.toast('已保存', 'ok');
          } catch (err) {
            ui.toast(err.message, 'error');
          }
        });

        const wholeDoubt = root.querySelector('[data-whole-doubt]');
        if (wholeDoubt) wholeDoubt.addEventListener('change', async () => {
          try {
            await api.put('/api/grade-sheets/' + detail.gradeSheet.id + '/whole', { doubt: wholeDoubt.checked });
            await App.refresh();
          } catch (err) {
            ui.toast(err.message, 'error');
          }
        });

        // 图片评判区块：错题清单整份覆盖式保存（删掉一条 / 补一条）
        const sendWrong = async (next) => {
          try {
            const res = await api.put('/api/grade-sheets/' + detail.gradeSheet.id + '/whole', { wrong: next });
            // 存回来的就是权威清单，就地更新，免得连点两次用的是过期的旧清单
            if (detail.whole) detail.whole.wrong = res.wrong;
            ui.toast('已保存，现在有 ' + res.wrongCount + ' 条错题', 'ok');
            await App.refresh();
          } catch (err) {
            ui.toast(err.message, 'error');
          }
        };

        root.querySelectorAll('[data-wrong-del]').forEach((b) => b.addEventListener('click', async () => {
          const idx = Number(b.getAttribute('data-wrong-del'));
          const list = (detail.whole && Array.isArray(detail.whole.wrong)) ? detail.whole.wrong : [];
          await sendWrong(list.filter((_, i) => i !== idx));
        }));

        const addBtn = root.querySelector('[data-wrong-add]');
        if (addBtn) addBtn.addEventListener('click', async () => {
          const no = root.querySelector('[data-wrong-no]').value.trim();
          const issue = root.querySelector('[data-wrong-issue]').value.trim();
          const deductEl = root.querySelector('[data-wrong-deduct]');
          const deduct = deductEl && deductEl.value !== '' ? Number(deductEl.value) : 0;
          if (!issue) { ui.toast('请写下错在哪', 'error'); return; }
          const list = (detail.whole && Array.isArray(detail.whole.wrong)) ? detail.whole.wrong : [];
          // 补一条带扣分：总分会按「满分 − 各错题扣分之和」自动重算
          await sendWrong(list.concat([{ no, where: '', issue, deduct: Number.isFinite(deduct) ? deduct : 0 }]));
        });

        const gradeBtn = root.querySelector('[data-act="grade"]');
        if (gradeBtn) gradeBtn.addEventListener('click', async () => {
          gradeBtn.disabled = true;
          gradeBtn.textContent = '正在批改…';
          try {
            await api.post('/api/submissions/' + entry.submissionId + '/grade', {});
            ui.toast('批改完成', 'ok');
            await App.refresh();
          } catch (err) {
            ui.toast(err.message, 'error');
            gradeBtn.disabled = false;
            gradeBtn.textContent = '开始 AI 批改';
          }
        });

        const commentBtn = root.querySelector('[data-act="comment"]');
        if (commentBtn) commentBtn.addEventListener('click', async () => {
          try {
            await api.put('/api/grade-sheets/' + detail.gradeSheet.id, {
              comment: root.querySelector('[data-f="comment"]').value,
            });
            ui.toast('批注已保存', 'ok');
          } catch (err) {
            ui.toast(err.message, 'error');
          }
        });

        const confirmBtn = root.querySelector('[data-act="confirm"]');
        if (confirmBtn) confirmBtn.addEventListener('click', async () => {
          try {
            await api.put('/api/grade-sheets/' + detail.gradeSheet.id, {
              comment: root.querySelector('[data-f="comment"]').value,
            });
            const res = await api.post('/api/grade-sheets/' + detail.gradeSheet.id + '/confirm', {});
            ui.toast('已确认锁定，得分 ' + ui.num(res.finalTotal), 'ok');
            const next = seq < queue.total ? seq + 1 : seq;
            App.navigate('grading', { paper: query.paper, filter, seq: next, qi: 0 });
          } catch (err) {
            ui.toast(err.message, 'error');
          }
        });

        const unlockBtn = root.querySelector('[data-act="unlock"]');
        if (unlockBtn) unlockBtn.addEventListener('click', async () => {
          const yes = await ui.confirmDialog('解锁重批', '解锁后这份答卷会回到「待确认」状态，可重新改分。是否继续？', '解锁');
          if (!yes) return;
          try {
            await api.post('/api/grade-sheets/' + detail.gradeSheet.id + '/unlock', {});
            ui.toast('已解锁', 'ok');
            await App.refresh();
          } catch (err) {
            ui.toast(err.message, 'error');
          }
        });
      }
    },

    onKey(e) {
      if (e.target && /INPUT|TEXTAREA|SELECT/.test(e.target.tagName)) return;
      const cur = App.current();
      if (cur.id !== 'grading' || !cur.query.paper) return;
      if (e.key === 'ArrowLeft') {
        App.navigate('grading', { ...cur.query, seq: Math.max(1, Number(cur.query.seq || 1) - 1), qi: 0 });
      } else if (e.key === 'ArrowRight') {
        App.navigate('grading', { ...cur.query, seq: Number(cur.query.seq || 1) + 1, qi: 0 });
      }
    },
  });
})();
