'use strict';

/**
 * 启动器（双击「启动.bat」）能不能真的把服务拉起来。
 *
 * 事故背景：这个文件曾经是 LF（Unix）换行的。Windows 的 cmd 解析 .bat 只认 CRLF，
 * 遇到 `&&` 与 `if not defined ... (` 这类复合语句就会解析错乱，
 * 表现就是双击后窗口一闪而过、服务根本没起来。这里把它钉死。
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');

const { ROOT_DIR, tempDir } = require('./helpers');

const BAT = path.join(ROOT_DIR, '启动.bat');
const IS_WIN = process.platform === 'win32';

test('启动器 · 必须是 Windows 换行（CRLF），否则双击打不开', () => {
  const text = fs.readFileSync(BAT, 'utf8');

  // 不允许出现「前面不是 CR 的 LF」——那就是裸 LF 换行
  const bareLf = text.match(/(^|[^\r])\n/g) || [];
  assert.deepStrictEqual(bareLf, [], '启动器里有裸 LF 换行，cmd 解析会错乱');

  const crlf = (text.match(/\r\n/g) || []).length;
  const lf = (text.match(/\n/g) || []).length;
  assert.strictEqual(crlf, lf, '每一行都必须是 CRLF');
  assert.ok(crlf >= 10, '文件内容看起来不完整，只有 ' + crlf + ' 行');
});

test('启动器 · 关键内容齐全', () => {
  const bat = fs.readFileSync(BAT, 'utf8');
  assert.ok(bat.includes('chcp 65001'), '要切到 UTF-8，中文提示才不会乱码');
  assert.ok(bat.includes('NODE_EXE'), '要先把 node 路径解析出来再用');
  assert.ok(bat.includes('server\\index.js'), '要启动项目自己的入口');
  assert.ok(/pause/i.test(bat), '结尾要有 pause，出错时窗口不能一闪而过');
  assert.ok(!/\bnpm\b/.test(bat), '不能依赖 npm（本项目零第三方依赖）');
  assert.ok(bat.includes('正在启动'), '要告诉用户正在启动，别让人以为卡死了');
});

test('启动器 · Node 太老时给的是人话提示，不是一堆报错', () => {
  const { nodeVersionProblem } = require('../server/index.js');

  assert.strictEqual(nodeVersionProblem(), null, '当前 Node 版本应满足要求，实际：' + process.version);
  assert.strictEqual(nodeVersionProblem('24.20.0'), null);
  assert.strictEqual(nodeVersionProblem('22.22.2'), null);
  assert.strictEqual(nodeVersionProblem('22.5.0'), null);

  ['22.4.1', '21.7.0', '20.11.0', '16.20.2'].forEach((v) => {
    const msg = nodeVersionProblem(v);
    assert.ok(msg, v + ' 应该被判为太老');
    assert.ok(msg.includes('v' + v), '提示里要写出用户当前的版本号');
    assert.ok(msg.includes('22.5'), '提示里要写清需要什么版本');
  });
});

test('启动器 · 真的双击能把服务拉起来', { skip: IS_WIN ? false : '批处理只在 Windows 上有意义' }, async (t) => {
  const child = spawn('cmd', ['/c', '启动.bat'], {
    cwd: ROOT_DIR,
    env: {
      ...process.env,
      NO_OPEN: '1',
      PORT: '8791',
      // 全部隔离到临时目录，别碰真实项目目录与用户私有配置
      APP_ROOT_DIR: tempDir('pgroot-'),
      APP_CONFIG_DIR: tempDir('pgcfg-'),
      APP_DB_FILE: path.join(tempDir('pgdata-'), 'paper.db'),
      APP_AI_MODE: 'mock',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  t.after(() => {
    if (IS_WIN) {
      try { spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { stdio: 'ignore' }); } catch (_) { /* 已经没了 */ }
    } else {
      try { child.kill(); } catch (_) { /* 已经没了 */ }
    }
  });

  let out = '';
  child.stdout.on('data', (d) => { out += String(d); });
  child.stderr.on('data', (d) => { out += String(d); });

  // 从启动窗口打印的地址里取端口，这样端口被占自动 +1 也能跟上。
  // 窗口给 60s：cmd 拉起 node 本身很快，但全量测试并发跑时机器很忙，
  // 25s 会偶发不够（断言不变，只是别让并发把这条用例误判成失败）。
  const deadline = Date.now() + 60000;
  let base = null;
  let html = null;
  while (Date.now() < deadline) {
    const m = out.match(/http:\/\/127\.0\.0\.1:(\d+)/);
    if (m) {
      base = 'http://127.0.0.1:' + m[1];
      try {
        const r = await fetch(base + '/');
        if (r.status === 200) { html = await r.text(); break; }
      } catch (_) { /* 还没就绪 */ }
    }
    await new Promise((r) => setTimeout(r, 200));
  }

  assert.ok(base, '启动器没把服务拉起来，窗口输出：\n' + out);
  assert.ok(html && html.includes('试卷批改'), '首页没打开或内容不对，窗口输出：\n' + out);
  assert.ok(out.includes('试卷批改专属 App 已启动'), '启动窗口应打印成功横幅，实际输出：\n' + out);
  assert.ok(out.includes('正在启动'), '启动前那句提示要打出来');
});
