(function () {
  'use strict';

  function fmtSize(bytes) {
    const n = Number(bytes) || 0;
    if (n < 1024) return n + ' B';
    if (n < 1024 * 1024) return (n / 1024).toFixed(1) + ' KB';
    return (n / 1024 / 1024).toFixed(2) + ' MB';
  }

  function aiCard(s) {
    return '<div class="card"><div class="card-title-row"><div class="card-title">AI 批改服务</div>' +
      (s.aiMode === 'mock'
        ? '<span class="badge badge-warn">当前是模拟模式（不联网），仅供演示与测试</span>'
        : '<span class="badge badge-ok">真实调用模式</span>') +
      '</div>' +
      '<div class="grid grid-2">' +
      '<label class="field"><span>接口地址</span>' +
      '<input type="text" data-f="baseUrl" value="' + ui.esc(s.baseUrl) + '" placeholder="https://..."></label>' +
      '<label class="field"><span>模型名</span>' +
      '<input type="text" data-f="model" value="' + ui.esc(s.model) + '" placeholder="qwen3.8-max-0902"></label>' +
      '<label class="field"><span>API Key' +
      (s.apiKeySet ? '（已配置 ' + ui.esc(s.apiKeyMasked) + '，留空即不修改）' : '（还没配置）') + '</span>' +
      '<input type="password" data-f="apiKey" value="" placeholder="' +
      (s.apiKeySet ? '留空则不覆盖已保存的 Key' : '粘贴你的 API Key') + '" autocomplete="off"></label>' +
      '<label class="field"><span>存疑阈值（AI 把握低于它就先标存疑，0~1）</span>' +
      '<input type="number" min="0" max="1" step="0.05" data-f="doubtThreshold" value="' +
      ui.num(s.doubtThreshold, 2) + '"></label>' +
      '<label class="field"><span>批量批改每次请求间隔（毫秒，0 表示不停）</span>' +
      '<input type="number" min="0" step="100" data-f="aiDelayMs" value="' + ui.num(s.aiDelayMs, 0) + '"></label>' +
      '</div>' +
      (s.configFile
        ? '<div class="small muted mt8">API Key 存在这个私有文件里：<span class="mono">' + ui.esc(s.configFile) + '</span>' +
          '<br>它不在项目文件夹、不在数据文件里，也不会被打进备份包。想换 Key 或清掉，改这个文件即可。' +
          '</div>'
        : '') +
      '<div class="row mt12">' +
      '<button class="btn btn-primary" data-act="save">保存设置</button>' +
      '<button class="btn" data-act="test">测试连接</button>' +
      '<span class="small muted" data-test-result></span>' +
      '</div></div>';
  }

  function dataCard(s) {
    return '<div class="card"><div class="card-title">数据文件</div>' +
      '<div class="small">当前数据文件（全部业务数据都在这个文件里）</div>' +
      '<div class="mono mt8" data-copy="' + ui.esc(s.dataFile) + '">' + ui.esc(s.dataFile) +
      ' <span class="muted">（' + fmtSize(s.dbSize) + '）</span></div>' +
      '<div class="small muted mt8">图片目录：<span class="mono">' + ui.esc(s.attachmentsDir) + '</span></div>' +
      '<div class="small muted">备份目录：<span class="mono">' + ui.esc(s.backupDir) + '</span></div>' +
      (s.dataFileConfigured
        ? '<div class="small mt8"><span class="badge badge-warn">已设置过新位置，重启服务后生效</span></div>'
        : '') +
      '<div class="row mt16">' +
      '<input class="grow" type="text" data-f="dataFile" placeholder="换成别的文件夹，例如 D:\\试卷数据\\paper.db">' +
      '<button class="btn" data-act="move">换位置</button>' +
      '</div>' +
      '<div class="small muted mt8">换位置会把新路径记到私有配置文件，需要重启服务（关掉启动窗口再双击启动）才生效；' +
      '原来的数据文件不会被动。</div>' +
      '</div>';
  }

  function backupCard(s, backups) {
    const list = backups.filter((b) => b.kind === 'backup');
    const preList = backups.filter((b) => b.kind !== 'backup');
    return '<div class="card"><div class="card-title-row">' +
      '<div class="card-title">备份与恢复</div>' +
      '<label class="small muted"><input type="checkbox" data-f="includeAttachments" checked> 备份包含图片附件</label>' +
      '</div>' +
      '<div class="row">' +
      '<button class="btn btn-primary" data-act="backup">一键备份</button>' +
      '<span class="small muted">备份是一个 zip 文件，可以直接复制到别处（U 盘 / 网盘）保存，里面不含 API Key</span>' +
      '</div>' +
      (list.length
        ? '<table class="data mt16"><thead><tr>' +
          '<th>备份文件</th><th class="num">大小</th><th>时间</th><th class="right">操作</th>' +
          '</tr></thead><tbody>' + list.map((b) => '<tr>' +
            '<td class="mono small">' + ui.esc(b.name) + '</td>' +
            '<td class="num">' + fmtSize(b.size) + '</td>' +
            '<td class="small">' + ui.fmtDateTime(b.createdAt) + '</td>' +
            '<td class="right nowrap">' +
            '<a class="btn btn-sm" href="' + ui.esc(b.url) + '" download>另存</a> ' +
            '<button class="btn btn-sm" data-restore="' + ui.esc(b.name) + '">恢复</button> ' +
            '<button class="btn btn-sm btn-danger" data-del="' + ui.esc(b.name) + '">删除</button>' +
            '</td></tr>').join('') + '</tbody></table>'
        : '<div class="mt16">' + ui.emptyState('还没有备份', '点上面的「一键备份」生成第一份') + '</div>') +
      (preList.length
        ? '<div class="small muted mt16">恢复前自动另存的存档（' + preList.length + ' 份）：' +
          preList.map((b) => '<span class="mono">' + ui.esc(b.name) + '</span>').join('、') + '</div>'
        : '') +
      '<div class="mt16 small muted">恢复会用备份里的数据覆盖当前数据。恢复前系统会自动把当前数据另存一份，' +
      '万一选错还能回头。恢复后页面会自动刷新。</div>' +
      '</div>';
  }

  function autoCard(s) {
    return '<div class="card"><div class="card-title">自动备份</div>' +
      '<label class="row" style="gap:8px"><input type="checkbox" data-f="autoBackup"' +
      (s.autoBackup ? ' checked' : '') + '> 每天首次启动时自动备份一份</label>' +
      '<label class="field mt12" style="max-width:260px"><span>最多保留多少份</span>' +
      '<input type="number" min="1" max="60" data-f="keepBackups" value="' + ui.num(s.keepBackups, 0) + '"></label>' +
      '<div class="small muted mt8">超出的按时间从旧到新删除。开启后每次启动都能在备份列表里看到当天的备份。</div>' +
      '</div>';
  }

  App.register('settings', {
    async render(root) {
      let s;
      let backups = [];
      try {
        s = await api.get('/api/settings');
        backups = (await api.get('/api/backups')).backups || [];
      } catch (err) {
        root.innerHTML = ui.pageHead('设置') + '<div class="card">' + ui.esc(err.message) + '</div>';
        return;
      }

      root.innerHTML = ui.pageHead('设置', '只保存在这台电脑上，不会上传到任何地方') +
        aiCard(s) +
        dataCard(s) +
        backupCard(s, backups) +
        autoCard(s);

      const val = (name) => {
        const el = root.querySelector('[data-f="' + name + '"]');
        if (!el) return undefined;
        if (el.type === 'checkbox') return el.checked;
        return el.value;
      };
      const showResult = (text, ok) => {
        const el = root.querySelector('[data-test-result]');
        el.textContent = text;
        el.style.color = ok ? 'var(--ok)' : 'var(--danger)';
      };

      root.querySelector('[data-act="save"]').addEventListener('click', async () => {
        try {
          await api.put('/api/settings', {
            baseUrl: val('baseUrl'),
            model: val('model'),
            apiKey: val('apiKey'),
            doubtThreshold: val('doubtThreshold'),
            aiDelayMs: val('aiDelayMs'),
            autoBackup: val('autoBackup'),
            keepBackups: val('keepBackups'),
          });
          ui.toast('设置已保存', 'ok');
          await App.refresh();
        } catch (err) {
          ui.toast(err.message, 'error');
        }
      });

      root.querySelector('[data-act="test"]').addEventListener('click', async (ev) => {
        const btn = ev.currentTarget;
        btn.disabled = true;
        showResult('正在测试…', true);
        try {
          const res = await api.post('/api/settings/test-ai', {});
          if (res.ok) showResult('连接正常，模型回复：' + (res.reply || '（空）'), true);
          else showResult('不可用：' + res.reason, false);
        } catch (err) {
          showResult('不可用：' + err.message, false);
        } finally {
          btn.disabled = false;
        }
      });

      root.querySelector('[data-act="move"]').addEventListener('click', async () => {
        const target = val('dataFile');
        if (!target) {
          ui.toast('请先填写新的数据文件路径', 'error');
          return;
        }
        try {
          const res = await api.put('/api/settings/data-file', { path: target });
          ui.toast(res.message, res.needRestart ? 'ok' : 'error');
          await App.refresh();
        } catch (err) {
          ui.toast(err.message, 'error');
        }
      });

      root.querySelector('[data-act="backup"]').addEventListener('click', async (ev) => {
        const btn = ev.currentTarget;
        btn.disabled = true;
        btn.textContent = '正在备份…';
        try {
          const res = await api.post('/api/backups', { includeAttachments: val('includeAttachments') });
          ui.toast('已生成备份 ' + res.name + '（' + fmtSize(res.size) + '）', 'ok');
          await App.refresh();
        } catch (err) {
          ui.toast(err.message, 'error');
          btn.disabled = false;
          btn.textContent = '一键备份';
        }
      });

      root.querySelectorAll('[data-restore]').forEach((b) => b.addEventListener('click', async () => {
        const name = b.getAttribute('data-restore');
        const yes = await ui.confirmDialog(
          '从备份恢复',
          '要用「' + name + '」里的数据覆盖当前数据吗？\n\n' +
          '当前数据会先被自动另存一份，所以选错了还能回头。\n恢复后页面会自动刷新。',
          '确认覆盖'
        );
        if (!yes) return;
        b.disabled = true;
        try {
          const res = await api.post('/api/backups/restore', { name });
          ui.toast('已恢复，当前数据已另存为 ' + res.preRestore, 'ok');
          setTimeout(() => App.refresh(), 600);
        } catch (err) {
          ui.toast(err.message, 'error');
          b.disabled = false;
        }
      }));

      root.querySelectorAll('[data-del]').forEach((b) => b.addEventListener('click', async () => {
        const name = b.getAttribute('data-del');
        const yes = await ui.confirmDialog('删除备份', '确定删除备份文件「' + name + '」吗？删了就找不回来了。', '删除');
        if (!yes) return;
        try {
          await api.del('/api/backups/' + encodeURIComponent(name));
          ui.toast('已删除', 'ok');
          await App.refresh();
        } catch (err) {
          ui.toast(err.message, 'error');
        }
      }));
    },
  });
})();
