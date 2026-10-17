(function () {
  'use strict';

  function esc(value) {
    if (value === null || value === undefined) return '';
    return String(value)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  function toast(message, type) {
    const host = document.getElementById('toast-host');
    if (!host) return;
    const el = document.createElement('div');
    el.className = 'toast' + (type ? ' ' + type : '');
    el.textContent = message;
    host.appendChild(el);
    setTimeout(() => {
      el.style.opacity = '0';
      el.style.transition = 'opacity .3s';
      setTimeout(() => el.remove(), 320);
    }, type === 'error' ? 5200 : 2600);
  }

  function modal(html, options) {
    const opts = options || {};
    const host = document.getElementById('modal-host');
    return new Promise((resolve) => {
      const backdrop = document.createElement('div');
      backdrop.className = 'modal-backdrop';
      const box = document.createElement('div');
      box.className = 'modal';
      box.innerHTML = html;
      backdrop.appendChild(box);
      host.appendChild(backdrop);

      const done = (value) => {
        backdrop.remove();
        resolve(value);
      };

      backdrop.addEventListener('click', (e) => {
        if (e.target === backdrop) done(null);
      });
      box.querySelectorAll('[data-close]').forEach((b) => {
        b.addEventListener('click', () => done(null));
      });
      const okBtn = box.querySelector('[data-ok]');
      if (okBtn) {
        okBtn.addEventListener('click', () => {
          const input = box.querySelector('[data-modal-input]');
          done(input ? input.value : true);
        });
      }
      if (opts.onMount) opts.onMount(box, done);
    });
  }

  function confirmDialog(title, message, okText) {
    return modal(
      '<h3>' + esc(title) + '</h3>' +
      '<p class="muted" style="margin:0;white-space:pre-wrap">' + esc(message) + '</p>' +
      '<div class="modal-actions">' +
      '<button class="btn" data-close>取消</button>' +
      '<button class="btn btn-primary" data-ok>' + esc(okText || '确定') + '</button>' +
      '</div>'
    ).then((v) => v === true);
  }

  function promptDialog(title, label, value) {
    return modal(
      '<h3>' + esc(title) + '</h3>' +
      '<label class="field"><span>' + esc(label) + '</span>' +
      '<input type="text" data-modal-input value="' + esc(value || '') + '"></label>' +
      '<div class="modal-actions">' +
      '<button class="btn" data-close>取消</button>' +
      '<button class="btn btn-primary" data-ok>确定</button>' +
      '</div>',
      {
        onMount: (box) => {
          const input = box.querySelector('[data-modal-input]');
          if (input) {
            input.focus();
            input.select();
            input.addEventListener('keydown', (e) => {
              if (e.key === 'Enter') box.querySelector('[data-ok]').click();
            });
          }
        },
      }
    );
  }

  function fmtDateTime(iso) {
    if (!iso) return '—';
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return '—';
    const p = (n) => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
  }

  function fmtDate(iso) {
    if (!iso) return '—';
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return '—';
    const p = (n) => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
  }

  function todayLabel() {
    const d = new Date();
    const week = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'][d.getDay()];
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')} ${week}`;
  }

  /** 去掉浮点误差的显示：0.30000000000000004 -> 0.3 */
  function num(value, digits) {
    const n = Number(value);
    if (!Number.isFinite(n)) return '—';
    const d = digits === undefined ? 2 : digits;
    const fixed = Number(n.toFixed(d));
    return String(fixed);
  }

  function emptyState(title, hint) {
    return (
      '<div class="empty"><div class="empty-title">' + esc(title) + '</div>' +
      (hint ? '<div>' + esc(hint) + '</div>' : '') +
      '</div>'
    );
  }

  function loading(text) {
    return '<div class="empty">' + esc(text || '加载中…') + '</div>';
  }

  function pageHead(title, sub, actionsHtml) {
    return (
      '<div class="page-head"><div>' +
      '<h1 class="page-title">' + esc(title) + '</h1>' +
      (sub ? '<div class="page-sub">' + esc(sub) + '</div>' : '') +
      '</div><div class="row">' + (actionsHtml || '') + '</div></div>'
    );
  }

  function statusBadge(status) {
    const map = {
      draft: ['草稿', 'badge'],
      open: ['待作答', 'badge-accent'],
      collecting: ['收卷中', 'badge-accent'],
      grading: ['批改中', 'badge-warn'],
      done: ['已完成', 'badge-ok'],
      ungraded: ['待批改', 'badge-warn'],
      ai_done: ['待确认', 'badge-accent'],
      confirmed: ['已确认', 'badge-ok'],
      submitted: ['已交', 'badge-ok'],
      absent: ['缺考', 'badge-danger'],
      auto: ['AI 自主评判', 'badge-accent'],
      rubric: ['按评分标准', 'badge'],
    };
    const found = map[status] || [status || '—', 'badge'];
    return '<span class="badge ' + found[1] + '">' + esc(found[0]) + '</span>';
  }

  /** 把后端回报的「删了多少东西」说成人话，用在删除后的提示里 */
  function describeRemoved(counts) {
    const c = counts || {};
    const parts = [];
    if (c.submissions) parts.push(c.submissions + ' 份答卷');
    if (c.answers) parts.push(c.answers + ' 条作答');
    if (c.gradeSheets) parts.push(c.gradeSheets + ' 份评分');
    if (c.gradeItems) parts.push(c.gradeItems + ' 条评分明细');
    if (c.paperQuestions) parts.push(c.paperQuestions + ' 处用题');
    if (c.batchJobs) parts.push(c.batchJobs + ' 个批量任务');
    if (c.papers) parts.push(c.papers + ' 处试卷引用');
    return parts.join('、');
  }

  window.ui = {
    esc, toast, modal, confirmDialog, promptDialog,
    fmtDateTime, fmtDate, todayLabel, num, emptyState, loading, pageHead, statusBadge,
    describeRemoved,
  };
})();
