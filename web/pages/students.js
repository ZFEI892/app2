(function () {
  'use strict';

  let searchKeyword = '';

  function studentFormHtml(student) {
    const s = student || { name: '', sno: '', className: '' };
    return (
      '<h3>' + (student ? '编辑学生' : '新增学生') + '</h3>' +
      '<label class="field"><span>姓名 *</span><input type="text" data-f="name" value="' + ui.esc(s.name) + '"></label>' +
      '<label class="field"><span>学号</span><input type="text" data-f="sno" value="' + ui.esc(s.sno) + '"></label>' +
      '<label class="field"><span>班级</span><input type="text" data-f="className" value="' + ui.esc(s.className) + '"></label>' +
      '<div class="modal-actions">' +
      '<button class="btn" data-close>取消</button>' +
      '<button class="btn btn-primary" data-submit>保存</button>' +
      '</div>'
    );
  }

  /** 弹出学生表单；返回 {name,sno,className}，取消返回 null */
  function openStudentForm(student) {
    return ui.modal(studentFormHtml(student), {
      onMount(box, done) {
        const first = box.querySelector('[data-f="name"]');
        if (first) first.focus();
        const read = () => {
          const get = (f) => {
            const el = box.querySelector('[data-f="' + f + '"]');
            return el ? el.value.trim() : '';
          };
          return { name: get('name'), sno: get('sno'), className: get('className') };
        };
        box.querySelector('[data-submit]').addEventListener('click', () => done(read()));
        box.addEventListener('keydown', (e) => {
          if (e.key === 'Enter') done(read());
        });
      },
    });
  }

  async function openHistory(student) {
    let data;
    try {
      data = await api.get('/api/students/' + student.id + '/history');
    } catch (err) {
      ui.toast(err.message, 'error');
      return;
    }
    const rows = data.history;
    const body = rows.length
      ? '<table class="data"><thead><tr><th>试卷</th><th>提交时间</th><th>状态</th><th class="num">得分</th><th class="num">满分</th><th>是否及格</th></tr></thead><tbody>' +
        rows.map((h) =>
          '<tr><td>' + ui.esc(h.paperName) + '</td>' +
          '<td class="nowrap">' + ui.fmtDateTime(h.submittedAt) + '</td>' +
          '<td>' + ui.statusBadge(h.gradeStatus) + '</td>' +
          '<td class="num">' + (h.total === null ? '—' : ui.num(h.total)) + '</td>' +
          '<td class="num">' + ui.num(h.fullMarks) + '</td>' +
          '<td>' + (h.passed === null ? '—' : (h.passed ? '及格' : '未及格')) + '</td></tr>'
        ).join('') +
        '</tbody></table>'
      : ui.emptyState('该学生还没有答卷记录');

    await ui.modal(
      '<h3>' + ui.esc(data.student.name) + ' · 历次成绩</h3>' +
      '<div class="small muted mb12">' + ui.esc(data.student.className || '未填班级') + ' ' + ui.esc(data.student.sno || '') + '</div>' +
      body +
      '<div class="modal-actions"><button class="btn" data-close>关闭</button></div>'
    );
  }

  async function openImport() {
    const html =
      '<h3>批量导入学生</h3>' +
      '<p class="muted small" style="margin-top:0">每行一位学生，格式：<span class="mono">姓名 学号 班级</span>（学号、班级可省略，用空格或逗号分隔）</p>' +
      '<textarea data-src rows="7" placeholder="张三 001 高一(1)班&#10;李四 002 高一(1)班&#10;王五"></textarea>' +
      '<div class="right mt8"><button class="btn btn-sm" data-preview>预览</button></div>' +
      '<div data-host class="mt12"></div>' +
      '<div class="modal-actions">' +
      '<button class="btn" data-close>取消</button>' +
      '<button class="btn btn-primary" data-import disabled>确认导入</button>' +
      '</div>';

    const res = await ui.modal(html, {
      onMount(box, done) {
        let parsed = null;
        box.querySelector('[data-preview]').addEventListener('click', async () => {
          const text = box.querySelector('[data-src]').value;
          if (!text.trim()) {
            ui.toast('请先粘贴名单', 'error');
            return;
          }
          try {
            const r = await api.post('/api/students/import/preview', { text });
            parsed = r.rows;
            const host = box.querySelector('[data-host]');
            if (!parsed.length) {
              host.innerHTML = ui.emptyState('没有解析出学生');
              box.querySelector('[data-import]').disabled = true;
              return;
            }
            host.innerHTML =
              '<div class="small muted mb8">共 ' + parsed.length + ' 条，其中重复 ' + r.duplicates + ' 条（重复的会被跳过）</div>' +
              '<table class="data"><thead><tr><th>姓名</th><th>学号</th><th>班级</th><th>检查</th></tr></thead><tbody>' +
              parsed.map((row, i) =>
                '<tr><td><input type="text" data-idx="' + i + '" data-k="name" value="' + ui.esc(row.name) + '"></td>' +
                '<td><input type="text" data-idx="' + i + '" data-k="sno" value="' + ui.esc(row.sno) + '"></td>' +
                '<td><input type="text" data-idx="' + i + '" data-k="className" value="' + ui.esc(row.className) + '"></td>' +
                '<td class="small">' + (row.duplicate ? '<span class="badge badge-warn">' + ui.esc(row.reason) + '</span>' : '可导入') + '</td></tr>'
              ).join('') +
              '</tbody></table>';
            box.querySelector('[data-import]').disabled = false;
          } catch (err) {
            ui.toast(err.message, 'error');
          }
        });

        box.querySelector('[data-import]').addEventListener('click', async () => {
          if (!parsed) return;
          const rows = parsed.map((row, i) => {
            const pick = (k) => {
              const el = box.querySelector('[data-idx="' + i + '"][data-k="' + k + '"]');
              return el ? el.value.trim() : '';
            };
            return { name: pick('name'), sno: pick('sno'), className: pick('className') };
          });
          try {
            const r = await api.post('/api/students/import', { rows });
            done(r);
          } catch (err) {
            ui.toast(err.message, 'error');
          }
        });
      },
    });

    if (res) {
      ui.toast('成功导入 ' + res.created + ' 位学生' + (res.skipped.length ? '，跳过 ' + res.skipped.length + ' 条' : ''), 'ok');
      await App.refresh();
    }
  }

  App.register('students', {
    async render(root) {
      let data;
      try {
        data = await api.get('/api/students' + (searchKeyword ? '?q=' + encodeURIComponent(searchKeyword) : ''));
      } catch (err) {
        root.innerHTML = ui.pageHead('学生') + '<div class="card">' + ui.esc(err.message) + '</div>';
        return;
      }

      const students = data.students;
      const classes = [...new Set(students.map((s) => s.className).filter(Boolean))];

      root.innerHTML =
        ui.pageHead('学生', '共 ' + students.length + ' 位' + (classes.length ? '，' + classes.length + ' 个班级' : ''),
          '<button class="btn btn-sm" data-act="import">批量导入</button>' +
          '<button class="btn btn-sm btn-primary" data-act="add">新增学生</button>'
        ) +
        '<div class="card">' +
        '<div class="row mb12">' +
        '<input type="search" class="grow" data-act="search" placeholder="搜索姓名 / 学号 / 班级" value="' + ui.esc(searchKeyword) + '">' +
        '</div>' +
        (students.length
          ? '<table class="data"><thead><tr><th>姓名</th><th>学号</th><th>班级</th><th class="num">答卷数</th><th class="right">操作</th></tr></thead><tbody>' +
            students.map((s) =>
              '<tr><td><span class="clickable" data-act="history" data-id="' + s.id + '">' + ui.esc(s.name) + '</span></td>' +
              '<td>' + ui.esc(s.sno || '—') + '</td>' +
              '<td>' + ui.esc(s.className || '—') + '</td>' +
              '<td class="num">' + s.submissionCount + '</td>' +
              '<td class="right nowrap">' +
              '<button class="btn-link" data-act="edit" data-id="' + s.id + '">编辑</button>' +
              '<button class="btn-link" data-act="del" data-id="' + s.id + '" style="color:var(--danger)">删除</button>' +
              '</td></tr>'
            ).join('') +
            '</tbody></table>'
          : ui.emptyState('还没有学生', '点右上角「新增学生」或「批量导入」开始')) +
        '</div>';

      const findById = (id) => students.find((s) => String(s.id) === String(id));

      root.querySelectorAll('[data-act]').forEach((el) => {
        const act = el.getAttribute('data-act');
        if (act === 'search') {
          let timer = null;
          el.addEventListener('input', () => {
            clearTimeout(timer);
            timer = setTimeout(() => {
              searchKeyword = el.value.trim();
              App.refresh();
            }, 250);
          });
          return;
        }
        el.addEventListener('click', async () => {
          if (act === 'add') {
            const form = await openStudentForm(null);
            if (!form) return;
            try {
              await api.post('/api/students', form);
              ui.toast('已添加', 'ok');
              await App.refresh();
            } catch (err) {
              ui.toast(err.message, 'error');
            }
          } else if (act === 'edit') {
            const student = findById(el.getAttribute('data-id'));
            const form = await openStudentForm(student);
            if (!form) return;
            try {
              await api.put('/api/students/' + student.id, form);
              ui.toast('已保存', 'ok');
              await App.refresh();
            } catch (err) {
              ui.toast(err.message, 'error');
            }
          } else if (act === 'del') {
            const student = findById(el.getAttribute('data-id'));
            // 删学生等于删掉他的所有考试历史，先把"有多少条记录会跟着消失"讲清楚
            const lines = ['确定删除「' + student.name + '」吗？'];
            if (student.submissionCount) {
              lines.push('', '这名学生有 ' + student.submissionCount + ' 条答卷记录：');
              lines.push('· 每条记录下的作答、AI 评分、批注都会一并删除');
              lines.push('· 已经确认过的成绩也会随之消失，无法恢复');
            } else {
              lines.push('', '他目前还没有答卷记录。');
            }
            lines.push('', '删除后不可撤销。');
            const yes = await ui.confirmDialog('删除学生', lines.join('\n'), '删除');
            if (!yes) return;
            try {
              const res = await api.del('/api/students/' + student.id);
              const detail = res && res.removed ? ui.describeRemoved(res.removed) : '';
              ui.toast('已删除' + (detail ? '，同时清掉 ' + detail : ''), 'ok');
              await App.refresh();
            } catch (err) {
              ui.toast(err.message, 'error');
            }
          } else if (act === 'history') {
            await openHistory(findById(el.getAttribute('data-id')));
          } else if (act === 'import') {
            await openImport();
          }
        });
      });
    },
  });
})();
