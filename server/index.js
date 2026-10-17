'use strict';

const path = require('node:path');
const { spawn } = require('node:child_process');
const { createApp } = require('./app');
const {
  loadFileConfig, DATA_FILE_KEY, defaultConfigDir, configFileOf, migrateLegacyConfig,
} = require('./config');
const { runAutoBackup } = require('./routes/backup');

// 代码所在目录（web/ 也在这里，静态资源永远从这儿取）
const CODE_DIR = path.join(__dirname, '..');
// 应用使用的「项目目录」：默认就是代码目录；测试可以用 APP_ROOT_DIR 指向临时目录，
// 这样测试进程做配置迁移时绝不会碰到用户真实的项目目录。
const ROOT_DIR = process.env.APP_ROOT_DIR ? path.resolve(process.env.APP_ROOT_DIR) : CODE_DIR;
const START_PORT = Number(process.env.PORT || 8756);

/** 数据文件位置：环境变量 > 私有配置文件 > data/paper.db */
function resolveDbFile(configDir) {
  if (process.env.APP_DB_FILE) return process.env.APP_DB_FILE;
  const cfg = loadFileConfig(configDir);
  if (cfg[DATA_FILE_KEY]) {
    const p = String(cfg[DATA_FILE_KEY]);
    return path.isAbsolute(p) ? p : path.join(ROOT_DIR, p);
  }
  return path.join(ROOT_DIR, 'data', 'paper.db');
}

function openBrowser(url) {
  try {
    if (process.platform === 'win32') {
      spawn('cmd', ['/c', 'start', '', url], { detached: true, stdio: 'ignore' }).unref();
    } else if (process.platform === 'darwin') {
      spawn('open', [url], { detached: true, stdio: 'ignore' }).unref();
    } else {
      spawn('xdg-open', [url], { detached: true, stdio: 'ignore' }).unref();
    }
  } catch (_) {
    /* 打不开浏览器不影响服务运行 */
  }
}

/** 需要 Node 22.5+：内置的 node:sqlite 从那时起才有，本应用全靠它存数据 */
const MIN_NODE = { major: 22, minor: 5 };

/** 版本够用返回 null，不够用返回一句能看懂的中文说明（version 可传，便于测试） */
function nodeVersionProblem(version) {
  const parts = String(version || process.versions.node || '0.0.0').split('.').map((n) => Number(n) || 0);
  const major = parts[0];
  const minor = parts[1];
  if (major > MIN_NODE.major) return null;
  if (major === MIN_NODE.major && minor >= MIN_NODE.minor) return null;
  return `当前 Node.js 版本是 v${parts.join('.')}，本应用需要 Node.js ${MIN_NODE.major}.${MIN_NODE.minor} 或更高版本（用到内置的 sqlite）。`;
}

async function main() {
  const problem = nodeVersionProblem();
  if (problem) {
    console.error('');
    console.error('无法启动：' + problem);
    console.error('请到 https://nodejs.org 装一个较新的 Node.js（推荐 22 LTS 或更高），然后重新双击启动。');
    console.error('');
    process.exit(1);
    return;
  }

  const configDir = defaultConfigDir();
  // 老版本把配置写在项目目录里：先搬走，才能按新位置读到数据文件路径
  const migration = migrateLegacyConfig(ROOT_DIR, configDir);
  const dbFile = resolveDbFile(configDir);
  const app = createApp({
    rootDir: ROOT_DIR,
    webDir: path.join(CODE_DIR, 'web'),
    dbFile,
    configDir,
  });
  const port = await app.listen(START_PORT);
  const url = `http://127.0.0.1:${port}`;
  const attachmentsDir = app.attachmentsDir;

  let auto = null;
  try {
    auto = runAutoBackup({ rootDir: ROOT_DIR, configDir, storageDir: app.storageDir, attachmentsDir, dbFile });
  } catch (err) {
    auto = { created: false, reason: err && err.message ? err.message : String(err) };
  }

  console.log('');
  console.log('==============================================');
  console.log('  试卷批改专属 App 已启动');
  console.log('----------------------------------------------');
  console.log(`  访问地址：${url}`);
  console.log(`  数据文件：${app.dbFile}`);
  console.log(`  图片目录：${attachmentsDir}`);
  console.log(`  备份目录：${path.join(app.storageDir, 'backups')}`);
  console.log(`  配置文件：${configFileOf(configDir)}`);
  console.log('            （API Key 只存在这里，不在项目文件夹、不在数据文件、不进备份包）');
  if (migration.migrated) console.log(`  已把旧配置搬到私有目录：${migration.to}`);
  if (auto && auto.created) console.log(`  今日自动备份：${auto.name}`);
  console.log('  关闭本窗口即停止服务（数据已实时保存）');
  console.log('==============================================');
  console.log('');

  if (process.env.NO_OPEN !== '1') openBrowser(url);

  const shutdown = async () => {
    console.log('\n正在保存并关闭…');
    try {
      await app.close();
    } catch (_) {
      /* ignore */
    }
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

if (require.main === module) {
  main().catch((err) => {
    console.error('启动失败：', err && err.message ? err.message : err);
    process.exit(1);
  });
}

module.exports = { main, resolveDbFile, nodeVersionProblem };
