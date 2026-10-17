(function () {
  'use strict';

  /** ISO 时间转成「MM-DD HH:mm」这种短格式，列表里显示上传时间用 */
  function fmtTime(iso) {
    if (!iso) return '';
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return '';
    const p = (n) => String(n).padStart(2, '0');
    return (d.getMonth() + 1) + '-' + p(d.getDate()) + ' ' + p(d.getHours()) + ':' + p(d.getMinutes());
  }

  /** 挑题目时给一行评分标准摘要，方便老师一眼分辨该挑哪条 */
  function rubricSummary(q) {
    if (q.rubricType === 'items' && q.items && q.items.length) {
      return q.items.length + ' 个得分点：' + q.items.map((it) => it.text).join('、').slice(0, 46) +
        (q.items.map((it) => it.text).join('、').length > 46 ? '…' : '');
    }
    const text = q.rubricText || '';
    if (!text) return '未填评分标准';
    return ui.esc(text.slice(0, 46)) + (text.length > 46 ? '…' : '');
  }

  async function renderList(root) {
    let data;
    try {
      data = await api.get('/api/papers');
    } catch (err) {
      root.innerHTML = ui.pageHead('试卷') + '<div class="card">' + ui.esc(err.message) + '</div>';
      return;
    }
    const papers = data.papers;

    root.innerHTML =
      ui.pageHead('试卷', '共 ' + papers.length + ' 份试卷',
        '<button class="btn btn-sm btn-primary" data-act="new">新建试卷</button>') +
      '<div class="card">' +
      (papers.length
        ? '<table class="data"><thead><tr><th>试卷</th><th>状态</th><th class="num">题目</th><th class="num">总分</th>' +
          '<th style="width:180px">批改进度</th><th class="num">已交</th><th class="right">操作</th></tr></thead><tbody>' +
          papers.map((p) => {
            const g = p.progress;
            return '<tr><td><div class="clickable" data-act="edit" data-id="' + p.id + '">' + ui.esc(p.name) + '</div>' +
              '<div class="small muted">及格线 ' + ui.num(g.passLine) + ' 分' +
              (g.questionCount === 0 ? ' · 还没挑题目，只收图片答卷' : '') +
              ' · ' + fmtTime(p.createdAt) + '</div></td>' +
              '<td>' + ui.statusBadge(p.status) + '</td>' +
              '<td class="num">' + g.questionCount + '</td>' +
              '<td class="num">' + ui.num(g.total) + '</td>' +
              '<td><div class="progress ' + (g.progressPercent >= 100 ? 'ok' : '') + '"><i style="width:' + g.progressPercent + '%"></i></div>' +
              '<div class="small muted mt8">已批 ' + g.graded + ' / 应缴 ' + g.studentCount + ' 人' +
              (g.toConfirm ? ' · 待确认 ' + g.toConfirm : '') +
              (g.doubt ? ' · 存疑 ' + g.doubt : '') + '</div></td>' +
              '<td class="num">' + g.submissionCount + (g.absentCount ? '（缺考 ' + g.absentCount + '）' : '') + '</td>' +
              '<td class="right nowrap">' +
              '<button class="btn-link" data-act="edit" data-id="' + p.id + '">组卷</button>' +
              (p.status === 'draft'
                ? '<button class="btn-link" data-act="publish" data-id="' + p.id + '">发布</button>'
                : '') +
              (p.status === 'open' || p.status === 'collecting'
                ? '<button class="btn-link" data-act="withdraw" data-id="' + p.id + '">撤回</button>' : '') +
              (p.status === 'draft' ? '' : '<button class="btn-link" data-act="submit" data-id="' + p.id + '">收答案</button>') +
              (p.status === 'draft' ? '' : '<button class="btn-link" data-act="grade" data-id="' + p.id + '">去批改</button>') +
              (p.status === 'grading' || p.status === 'collecting' || p.status === 'open'
                ? '<button class="btn-link" data-act="complete" data-id="' + p.id + '">标记完成</button>' : '') +
              '<button class="btn-link" data-act="del" data-id="' + p.id + '" style="color:var(--danger)">删除</button>' +
              '</td></tr>';
          }).join('') +
          '</tbody></table>'
        : ui.emptyState('还没有试卷', '点右上角「新建试卷」，把这份卷子的题目挑进来；只收图片答卷的话，也可以一道题都不挑')) +
      '</div>';

    root.querySelectorAll('[data-act]').forEach((el) => {
      const act = el.getAttribute('data-act');
      el.addEventListener('click', async () => {
        const id = el.getAttribute('data-id');
        const paper = papers.find((p) => String(p.id) === String(id));
        try {
          if (act === 'new') {
            App.navigate('papers', { new: 1 });
          } else if (act === 'edit') {
            App.navigate('papers', { edit: id });
          } else if (act === 'publish') {
            await api.post('/api/papers/' + id + '/publish', {});
            ui.toast('已发布，学生可以作答了', 'ok');
            await App.refresh();
          } else if (act === 'withdraw') {
            await api.post('/api/papers/' + id + '/withdraw', {});
            ui.toast('已撤回为草稿', 'ok');
            await App.refresh();
          } else if (act === 'complete') {
            await api.post('/api/papers/' + id + '/complete', {});
            ui.toast('已标记完成', 'ok');
            await App.refresh();
          } else if (act === 'submit') {
            App.navigate('submissions', { paper: id });
          } else if (act === 'grade') {
            App.navigate('grading', { paper: id });
          } else if (act === 'del') {
            // 删一份试卷牵一发动全身：题目的编排、收上来的答卷、AI 评分都会跟着走，
            // 所以把代价先摆出来再确认。
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
            const res = await api.del('/api/papers/' + id);
            const detail = res && res.removed ? ui.describeRemoved(res.removed) : '';
            ui.toast('已删除' + (detail ? '，同时清掉 ' + detail : ''), 'ok');
            await App.refresh();
          }
        } catch (err) {
          ui.toast(err.message, 'error');
        }
      });
    });
  }

  async function renderEditor(root, query) {
    let paper = null;
    let picked = [];
    let locked = false;

    if (query.edit) {
      try {
        const detail = await api.get('/api/papers/' + query.edit);
        paper = detail.paper;
        locked = paper.status !== 'draft';
        picked = detail.questions.map((q) => ({
          questionId: q.questionId,
          stem: q.stem,
          points: q.points,
          override: q.pointsOverridden ? q.points : '',
          rubricItems: q.rubricItems || [],
        }));
      } catch (err) {
        ui.toast(err.message, 'error');
        App.navigate('papers');
        return;
      }
    }

    let pool = [];
    try {
      pool = (await api.get('/api/questions')).questions;
    } catch (err) {
      ui.toast(err.message, 'error');
    }

    function total() {
      return picked.reduce((s, p) => s + (Number(p.override) || Number(p.points) || 0), 0);
    }

    /** 这份卷子的整卷满分：老师填的整卷满分优先；没填才有题目按题目之和、没题目按 100 */
    function servedFullMarks() {
      const el = root.querySelector('[data-f="wholeFullMarks"]');
      const own = el ? Number(el.value) : NaN;
      if (Number.isFinite(own) && own > 0) return own;
      const sum = total();
      if (sum > 0) return sum;
      return (paper && paper.wholeFullMarks) || 100;
    }

    /** 总分那一格跟着题目与整卷满分走 */
    function paintTotal() {
      const el = root.querySelector('[data-f="wholeFullMarks"]');
      const own = el ? Number(el.value) : NaN;
      const hasOwn = Number.isFinite(own) && own > 0;
      root.querySelector('[data-total]').textContent = ui.num(servedFullMarks());
      const note = root.querySelector('[data-total-note]');
      if (note) {
        note.textContent = hasOwn
          ? (picked.length ? '（保存时 AI 会把它分到每题、再平均到小题）' : '（还没有题目，图片答卷按它整卷给分）')
          : (picked.length ? '（没设整卷总分，按各题分值之和）' : '（还没挑题目、也没设总分，按 100）');
      }
    }

    function pickedHtml() {
      if (!picked.length) return ui.emptyState('还没选题目', '从下面「挑题目」里点「加入」');
      return '<table class="data"><thead><tr><th style="width:36px">#</th><th>题干</th><th class="num">分值</th><th class="right">操作</th></tr></thead><tbody>' +
        picked.map((p, i) =>
          '<tr><td>' + (i + 1) + '</td>' +
          '<td>' + ui.esc(p.stem.slice(0, 70)) + (p.stem.length > 70 ? '…' : '') +
          (p.rubricItems && p.rubricItems.length
            ? '<div class="small muted">得分点各 ' + p.rubricItems.map((it) => ui.num(it.points)).join(' / ') + ' 分</div>'
            : '') + '</td>' +
          '<td class="num"><input type="number" min="0" step="0.5" style="width:82px;text-align:right" data-pick-points="' + i + '" value="' + (p.override === '' ? p.points : p.override) + '"></td>' +
          '<td class="right nowrap">' +
          '<button class="btn-link" data-move="' + i + '" data-dir="-1"' + (i === 0 ? ' disabled' : '') + '>↑</button>' +
          '<button class="btn-link" data-move="' + i + '" data-dir="1"' + (i === picked.length - 1 ? ' disabled' : '') + '>↓</button>' +
          '<button class="btn-link" data-remove="' + i + '" style="color:var(--danger)">移除</button>' +
          '</td></tr>'
        ).join('') + '</tbody></table>';
    }

    function poolHtml() {
      const chosen = new Set(picked.map((p) => p.questionId));
      const rest = pool.filter((q) => !chosen.has(q.id));
      if (!rest.length) return ui.emptyState(
        pool.length ? '能挑的题都挑完了' : '还没有评分标准',
        pool.length ? '这份卷子的题目已经齐了，直接保存' : '先去「评分标准」页把题干和评分标准录进来');
      return '<table class="data"><thead><tr><th>题干</th><th>评分标准</th><th class="num">满分</th><th class="right">操作</th></tr></thead><tbody>' +
        rest.map((q) =>
          '<tr><td>' + ui.esc(q.stem.slice(0, 70)) + (q.stem.length > 70 ? '…' : '') + '</td>' +
          '<td class="small muted">' + rubricSummary(q) + '</td>' +
          '<td class="num">' + ui.num(q.points) + '</td>' +
          '<td class="right"><button class="btn btn-sm" data-add="' + q.id + '">加入</button></td></tr>'
        ).join('') + '</tbody></table>';
    }

    root.innerHTML =
      ui.pageHead(paper ? '试卷组卷 · ' + paper.name : '新建试卷', '',
        '<button class="btn btn-sm" data-act="cancel">返回列表</button>' +
        (paper && !locked ? '<button class="btn btn-sm" data-act="allocate">让 AI 分配分值</button>' : '') +
        (locked ? '' : '<button class="btn btn-sm btn-primary" data-act="save">保存</button>')) +
      (locked
        ? '<div class="card"><span class="badge badge-warn">已发布</span> 试卷题目已锁定，如需修改请先撤回为草稿。</div>'
        : '') +
      '<div class="card">' +
      '<div class="row">' +
      '<label class="field grow" style="margin-bottom:0"><span>试卷名称 *</span>' +
      '<input type="text" data-f="name" value="' + ui.esc(paper ? paper.name : '') + '" placeholder="例如：高一物理 · 第一次月考"' + (locked ? ' disabled' : '') + '></label>' +
      '<label class="field" style="width:160px;margin-bottom:0"><span>及格线（留空按总分 60%）</span>' +
      '<input type="number" min="0" step="0.5" data-f="passLine" value="' + ui.esc(paper && paper.passLine ? paper.passLine : '') + '"' + (locked ? ' disabled' : '') + '></label>' +
      '<label class="field" style="width:170px;margin-bottom:0"><span>整卷总分</span>' +
      '<input type="number" min="1" step="1" data-f="wholeFullMarks" value="' +
      ui.esc(paper && paper.wholeFullMarks ? paper.wholeFullMarks : 100) + '"' + (locked ? ' disabled' : '') + '></label>' +
      '<div><span class="small muted">这份卷子的满分</span><div style="font-size:20px;font-weight:600" data-total>' + ui.num(servedFullMarks()) + '</div>' +
      '<div class="small muted" data-total-note>' + (total() > 0 ? '（各题分值之和）' : '（还没挑题目，按整卷满分算）') + '</div></div>' +
      '</div></div>' +
      '<div class="card"><div class="card-title-row"><div class="card-title" style="margin:0">已选题目</div></div><div data-picked>' + pickedHtml() + '</div></div>' +
      (locked ? '' : '<div class="card"><div class="card-title-row"><div class="card-title" style="margin:0">挑题目</div>' +
        '<input type="search" style="width:220px" data-pool-search placeholder="搜索题干"></div><div data-pool>' + poolHtml() + '</div></div>');

    const refreshPicked = () => {
      root.querySelector('[data-picked]').innerHTML = pickedHtml();
      paintTotal();
      const poolHost = root.querySelector('[data-pool]');
      if (poolHost) poolHost.innerHTML = poolHtml();
      bindDynamic();
    };

    function bindDynamic() {
      const host = root.querySelector('[data-picked]');
      host.querySelectorAll('[data-remove]').forEach((b) => b.addEventListener('click', () => {
        picked.splice(Number(b.getAttribute('data-remove')), 1);
        refreshPicked();
      }));
      host.querySelectorAll('[data-move]').forEach((b) => b.addEventListener('click', () => {
        const i = Number(b.getAttribute('data-move'));
        const dir = Number(b.getAttribute('data-dir'));
        const j = i + dir;
        if (j < 0 || j >= picked.length) return;
        const tmp = picked[i];
        picked[i] = picked[j];
        picked[j] = tmp;
        refreshPicked();
      }));
      host.querySelectorAll('[data-pick-points]').forEach((inp) => inp.addEventListener('input', () => {
        const i = Number(inp.getAttribute('data-pick-points'));
        picked[i].override = inp.value === '' ? '' : Number(inp.value);
        paintTotal();
      }));
      const poolHost = root.querySelector('[data-pool]');
      if (poolHost) {
        poolHost.querySelectorAll('[data-add]').forEach((b) => b.addEventListener('click', () => {
          const qid = Number(b.getAttribute('data-add'));
          const q = pool.find((x) => x.id === qid);
          picked.push({ questionId: qid, stem: q.stem, points: q.points, override: '', rubricItems: [] });
          refreshPicked();
        }));
      }
    }

    const searchInput = root.querySelector('[data-pool-search]');
    if (searchInput) {
      let timer = null;
      searchInput.addEventListener('input', () => {
        clearTimeout(timer);
        timer = setTimeout(async () => {
          try {
            const kw = searchInput.value.trim();
            pool = (await api.get('/api/questions' + (kw ? '?q=' + encodeURIComponent(kw) : ''))).questions;
            const poolHost = root.querySelector('[data-pool]');
            poolHost.innerHTML = poolHtml();
            bindDynamic();
          } catch (err) {
            ui.toast(err.message, 'error');
          }
        }, 250);
      });
    }

    // 没挑题目时，这份卷子的满分就靠这个输入框（有题目了它就不生效，总分按题目之和）
    const wholeMarksEl = root.querySelector('[data-f="wholeFullMarks"]');
    if (wholeMarksEl) wholeMarksEl.addEventListener('input', paintTotal);

    root.querySelector('[data-act="cancel"]').addEventListener('click', () => App.navigate('papers'));
    const allocBtn = root.querySelector('[data-act="allocate"]');
    if (allocBtn) {
      allocBtn.addEventListener('click', async () => {
        if (!picked.length) { ui.toast('先挑几道题再分配', 'error'); return; }
        const nameEl = root.querySelector('[data-f="name"]');
        const passEl = root.querySelector('[data-f="passLine"]');
        const marksEl = root.querySelector('[data-f="wholeFullMarks"]');
        const passLineVal = passEl.value === '' ? 0 : Number(passEl.value);
        const marksVal = marksEl && marksEl.value !== '' ? Number(marksEl.value) : null;
        try {
          // 先把老师刚填的整卷总分落库，再让 AI 按它分配
          await api.put('/api/papers/' + paper.id, {
            name: nameEl.value.trim(), passLine: passLineVal, wholeFullMarks: marksVal,
          });
          const res = await api.post('/api/papers/' + paper.id + '/allocate', {});
          ui.toast('已按 ' + ui.num(res.fullMarks) + ' 分分到 ' + res.questions.length + ' 道大题', 'ok');
          App.navigate('papers', { edit: String(paper.id) });
        } catch (err) { ui.toast(err.message, 'error'); }
      });
    }
    const saveBtn = root.querySelector('[data-act="save"]');
    if (saveBtn) {
      saveBtn.addEventListener('click', async () => {
        const nameEl = root.querySelector('[data-f="name"]');
        const passEl = root.querySelector('[data-f="passLine"]');
        const marksEl = root.querySelector('[data-f="wholeFullMarks"]');
        const name = nameEl.value.trim();
        const passLineVal = passEl.value === '' ? 0 : Number(passEl.value);
        const marksVal = marksEl && marksEl.value !== '' ? Number(marksEl.value) : null;
        try {
          let pid = paper ? paper.id : null;
          if (!pid) {
            const created = await api.post('/api/papers', {
              name, passLine: passLineVal, wholeFullMarks: marksVal,
            });
            pid = created.paper.id;
          } else {
            await api.put('/api/papers/' + pid, {
              name, passLine: passLineVal, wholeFullMarks: marksVal,
            });
          }
          await api.put('/api/papers/' + pid + '/questions', {
            questions: picked.map((p) => ({
              questionId: p.questionId,
              points: p.override === '' ? null : p.override,
            })),
          });
          ui.toast('已保存', 'ok');
          App.navigate('papers');
        } catch (err) {
          ui.toast(err.message, 'error');
        }
      });
    }
    bindDynamic();
  }

  App.register('papers', {
    async render(root, query) {
      if (query.new || query.edit) {
        await renderEditor(root, query);
      } else {
        await renderList(root);
      }
    },
  });
})();
