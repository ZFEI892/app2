'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { get, getDb, run } = require('./db');

const DEFAULTS = {
  baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
  model: 'qwen3.8-max-0902',
  apiKey: '',
  aiTimeoutMs: 600000,
  // 批改不需要深度思考：qwen3.8-max 这类旗舰模型默认开最高档思考(xhigh)，
  // 会先憋一大段思维链，一张图能跑 170 秒、多张图直接超时/断连。
  // 固定为 'none' 关掉思考，批改立刻快起来（实测 3 张图 7.5s）。留空则交给模型默认。
  reasoningEffort: 'none',
  aiDelayMs: 0,
  doubtThreshold: 0.75,
  autoBackup: true,
  keepBackups: 7,
};

/** 数据文件位置只能放在本地配置文件里（它本身就是数据库文件，不能存进数据库） */
const DATA_FILE_KEY = 'dbFile';

/**
 * 本地私有配置放在**项目文件夹之外**（用户主目录下的私有目录）。
 * 这样 API Key 永远不跟代码待在一起：把项目文件夹发给别人、传网盘、
 * 上传代码仓库，都不会把 Key 带出去。
 */
const CONFIG_DIR_NAME = '.paper-grading';
const CONFIG_FILE_NAME = 'config.local.json';

/** 私有配置目录：环境变量 > 用户主目录下的私有目录 */
function defaultConfigDir() {
  if (process.env.APP_CONFIG_DIR) return path.resolve(process.env.APP_CONFIG_DIR);
  return path.join(os.homedir(), CONFIG_DIR_NAME);
}

function configFileOf(configDir) {
  return path.join(configDir || defaultConfigDir(), CONFIG_FILE_NAME);
}

/** 读取私有配置文件（读不到就给空对象，不影响启动） */
function loadFileConfig(configDir) {
  try {
    const raw = fs.readFileSync(configFileOf(configDir), 'utf8');
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch (_) {
    return {};
  }
}

/**
 * 把补丁合并写回私有配置文件（保留已有的 Key 等字段）。
 * 用 0600 权限写，尽量只让当前用户（非管理员）能读。
 */
function writeFileConfig(configDir, patch) {
  const dir = configDir || defaultConfigDir();
  const merged = { ...loadFileConfig(dir), ...patch };
  Object.keys(merged).forEach((k) => {
    if (merged[k] === null || merged[k] === undefined) delete merged[k];
  });
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(configFileOf(dir), JSON.stringify(merged, null, 2) + '\n', {
    encoding: 'utf8',
    mode: 0o600,
  });
  return merged;
}

/**
 * 老版本把配置文件写在项目根目录里。这里把它搬到私有目录并删掉原件。
 * 私有目录里已有的键优先（绝不覆盖用户现有 Key），旧文件里独有的键补进来。
 * 搬运失败只记录、不抛错——不能因为配置搬家把服务卡住。
 */
function migrateLegacyConfig(rootDir, configDir) {
  if (!rootDir) return { migrated: false, reason: '未指定项目目录' };
  const legacy = path.join(rootDir, CONFIG_FILE_NAME);
  const target = configFileOf(configDir);
  if (path.resolve(legacy) === path.resolve(target)) return { migrated: false, reason: '同一个位置' };
  if (!fs.existsSync(legacy)) return { migrated: false, reason: '没有旧配置文件' };
  try {
    const legacyCfg = JSON.parse(fs.readFileSync(legacy, 'utf8'));
    const merged = { ...legacyCfg, ...loadFileConfig(configDir) };
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, JSON.stringify(merged, null, 2) + '\n', { encoding: 'utf8', mode: 0o600 });
    // 确认新位置读得回来、内容一致，再删旧文件，避免搬一半丢配置
    const check = JSON.parse(fs.readFileSync(target, 'utf8'));
    if (JSON.stringify(check) !== JSON.stringify(merged)) throw new Error('搬运后校验不一致');
    fs.unlinkSync(legacy);
    return { migrated: true, from: legacy, to: target };
  } catch (err) {
    return { migrated: false, reason: err && err.message ? err.message : String(err) };
  }
}

/**
 * 老版本会把 API Key 存进数据库的 settings 表，而备份包会把整个数据文件打包，
 * Key 就跟着备份 zip 跑到别处去了。这里统一清掉：Key 只认私有配置文件。
 * 删完顺手 VACUUM 一次，把旧数据页重写掉，免得用文本工具还能从数据文件里捞出 Key。
 */
function removeKeyFromDb() {
  try {
    const info = run("DELETE FROM settings WHERE key = 'ai_api_key'");
    const removed = Number(info && info.changes ? info.changes : 0) > 0;
    if (removed) {
      try {
        getDb().exec('VACUUM');
      } catch (_) { /* 库正忙时跳过，不影响功能 */ }
    }
    return { removed };
  } catch (_) {
    return { removed: false };
  }
}

/**
 * 生效配置 = 默认值 ← 私有配置文件 ← 数据库 settings 表
 * （settings 表优先级最高，即用户在设置页改过的值）
 * 注意：apiKey 不在数据库那一档——它只从私有配置文件读，绝不进数据文件。
 */
function effectiveConfig(configDir) {
  const fileCfg = loadFileConfig(configDir);
  const merged = { ...DEFAULTS, ...fileCfg };
  const dbKeys = {
    baseUrl: ['ai_base_url', 'string'],
    model: ['ai_model', 'string'],
    aiDelayMs: ['ai_delay_ms', 'number'],
    doubtThreshold: ['ai_doubt_threshold', 'number'],
    autoBackup: ['backup_auto', 'bool'],
    keepBackups: ['backup_keep', 'number'],
  };
  for (const [field, spec] of Object.entries(dbKeys)) {
    const key = spec[0];
    const kind = spec[1];
    const v = get('SELECT value FROM settings WHERE key = ?', key);
    if (!v || v.value === '' || v.value === null || v.value === undefined) continue;
    if (kind === 'number') {
      const n = Number(v.value);
      if (Number.isFinite(n)) merged[field] = n;
    } else if (kind === 'bool') {
      merged[field] = v.value === '1' || v.value === 'true';
    } else {
      merged[field] = v.value;
    }
  }
  return merged;
}

/** 脱敏：仅保留尾部 4 位 */
function maskKey(key) {
  if (!key) return '';
  const s = String(key);
  if (s.length <= 4) return '****';
  return '****' + s.slice(-4);
}

/** 给前端看的设置对象：永不回传明文 Key */
function publicSettings(configDir) {
  const cfg = effectiveConfig(configDir);
  return {
    baseUrl: cfg.baseUrl,
    model: cfg.model,
    apiKeyMasked: maskKey(cfg.apiKey),
    apiKeySet: Boolean(cfg.apiKey),
    aiDelayMs: cfg.aiDelayMs,
    doubtThreshold: cfg.doubtThreshold,
    autoBackup: cfg.autoBackup !== false,
    keepBackups: cfg.keepBackups || DEFAULTS.keepBackups,
    configFile: configFileOf(configDir),
  };
}

/** 供 AI 调用使用的完整配置（含明文 Key），仅服务端内部使用 */
function aiConfig(configDir) {
  const cfg = effectiveConfig(configDir);
  return {
    baseUrl: cfg.baseUrl,
    model: cfg.model,
    apiKey: cfg.apiKey,
    timeoutMs: cfg.aiTimeoutMs,
    reasoningEffort: cfg.reasoningEffort,
  };
}

module.exports = {
  DEFAULTS,
  DATA_FILE_KEY,
  CONFIG_DIR_NAME,
  CONFIG_FILE_NAME,
  defaultConfigDir,
  configFileOf,
  migrateLegacyConfig,
  removeKeyFromDb,
  loadFileConfig,
  writeFileConfig,
  effectiveConfig,
  maskKey,
  publicSettings,
  aiConfig,
};
