'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const { createZip, crc32 } = require('../server/lib/zip');
const { readZipEntry, listZipEntries } = require('../server/lib/zipread');
const { getDb, getDbFile } = require('../server/db');
const { runAutoBackup, listBackups, dirOf } = require('../server/routes/backup');
const { startApp, ok, tempDir } = require('./helpers');

const PNG_1PX = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';

/** 一份最小的可校验数据：1 道题 / 1 份试卷 / 1 名学生 / 1 份已确认的答卷 */
async function seed(ctx) {
  const q = ok(await ctx.api.post('/api/questions', {
    stem: '求落地时间。', rubricType: 'items',
    items: [{ text: '写出位移公式', points: 4 }, { text: '结果与单位规范', points: 2 }],
  })).question;
  const paper = ok(await ctx.api.post('/api/papers', { name: '备份测试卷' })).paper;
  const saved = ok(await ctx.api.put('/api/papers/' + paper.id + '/questions', { questions: [{ questionId: q.id }] }));
  ok(await ctx.api.post('/api/papers/' + paper.id + '/publish', {}));
  const stu = ok(await ctx.api.post('/api/students', { name: '张三', className: '高一(1)班' })).student;
  const sub = ok(await ctx.api.post('/api/papers/' + paper.id + '/submissions', {
    studentId: stu.id,
    answers: [{ paperQuestionId: saved.questions[0].paperQuestionId, text: 't = 3 s' }],
  })).submission;
  const graded = ok(await ctx.api.post('/api/submissions/' + sub.id + '/grade', {}));
  ok(await ctx.api.put('/api/grade-items/' + graded.detail.questions[0].items[0].id, { finalScore: 4 }));
  ok(await ctx.api.put('/api/grade-sheets/' + graded.detail.gradeSheet.id, { comment: '步骤完整' }));
  ok(await ctx.api.post('/api/grade-sheets/' + graded.detail.gradeSheet.id + '/confirm', {}));
  return { paper, stu, sub, q };
}

function snapshot(ctx) {
  const db = getDb();
  return {
    questions: db.prepare('SELECT COUNT(*) AS c FROM questions').get().c,
    papers: db.prepare('SELECT COUNT(*) AS c FROM papers').get().c,
    students: db.prepare('SELECT COUNT(*) AS c FROM students').get().c,
    submissions: db.prepare('SELECT COUNT(*) AS c FROM submissions').get().c,
    sheets: db.prepare('SELECT COUNT(*) AS c FROM grade_sheets').get().c,
    items: db.prepare('SELECT COUNT(*) AS c FROM grade_items').get().c,
    confirmed: db.prepare("SELECT COUNT(*) AS c FROM grade_sheets WHERE status='confirmed'").get().c,
    totals: db.prepare('SELECT final_total FROM grade_sheets ORDER BY id').all().map((r) => r.final_total),
    comments: db.prepare('SELECT comment FROM grade_sheets ORDER BY id').all().map((r) => r.comment),
    answerTexts: db.prepare('SELECT text FROM answers ORDER BY id').all().map((r) => r.text),
    stems: db.prepare('SELECT stem FROM questions ORDER BY id').all().map((r) => r.stem),
    rubricTexts: db.prepare('SELECT text FROM question_items ORDER BY id').all().map((r) => r.text),
  };
}

test('M7 · 自带 ZIP：写入的压缩包能被自己的读包器完整读回', () => {
  const entries = [
    { name: 'a.txt', data: Buffer.from('hello 试卷 ' + 'x'.repeat(5000), 'utf8') },
    { name: 'dir/b.bin', data: Buffer.from([0, 1, 2, 3, 255, 254]) },
    { name: 'empty.txt', data: Buffer.alloc(0) },
  ];
  const zip = createZip(entries);

  assert.deepStrictEqual(
    listZipEntries(zip).sort(),
    ['a.txt', 'dir/b.bin', 'empty.txt'],
    '中央目录应列出全部条目'
  );
  entries.forEach((e) => {
    const back = readZipEntry(zip, e.name);
    assert.ok(back, e.name + ' 应能读回');
    assert.strictEqual(Buffer.compare(back, e.data), 0, e.name + ' 内容应逐字节一致');
  });
  assert.strictEqual(readZipEntry(zip, '不存在.txt'), null);
});

test('M7 · ZIP 的 CRC32 与标准值一致（保证别的解压工具也认）', () => {
  assert.strictEqual(crc32(Buffer.from('123456789', 'utf8')), 0xcbf43926);
  assert.strictEqual(crc32(Buffer.alloc(0)), 0);
});

test('M7 · 设置：接口地址/模型/阈值/间隔能存能读，Key 不回传明文', async (t) => {
  const ctx = await startApp({ rootDir: tempDir('pgroot-') });
  t.after(() => ctx.close());

  let s = ok(await ctx.api.get('/api/settings'));
  assert.strictEqual(s.apiKeySet, false);
  assert.strictEqual(s.apiKeyMasked, '');
  assert.strictEqual(s.model, 'qwen3.8-max-0902', '默认模型应已预置');
  assert.ok(s.dataFile.endsWith('paper.db'));
  assert.ok(fs.existsSync(s.dataFile), '设置页要能显示数据文件的真实路径');
  assert.ok(s.backupDir.includes('backups'));

  ok(await ctx.api.put('/api/settings', {
    baseUrl: 'https://example.com/v1/',
    model: 'my-model',
    apiKey: 'sk-test-1234567890abcd',
    doubtThreshold: 0.6,
    aiDelayMs: 300,
    autoBackup: false,
    keepBackups: 3,
  }));

  s = ok(await ctx.api.get('/api/settings'));
  assert.strictEqual(s.baseUrl, 'https://example.com/v1', '尾部斜杠应被去掉');
  assert.strictEqual(s.model, 'my-model');
  assert.strictEqual(s.apiKeySet, true);
  assert.strictEqual(s.apiKeyMasked, '****abcd', '只能看到后 4 位');
  assert.strictEqual(s.doubtThreshold, 0.6);
  assert.strictEqual(s.aiDelayMs, 300);
  assert.strictEqual(s.autoBackup, false);
  assert.strictEqual(s.keepBackups, 3);
  assert.ok(!JSON.stringify(s).includes('sk-test-1234567890abcd'), '任何响应里都不能出现明文 Key');

  // 留空 Key 不覆盖
  ok(await ctx.api.put('/api/settings', { apiKey: '' }));
  assert.strictEqual(ok(await ctx.api.get('/api/settings')).apiKeyMasked, '****abcd');

  // 校验
  assert.strictEqual((await ctx.api.put('/api/settings', { baseUrl: 'ftp://x' })).status, 400);
  assert.strictEqual((await ctx.api.put('/api/settings', { model: '   ' })).status, 400);
  assert.strictEqual((await ctx.api.put('/api/settings', { doubtThreshold: 1.5 })).status, 400);
  assert.strictEqual((await ctx.api.put('/api/settings', { aiDelayMs: -1 })).status, 400);
  assert.strictEqual((await ctx.api.put('/api/settings', { keepBackups: 0 })).status, 400);

  // 阈值改了以后，批量/单份批改会照新的来（0.6 时 0.9 的把握不再算存疑）
  assert.strictEqual(ok(await ctx.api.get('/api/settings')).doubtThreshold, 0.6);
});

test('M7 · 测试连接：模拟模式下如实说明，不假装成功', async (t) => {
  const ctx = await startApp({ aiMode: 'mock', rootDir: tempDir('pgroot-') });
  t.after(() => ctx.close());
  const res = ok(await ctx.api.post('/api/settings/test-ai', {}));
  assert.strictEqual(res.ok, false);
  assert.strictEqual(res.mock, true);
  assert.ok(res.reason.includes('模拟'));
});

test('M7 · 换数据文件位置：记进本地配置，并明确提示要重启', async (t) => {
  const rootDir = tempDir('pgroot-');
  const ctx = await startApp({ rootDir });
  t.after(() => ctx.close());

  const target = path.join(tempDir('pgdata-'), '我的试卷.db');
  const res = ok(await ctx.api.put('/api/settings/data-file', { path: target }));
  assert.strictEqual(res.needRestart, true);
  assert.strictEqual(path.resolve(res.dataFile), path.resolve(target));

  const cfg = JSON.parse(fs.readFileSync(ctx.configFile, 'utf8'));
  assert.strictEqual(cfg.dbFile, path.resolve(target), '新位置要落到项目外的私有配置文件');
  assert.strictEqual(ok(await ctx.api.get('/api/settings')).dataFileConfigured, true);
  assert.strictEqual(
    path.resolve(ok(await ctx.api.get('/api/settings')).dataFile),
    path.resolve(ctx.dbFile),
    '当前这次运行仍然用原来的数据文件（重启才换）'
  );

  // 相对路径、空路径、写不进去的路径都要拒绝
  assert.strictEqual((await ctx.api.put('/api/settings/data-file', { path: '' })).status, 400);
  assert.strictEqual((await ctx.api.put('/api/settings/data-file', { path: 'data/x.db' })).status, 400);
  const bad = await ctx.api.put('/api/settings/data-file', {
    path: path.join(target, 'x.db'),
  });
  assert.strictEqual(bad.status, 400, '父目录不存在或不是文件夹时应明确报错');
  assert.ok(!fs.existsSync(target), '不该顺手把「我的试卷.db」建成一个文件夹');

  // 指向同一个文件时不算变更
  const same = ok(await ctx.api.put('/api/settings/data-file', { path: ctx.dbFile }));
  assert.strictEqual(same.needRestart, false);
});

test('M7 · 一键备份：生成单个 zip，里面装着完整数据', async (t) => {
  const ctx = await startApp({ rootDir: tempDir('pgroot-') });
  t.after(() => ctx.close());
  await seed(ctx);

  const res = ok(await ctx.api.post('/api/backups', { includeAttachments: true }));
  assert.match(res.name, /^backup-\d{4}-\d{2}-\d{2}-\d{4}\.zip$/, '文件名要带时间戳');
  const file = path.join(ctx.backupsDir, res.name);
  assert.ok(fs.existsSync(file), '备份文件应真的落到磁盘上');
  assert.strictEqual(res.manifest.counts.papers, 1);

  const buf = fs.readFileSync(file);
  const names = listZipEntries(buf);
  assert.ok(names.includes('paper.db'), '备份里必须有数据文件');
  assert.ok(names.includes('manifest.json'));
  const manifest = JSON.parse(readZipEntry(buf, 'manifest.json').toString('utf8'));
  assert.strictEqual(manifest.app, '试卷批改专属 App');
  assert.strictEqual(manifest.counts.submissions, 1);
  assert.strictEqual(manifest.counts.gradeSheets, 1);

  // 压缩包里的 paper.db 要能直接从内存读出来（说明是一个自洽的 SQLite 文件）
  const dbBytes = readZipEntry(buf, 'paper.db');
  assert.ok(dbBytes.length > 0);
  assert.strictEqual(dbBytes.slice(0, 15).toString('utf8'), 'SQLite format 3');

  const list = ok(await ctx.api.get('/api/backups'));
  assert.strictEqual(list.backups.length, 1);
  assert.strictEqual(list.backups[0].name, res.name);
  assert.strictEqual(list.backups[0].kind, 'backup');

  // 通过 /backups/ 能下载（这样用户能另存到别处）
  const dl = await fetch(ctx.base + list.backups[0].url);
  assert.strictEqual(dl.status, 200);
  assert.strictEqual(dl.headers.get('content-type'), 'application/zip');
  assert.strictEqual((await dl.arrayBuffer()).byteLength, fs.statSync(file).size);
});

test('M7 · 备份可选不含图片；含图片时附件能一起恢复', async (t) => {
  const ctx = await startApp({ rootDir: tempDir('pgroot-') });
  t.after(() => ctx.close());
  await seed(ctx);

  const up = ok(await ctx.api.post('/api/uploads', { data: 'data:image/png;base64,' + PNG_1PX, ext: 'png' }));
  assert.ok(fs.existsSync(path.join(ctx.attachmentsDir, up.path)));

  const withImg = ok(await ctx.api.post('/api/backups', { includeAttachments: true }));
  const withoutImg = ok(await ctx.api.post('/api/backups', { includeAttachments: false }));

  const namesWith = listZipEntries(fs.readFileSync(path.join(ctx.backupsDir, withImg.name)));
  const namesWithout = listZipEntries(fs.readFileSync(path.join(ctx.backupsDir, withoutImg.name)));
  assert.ok(namesWith.includes('attachments/' + up.path), '含图片时应有附件条目');
  assert.ok(!namesWithout.some((n) => n.startsWith('attachments/')), '不含图片时就不该有附件');
  assert.ok(fs.statSync(path.join(ctx.backupsDir, withoutImg.name)).size
    < fs.statSync(path.join(ctx.backupsDir, withImg.name)).size);

  // 图片还在的情况下，从「不含图片」的备份恢复 → 附件保持不动
  const kept = ok(await ctx.api.post('/api/backups/restore', { name: withoutImg.name }));
  assert.strictEqual(kept.attachmentsRestored, 'kept');
  assert.ok(fs.existsSync(path.join(ctx.attachmentsDir, up.path)));

  // 从「含图片」的备份恢复 → 附件以备份为准
  const fromBak = ok(await ctx.api.post('/api/backups/restore', { name: withImg.name }));
  assert.strictEqual(fromBak.attachmentsRestored, 'from-backup');
  assert.ok(fs.existsSync(path.join(ctx.attachmentsDir, up.path)));
});

test('M7 · 恢复：数据与备份时刻完全一致，且恢复前自动另存了当前数据', async (t) => {
  const ctx = await startApp({ rootDir: tempDir('pgroot-') });
  t.after(() => ctx.close());
  const first = await seed(ctx);
  const before = snapshot(ctx);

  const bak = ok(await ctx.api.post('/api/backups', { includeAttachments: true }));

  // 备份之后再折腾一通：加题、加卷、加学生、改分、删东西
  const q2 = ok(await ctx.api.post('/api/questions', {
    stem: '事后加的第二题', rubricType: 'text', rubricText: '说明', points: 5,
  })).question;
  const p2 = ok(await ctx.api.post('/api/papers', { name: '事后加的卷' })).paper;
  ok(await ctx.api.put('/api/papers/' + p2.id + '/questions', { questions: [{ questionId: q2.id }] }));
  ok(await ctx.api.post('/api/students', { name: '李四', className: '高一(1)班' }));
  ok(await ctx.api.post('/api/grade-sheets/1/unlock', { reason: '试试' }));

  const dirty = snapshot(ctx);
  assert.notStrictEqual(dirty.questions, before.questions);
  assert.strictEqual(dirty.confirmed, 0, '解锁后不再是已确认');

  const res = ok(await ctx.api.post('/api/backups/restore', { name: bak.name }));
  assert.strictEqual(res.restored, bak.name);
  assert.match(res.preRestore, /^pre-restore-\d{4}-\d{2}-\d{2}-\d{4}\.zip$/);
  assert.ok(fs.existsSync(path.join(ctx.backupsDir, res.preRestore)), '恢复前必须自动另存当前数据');

  assert.deepStrictEqual(snapshot(ctx), before, '恢复后数据要与备份时刻逐项一致');
  assert.strictEqual(ok(await ctx.api.get('/api/papers/' + first.paper.id)).paper.name, '备份测试卷');

  // 恢复前的另存里应该保留着「被覆盖前」的那份数据，可以再救回来
  const back = ok(await ctx.api.post('/api/backups/restore', { name: res.preRestore }));
  assert.strictEqual(back.ok, true);
  assert.strictEqual(snapshot(ctx).questions, dirty.questions, '从 pre-restore 恢复应拿回改动后的数据');
});

test('M7 · 恢复的边界：坏文件、不存在的名字、目录穿越都要挡住', async (t) => {
  const ctx = await startApp({ rootDir: tempDir('pgroot-') });
  t.after(() => ctx.close());
  await seed(ctx);

  assert.strictEqual((await ctx.api.post('/api/backups/restore', { name: 'nope-2099.zip' })).status, 404);
  assert.strictEqual((await ctx.api.post('/api/backups/restore', { name: '../config.local.json' })).status, 400);
  assert.strictEqual((await ctx.api.post('/api/backups/restore', { name: '没有这个.zip' })).status, 400);
  assert.strictEqual((await ctx.api.post('/api/backups/restore', { name: 'a/b.zip' })).status, 400);
  assert.strictEqual((await ctx.api.post('/api/backups/restore', { name: 'x.txt' })).status, 400);

  // 放一个「合法名字但内容不是本应用备份」的 zip 进去
  fs.writeFileSync(
    path.join(ctx.backupsDir, 'fake.zip'),
    createZip([{ name: 'readme.txt', data: Buffer.from('不是备份', 'utf8') }])
  );
  const fake = await ctx.api.post('/api/backups/restore', { name: 'fake.zip' });
  assert.strictEqual(fake.status, 400);
  assert.ok(fake.data.error.includes('paper.db'));

  // 坏 zip 也不该把服务搞崩
  fs.writeFileSync(path.join(ctx.backupsDir, 'broken.zip'), Buffer.from('这不是 zip'));

  // 删除：正常删掉，删不存在的报 404，非法名字报 400
  const bak = ok(await ctx.api.post('/api/backups', {}));
  ok(await ctx.api.del('/api/backups/' + bak.name));
  assert.ok(!fs.existsSync(path.join(ctx.backupsDir, bak.name)));
  assert.strictEqual((await ctx.api.del('/api/backups/' + bak.name)).status, 404);
  assert.strictEqual((await ctx.api.del('/api/backups/' + encodeURIComponent('../x.zip'))).status, 400);

  // 数据一直好用
  assert.strictEqual(ok(await ctx.api.get('/api/papers')).total, 1);
});

test('M7 · 恢复时把没跑完的批量任务置为暂停（K6）', async (t) => {
  const ctx = await startApp({ rootDir: tempDir('pgroot-') });
  t.after(() => ctx.close());
  await seed(ctx);
  const bak = ok(await ctx.api.post('/api/backups', {}));

  // 捏一条「正在跑」的批量任务出来，模拟服务被强行关掉时的残留
  getDb().prepare(
    "INSERT INTO batch_jobs(paper_id, status, total, done, failed, targets, cursor, message, created_at, updated_at) VALUES(1,'running',3,1,'[]','[1]',1,'正在批量批改…',?,?)"
  ).run(new Date().toISOString(), new Date().toISOString());

  ok(await ctx.api.post('/api/backups/restore', { name: bak.name }));
  // 备份里没有这条任务，所以先造一份带残留任务的备份再来一次
  getDb().prepare(
    "INSERT INTO batch_jobs(paper_id, status, total, done, failed, targets, cursor, message, created_at, updated_at) VALUES(1,'running',3,1,'[]','[1]',1,'正在批量批改…',?,?)"
  ).run(new Date().toISOString(), new Date().toISOString());
  const bak2 = ok(await ctx.api.post('/api/backups', {}));

  ok(await ctx.api.post('/api/backups/restore', { name: bak2.name }));
  const job = getDb().prepare('SELECT * FROM batch_jobs ORDER BY id DESC LIMIT 1').get();
  assert.strictEqual(job.status, 'paused', '恢复后残留的批量任务必须是暂停，不能自己接着跑');
  assert.ok(job.message.includes('暂停'));
});

test('M7 · 自动备份：当天只做一份，超出保留份数的从旧到新删掉', async (t) => {
  const ctx = await startApp({ rootDir: tempDir('pgroot-') });
  t.after(() => ctx.close());
  await seed(ctx);

  // configDir 必须一起传：缺了它会回退到用户真实的私有配置目录，测试就被真机配置带跑了
  const args = {
    rootDir: ctx.rootDir,
    configDir: ctx.configDir,
    storageDir: ctx.app.storageDir,
    attachmentsDir: ctx.attachmentsDir,
    dbFile: ctx.dbFile,
  };

  const first = runAutoBackup(args);
  assert.strictEqual(first.created, true);
  assert.match(first.name, /^backup-/);
  assert.strictEqual(listBackups(ctx).filter((b) => b.kind === 'backup').length, 1);

  const second = runAutoBackup(args);
  assert.strictEqual(second.created, false, '同一天第二次启动不再重复备份');
  assert.strictEqual(second.name, first.name);
  assert.strictEqual(listBackups(ctx).filter((b) => b.kind === 'backup').length, 1);

  // 关掉自动备份后就不做了
  ok(await ctx.api.put('/api/settings', { autoBackup: false }));
  const off = runAutoBackup(args);
  assert.strictEqual(off.created, false);
  assert.ok(off.reason.includes('未开启'));

  // 手动多造几份，验证只保留最近 N 份
  ok(await ctx.api.put('/api/settings', { autoBackup: true, keepBackups: 2 }));
  for (let i = 0; i < 3; i += 1) ok(await ctx.api.post('/api/backups', {}));
  const before = listBackups(ctx).filter((b) => b.kind === 'backup');
  assert.ok(before.length >= 4);

  const prune = runAutoBackup(args);
  const after = listBackups(ctx).filter((b) => b.kind === 'backup');
  assert.strictEqual(after.length, 2, '应只保留最近 2 份');
  assert.ok(prune.removed.length > 0);
  assert.deepStrictEqual(
    after.map((b) => b.name),
    before.slice(0, 2).map((b) => b.name),
    '留下的应该是最新的那几份'
  );

  // 备份文件真的落到磁盘上了
  after.forEach((b) => assert.ok(fs.existsSync(path.join(dirOf(ctx), b.name))));
});

test('M7 · 持久化：关掉服务再打开，数据一字不差', async (t) => {
  const dir = tempDir('pgpersist-');
  const dbFile = path.join(dir, 'paper.db');

  const a = await startApp({ dbFile });
  await seed(a);
  const before = snapshot(ctx2(a));
  const dbPath = getDbFile();
  await a.close();

  const b = await startApp({ dbFile });
  t.after(() => b.close());
  assert.strictEqual(getDbFile(), dbPath);
  assert.deepStrictEqual(snapshot(ctx2(b)), before, '重开后数据必须完整保留');

  // 也能通过接口看到
  assert.strictEqual(ok(await b.api.get('/api/papers')).total, 1);
  // 第 1 项被老师改成 4 分，第 2 项沿用 AI 的 1.5 分 → 5.5
  assert.strictEqual(ok(await b.api.get('/api/stats/paper/1')).overview.average, 5.5);
  assert.strictEqual(getDb().prepare('SELECT final_total FROM grade_sheets').get().final_total, 5.5);

  function ctx2(x) { return x; }
});
