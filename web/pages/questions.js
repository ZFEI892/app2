(function () {
  'use strict';

  /**
   * 「评分标准」页。
   * 这一页不是出题用的，而是给 AI 批改提供依据：题干说明这道题在问什么，
   * 参考答案给学生答案一个对照物，评分标准（分项得分点 / 一段文字说明）决定怎么给分。
   * 所以这里只有四件事：题干、参考答案、评分标准、分值；标签、学科、题型这些出题味的东西都不放。
   */

  let keyword = '';

  const PLACEHOLDER_ITEM = [{ text: '', points: '' }];

  function itemRowHtml(item) {
    const it = item || { text: '', points: '' };
    return (
      '<div class="q-item-row" style="display:grid;grid-template-columns:minmax(0,1fr) 92px 34px;gap:8px;align-items:center;margin-bottom:8px">' +
      '<input type="text" data-item-text placeholder="得分点内容，例如：受力分析完整" value="' + ui.esc(it.text) + '">' +
      '<input type="number" data-item-points min="0" step="0.5" placeholder="分值" value="' + ui.esc(it.points) + '">' +
      '<button class="btn btn-sm" data-del-item title="删除这条">×</button>' +
      '</div>'
    );
  }

  function editorHtml(question) {
    const q = question || {
      stem: '', refAnswer: '', rubricType: 'items', rubricText: '', points: '', items: PLACEHOLDER_ITEM,
    };
    const isText = q.rubricType === 'text';
    const items = (q.items && q.items.length ? q.items : PLACEHOLDER_ITEM);
    return (
      ui.pageHead(question ? '编辑评分标准' : '新建评分标准', '题干 + 参考答案 + 评分标准，就是 AI 打分的全部依据',
        '<button class="btn btn-sm" data-act="cancel">返回列表</button>' +
        '<button class="btn btn-sm btn-primary" data-act="save">' + (question ? '保存修改' : '保存') + '</button>'
      ) +
      '<div class="card">' +
        '<label class="field"><span>题干 *</span><textarea data-f="stem" rows="4" placeholder="这道题问的是什么，直接抄题目">' + ui.esc(q.stem) + '</textarea></label>' +
        '<label class="field"><span>参考答案</span><textarea data-f="refAnswer" rows="4" placeholder="标准答案。AI 会拿它和学生的答案对照，留空也能批，但填上更准">' + ui.esc(q.refAnswer) + '</textarea></label>' +
        '<div class="card-title-row"><div class="card-title" style="margin:0">评分标准</div>' +
          '<div class="tabs"><button type="button" data-mode="items" class="' + (isText ? '' : 'active') + '">分项得分点</button>' +
          '<button type="button" data-mode="text" class="' + (isText ? 'active' : '') + '">一段文字说明</button></div>' +
        '</div>' +
        '<div data-pane="items" style="' + (isText ? 'display:none' : '') + '">' +
          '<div data-items>' + items.map(itemRowHtml).join('') + '</div>' +
          '<div class="row mt8"><button class="btn btn-sm" data-add-item>+ 添加得分点</button>' +
          '<div class="spacer"></div><div>总分 <b data-total>' + ui.num(q.points || 0) + '</b> 分</div></div>' +
        '</div>' +
        '<div data-pane="text" style="' + (isText ? '' : 'display:none') + '">' +
          '<label class="field"><span>评分说明 *</span><textarea data-f="rubricText" rows="5" placeholder="例如：能正确选取研究对象并完成受力分析得 6 分；列式正确再得 2 分。">' + ui.esc(q.rubricText) + '</textarea></label>' +
          '<label class="field" style="max-width:200px"><span>满分 *</span><input type="number" data-f="points" min="0" step="0.5" value="' + ui.esc(q.points) + '"></label>' +
        '</div>' +
      '</div>'
    );
  }

  function itemInputs(root) {
    return Array.from(root.querySelectorAll('.q-item-row'));
  }

  function recomputeTotal(root) {
    const total = itemInputs(root).reduce((sum, row) => {
      const v = Number(row.querySelector('[data-item-points]').value);
      return sum + (Number.isFinite(v) ? v : 0);
    }, 0);
    const el = root.querySelector('[data-total]');
    if (el) el.textContent = ui.num(total);
  }

  async function renderEditor(root, query) {
    let question = null;
    if (query.edit) {
      try {
        question = (await api.get('/api/questions/' + query.edit)).question;
      } catch (err) {
        ui.toast(err.message, 'error');
        App.navigate('questions');
        return;
      }
    }
    root.innerHTML = editorHtml(question);

    const itemsHost = root.querySelector('[data-items]');
    root.querySelector('[data-add-item]').addEventListener('click', () => {
      itemsHost.insertAdjacentHTML('beforeend', itemRowHtml(null));
      recomputeTotal(root);
    });
    root.addEventListener('input', (e) => {
      if (e.target.matches('[data-item-points]')) recomputeTotal(root);
    });
    root.addEventListener('click', (e) => {
      const del = e.target.closest('[data-del-item]');
      if (del) {
        const rows = itemInputs(root);
        if (rows.length <= 1) {
          ui.toast('至少保留一条得分点', 'error');
          return;
        }
        del.closest('.q-item-row').remove();
        recomputeTotal(root);
      }
    });
    root.querySelectorAll('[data-mode]').forEach((btn) => {
      btn.addEventListener('click', () => {
        const mode = btn.getAttribute('data-mode');
        root.querySelectorAll('[data-mode]').forEach((b) => b.classList.toggle('active', b === btn));
        root.querySelector('[data-pane="items"]').style.display = mode === 'items' ? '' : 'none';
        root.querySelector('[data-pane="text"]').style.display = mode === 'text' ? '' : 'none';
      });
    });
    root.querySelector('[data-act="cancel"]').addEventListener('click', () => App.navigate('questions'));
    root.querySelector('[data-act="save"]').addEventListener('click', async () => {
      const val = (f) => {
        const el = root.querySelector('[data-f="' + f + '"]');
        return el ? el.value.trim() : '';
      };
      const mode = root.querySelector('[data-mode].active').getAttribute('data-mode');
      // 只提交这一页管得着的字段；学科/知识点/题型/难度不再出现在界面上，
      // 也就不往接口里送，编辑老数据时后端会原样保留。
      const payload = {
        stem: val('stem'),
        refAnswer: val('refAnswer'),
        rubricType: mode,
      };
      if (mode === 'items') {
        payload.items = itemInputs(root).map((row) => ({
          text: row.querySelector('[data-item-text]').value.trim(),
          points: Number(row.querySelector('[data-item-points]').value),
        }));
      } else {
        payload.rubricText = val('rubricText');
        payload.points = Number(val('points'));
      }
      try {
        if (question) {
          await api.put('/api/questions/' + question.id, payload);
          ui.toast('已保存', 'ok');
        } else {
          await api.post('/api/questions', payload);
          ui.toast('已保存', 'ok');
        }
        App.navigate('questions');
      } catch (err) {
        ui.toast(err.message, 'error');
      }
    });
    recomputeTotal(root);
  }

  function rubricCellHtml(q) {
    if (q.rubricType === 'items') {
      return q.items.length + ' 个得分点：' +
        q.items.map((it) => it.text + '(' + ui.num(it.points) + ')').join('、').slice(0, 60);
    }
    const text = q.rubricText || '';
    return ui.esc(text.slice(0, 40)) + (text.length > 40 ? '…' : '');
  }

  async function renderList(root) {
    let data;
    try {
      data = await api.get('/api/questions' + (keyword ? '?q=' + encodeURIComponent(keyword) : ''));
    } catch (err) {
      root.innerHTML = ui.pageHead('评分标准') + '<div class="card">' + ui.esc(err.message) + '</div>';
      return;
    }

    const list = data.questions;
    root.innerHTML =
      ui.pageHead('评分标准', '共 ' + list.length + ' 条' + (keyword ? '（已筛选）' : ''),
        '<button class="btn btn-sm btn-primary" data-act="new">新建评分标准</button>') +
      '<div class="card">' +
      '<div class="row mb12">' +
      '<input type="search" class="grow" data-act="q" placeholder="搜索题干 / 参考答案 / 评分说明" value="' + ui.esc(keyword) + '">' +
      (keyword ? '<button class="btn btn-sm" data-act="clear">清空搜索</button>' : '') +
      '</div>' +
      (list.length
        ? '<table class="data"><thead><tr><th style="width:40%">题干</th><th>评分标准</th><th class="num">满分</th><th class="num">用在几份卷子上</th><th class="right">操作</th></tr></thead><tbody>' +
          list.map((q) =>
            '<tr><td><div class="clickable" data-act="edit" data-id="' + q.id + '">' + ui.esc(q.stem.slice(0, 90)) + (q.stem.length > 90 ? '…' : '') + '</div></td>' +
            '<td class="small muted">' + rubricCellHtml(q) + '</td>' +
            '<td class="num">' + ui.num(q.points) + '</td>' +
            '<td class="num">' + q.usedInPapers + '</td>' +
            '<td class="right nowrap">' +
              '<button class="btn-link" data-act="edit" data-id="' + q.id + '">编辑</button>' +
              '<button class="btn-link" data-act="dup" data-id="' + q.id + '">复制</button>' +
              '<button class="btn-link" data-act="del" data-id="' + q.id + '" style="color:var(--danger)">删除</button>' +
            '</td></tr>'
          ).join('') +
          '</tbody></table>'
        : ui.emptyState(
            keyword ? '没搜到匹配的评分标准' : '还没有评分标准',
            keyword ? '换个关键词试试' : '点右上角「新建评分标准」，把题干和评分标准录进来，AI 才有打分依据')) +
      '</div>';

    let timer = null;
    const qInput = root.querySelector('[data-act="q"]');
    if (qInput) {
      qInput.addEventListener('input', () => {
        clearTimeout(timer);
        timer = setTimeout(() => { keyword = qInput.value.trim(); App.refresh(); }, 250);
      });
    }
    const clearBtn = root.querySelector('[data-act="clear"]');
    if (clearBtn) clearBtn.addEventListener('click', () => { keyword = ''; App.refresh(); });

    const newBtn = root.querySelector('[data-act="new"]');
    if (newBtn) newBtn.addEventListener('click', () => App.navigate('questions', { new: 1 }));

    root.querySelectorAll('[data-act]').forEach((el) => {
      const act = el.getAttribute('data-act');
      if (!['edit', 'dup', 'del'].includes(act)) return;
      el.addEventListener('click', async () => {
        const id = el.getAttribute('data-id');
        const question = list.find((x) => String(x.id) === String(id));
        if (act === 'edit') {
          App.navigate('questions', { edit: id });
        } else if (act === 'dup') {
          try {
            await api.post('/api/questions/' + id + '/duplicate', {});
            ui.toast('已复制一份', 'ok');
            await App.refresh();
          } catch (err) {
            ui.toast(err.message, 'error');
          }
        } else if (act === 'del') {
          // 删一条评分标准不是孤立操作：它可能正被若干份试卷引用，
          // 所以先如实告诉老师"会从哪几份卷子上消失、哪些作答和评分跟着没了"。
          const used = question ? question.usedInPapers : 0;
          const lines = ['确定删除这条评分标准吗？', '', (question ? question.stem.slice(0, 60) : '')];
          if (used) {
            lines.push('', '这条评分标准正用在 ' + used + ' 份试卷上：');
            lines.push('· 会被从这些试卷里摘掉，后面的题目重新编号');
            lines.push('· 这些题上学生已交的作答和 AI 评分会一并删除');
          }
          lines.push('', '删除后不可撤销。');
          const yes = await ui.confirmDialog('删除评分标准', lines.join('\n'), '删除');
          if (!yes) return;
          try {
            const res = await api.del('/api/questions/' + id);
            const detail = res && res.removed ? ui.describeRemoved(res.removed) : '';
            ui.toast('已删除' + (detail ? '，同时清掉 ' + detail : ''), 'ok');
            await App.refresh();
          } catch (err) {
            ui.toast(err.message, 'error');
          }
        }
      });
    });
  }

  App.register('questions', {
    async render(root, query) {
      if (query.new || query.edit) {
        await renderEditor(root, query);
      } else {
        await renderList(root);
      }
    },
  });
})();
