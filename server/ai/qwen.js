'use strict';

const { HttpError } = require('../router');
const { aiConfig } = require('../config');
const { extractPayload, payloadBlock } = require('../lib/json');

/** 真实调用千问（OpenAI 兼容接口） */
async function qwenChat(messages, cfg) {
  const base = String(cfg.baseUrl || '').replace(/\/+$/, '');
  if (!base) throw new HttpError(400, '尚未配置接口地址，请先到「设置」填写');
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), cfg.timeoutMs || 600000);
  let res;
  try {
    const body = { model: cfg.model, messages, temperature: 0 };
    // 关掉深度思考（reasoning_effort=none）：批改不需要思考链，
    // 否则 qwen3.8-max 这类旗舰模型默认最高档思考，一张图能跑好几分钟。
    if (cfg.reasoningEffort) body.reasoning_effort = cfg.reasoningEffort;
    res = await fetch(base + '/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: 'Bearer ' + cfg.apiKey,
      },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
  } catch (err) {
    clearTimeout(timer);
    if (controller.signal.aborted) {
      throw new HttpError(502, 'AI 处理超时。若批改的是照片，多半是照片太大/张数太多，请减少张数或重新上传（会自动压小）。');
    }
    throw new HttpError(502, '无法连接 AI 服务：网络中断或连接被断开（批改大照片时也可能发生）。请检查网络，或减少照片张数后重试。');
  }
  clearTimeout(timer);

  const raw = await res.text();
  if (!res.ok) {
    let detail = raw.slice(0, 300);
    try {
      const j = JSON.parse(raw);
      if (j && j.error && j.error.message) detail = j.error.message;
    } catch (_) { /* 保留原始文本 */ }
    throw new HttpError(502, 'AI 服务返回错误：' + detail);
  }
  let data;
  try {
    data = JSON.parse(raw);
  } catch (_) {
    throw new HttpError(502, 'AI 返回的内容无法解析');
  }
  const content = data && data.choices && data.choices[0] && data.choices[0].message
    ? data.choices[0].message.content
    : null;
  if (!content) throw new HttpError(502, 'AI 没有返回内容');
  return content;
}

/**
 * 模拟 AI：不联网，从提示词里的机器可读块读出任务与数据，产出确定性结果。
 * 用途：自动化测试与无网演示。生产环境（aiMode=live）不会走到这里。
 */
async function mockChat(messages) {
  const reversed = [...messages].reverse();
  // 多模态消息的正文在 content 数组的 text 段里；纯文本消息则直接在 content 上。
  // 优先取多模态正文，其次取最后一条纯文本消息（不要把 system 提示词当成正文）。
  const multimodal = reversed.find((m) => Array.isArray(m.content));
  const textPart = multimodal ? multimodal.content.find((p) => p.type === 'text') : null;
  const lastString = reversed.find((m) => typeof m.content === 'string');
  const payload = extractPayload(textPart ? textPart.text : '')
    || extractPayload(lastString ? lastString.content : '');
  if (!payload) return '{}';

  if (payload.task === 'grade') {
    const items = Array.isArray(payload.items) ? payload.items : [];
    return JSON.stringify({
      items: items.map((it, idx) => ({
        index: it.index === undefined ? idx : it.index,
        score: Math.round(Number(it.points || 0) * 0.75 * 2) / 2,
        reason: `依据评分标准「${it.text}」判断：作答基本符合该条要求。`,
        confidence: 0.9,
      })),
      comment: '整体思路清晰，个别步骤可再严谨。',
    });
  }
  if (payload.task === 'grade_whole') {
    // 整卷：模拟两道错题，每题扣满分的 1/8，合计扣 1/4 → 得 75% 满分（测试好算）。
    // 扣分参与总分：grader 会用「满分 − 各错题 deduct 之和」算总分。
    const full = Number(payload.fullMarks) || 0;
    const d1 = full / 8;
    const d2 = full / 8;
    return JSON.stringify({
      score: Math.round((full - d1 - d2) * 2) / 2,
      reason: '整份卷子看下来：主要步骤都写了，思路基本正确；个别地方推导不够严谨、单位有遗漏，按整卷扣分。',
      confidence: 0.9,
      comment: '整体不错，注意推导过程的严谨性。',
      // 错题清单：题号 + 扣分 + 错在哪
      wrong: [
        { no: '2', deduct: d1, where: '第 2 步受力分析', issue: '摩擦力方向标反了，导致合外力算错' },
        { no: '4', deduct: d2, where: '最后一问的单位', issue: '写成 N，应为 N/kg' },
      ],
    });
  }
  if (payload.task === 'ocr') {
    // 跟真实提示词同一个格式约定：题号后面带上「这一题来自第几张照片」
    const count = Math.max(1, Number(payload.imageCount) || 1);
    return [
      '第1题（图' + Math.min(1, count) + '） ' + (payload.hintText || '由图片识别出的作答内容'),
      '第2题（图' + Math.min(2, count) + '） 识别出的第二题作答内容',
    ].join('\n');
  }
  if (payload.task === 'allocate') {
    // 模拟「按权重分配」：权重按 1,2,3… 递增（越靠后的题占分越多），总和凑成整卷总分。
    // 这样测试能确定性地断言「不是平均分、且总和=总分」。
    const qs = Array.isArray(payload.questions) ? payload.questions : [];
    const full = Number(payload.fullMarks) || 0;
    const n = qs.length;
    if (!n) return '{"allocations":[]}';
    const weights = qs.map((_, i) => i + 1);
    const wsum = weights.reduce((a, b) => a + b, 0);
    const allocations = qs.map((q, i) => ({
      seq: q.seq,
      points: Math.round(full * weights[i] / wsum * 2) / 2,
    }));
    const allocSum = allocations.reduce((a, b) => a + b.points, 0);
    allocations[allocations.length - 1].points =
      Math.round((allocations[allocations.length - 1].points + (full - allocSum)) * 2) / 2;
    return JSON.stringify({ allocations });
  }
  return '{}';
}

/**
 * 统一入口：优先用测试注入的实现，其次模拟，最后真实调用。
 */
async function runChat(ctx, messages) {
  const cfg = aiConfig(ctx.configDir);
  if (typeof ctx.aiChat === 'function') {
    return ctx.aiChat(messages, cfg);
  }
  if (ctx.aiMode === 'mock') {
    return mockChat(messages);
  }
  if (!cfg.apiKey) {
    throw new HttpError(400, '尚未配置 API Key，请先到「设置」页填写并保存');
  }
  return qwenChat(messages, cfg);
}

/** 测试连通性：真实模式下发一次极短的请求 */
async function testConnection(configDir) {
  const cfg = aiConfig(configDir);
  if (!cfg.apiKey) {
    return { ok: false, reason: '尚未配置 API Key' };
  }
  try {
    const reply = await qwenChat(
      [{ role: 'user', content: '回复两个字：收到' }],
      { ...cfg, timeoutMs: 30000 }
    );
    return { ok: true, reply: String(reply).trim().slice(0, 40), model: cfg.model };
  } catch (err) {
    return { ok: false, reason: err.message };
  }
}

module.exports = { qwenChat, mockChat, runChat, testConnection, payloadBlock };
