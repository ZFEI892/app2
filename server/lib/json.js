'use strict';

/**
 * 容错 JSON 解析：AI 返回的内容常带 ``` 围栏或前后闲话，
 * 这里逐层剥离，尽量取出第一个完整的 JSON 值。
 */
function parseLoose(text) {
  if (text === null || text === undefined) return null;
  let s = String(text).trim();
  if (!s) return null;

  // 去掉 markdown 代码围栏
  const fence = s.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fence) s = fence[1].trim();

  const direct = tryParse(s);
  if (direct !== null) return direct;

  // 从第一个 { 或 [ 开始做括号配平截取
  const startIdx = firstIndexOfAny(s, ['{', '[']);
  if (startIdx < 0) return null;
  const open = s[startIdx];
  const close = open === '{' ? '}' : ']';
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = startIdx; i < s.length; i += 1) {
    const ch = s[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === '\\') escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') { inString = true; continue; }
    if (ch === open) depth += 1;
    else if (ch === close) {
      depth -= 1;
      if (depth === 0) {
        return tryParse(s.slice(startIdx, i + 1));
      }
    }
  }
  return null;
}

function tryParse(s) {
  try {
    const v = JSON.parse(s);
    return v === undefined ? null : v;
  } catch (_) {
    return null;
  }
}

function firstIndexOfAny(s, chars) {
  let best = -1;
  chars.forEach((c) => {
    const i = s.indexOf(c);
    if (i >= 0 && (best < 0 || i < best)) best = i;
  });
  return best;
}

/** 从提示词里的机器可读块中取回 JSON（mock 与调试用） */
function extractPayload(text) {
  const m = String(text || '').match(/<<<PAYLOAD\s*([\s\S]*?)\s*PAYLOAD>>>/);
  if (!m) return null;
  return tryParse(m[1]);
}

function payloadBlock(obj) {
  return '<<<PAYLOAD\n' + JSON.stringify(obj) + '\nPAYLOAD>>>';
}

module.exports = { parseLoose, extractPayload, payloadBlock };
