'use strict';

const zlib = require('node:zlib');

const EOCD_SIG = 0x06054b50;
const CD_SIG = 0x02014b50;
const LFH_SIG = 0x04034b50;

/** 从 ZIP（docx 本质是 ZIP）中读取指定条目并返回原始字节 */
function readZipEntry(buffer, entryName) {
  const eocd = findEocd(buffer);
  if (!eocd) throw new Error('不是有效的 ZIP/docx 文件');
  const count = buffer.readUInt16LE(eocd + 10);
  let offset = buffer.readUInt32LE(eocd + 16);

  for (let i = 0; i < count; i += 1) {
    if (buffer.readUInt32LE(offset) !== CD_SIG) break;
    const method = buffer.readUInt16LE(offset + 10);
    const compressedSize = buffer.readUInt32LE(offset + 20);
    const nameLen = buffer.readUInt16LE(offset + 28);
    const extraLen = buffer.readUInt16LE(offset + 30);
    const commentLen = buffer.readUInt16LE(offset + 32);
    const localOffset = buffer.readUInt32LE(offset + 42);
    const name = buffer.slice(offset + 46, offset + 46 + nameLen).toString('utf8');

    if (name === entryName) {
      if (buffer.readUInt32LE(localOffset) !== LFH_SIG) throw new Error('ZIP 局部头损坏');
      const localNameLen = buffer.readUInt16LE(localOffset + 26);
      const localExtraLen = buffer.readUInt16LE(localOffset + 28);
      const dataStart = localOffset + 30 + localNameLen + localExtraLen;
      const data = buffer.slice(dataStart, dataStart + compressedSize);
      if (method === 0) return data;
      if (method === 8) return zlib.inflateRawSync(data);
      throw new Error('不支持的压缩方式：' + method);
    }
    offset += 46 + nameLen + extraLen + commentLen;
  }
  return null;
}

function findEocd(buffer) {
  const min = Math.max(0, buffer.length - 66000);
  for (let i = buffer.length - 22; i >= min; i -= 1) {
    if (buffer.readUInt32LE(i) === EOCD_SIG) return i;
  }
  return -1;
}

/** 列出 ZIP 中央目录里的全部条目名 */
function listZipEntries(buffer) {
  const eocd = findEocd(buffer);
  if (eocd < 0) return [];
  const count = buffer.readUInt16LE(eocd + 10);
  let offset = buffer.readUInt32LE(eocd + 16);
  const names = [];
  for (let i = 0; i < count && offset + 46 <= buffer.length; i += 1) {
    if (buffer.readUInt32LE(offset) !== CD_SIG) break;
    const nameLen = buffer.readUInt16LE(offset + 28);
    const extraLen = buffer.readUInt16LE(offset + 30);
    const commentLen = buffer.readUInt16LE(offset + 32);
    names.push(buffer.toString('utf8', offset + 46, offset + 46 + nameLen));
    offset += 46 + nameLen + extraLen + commentLen;
  }
  return names;
}

/** 从 docx 里抽取纯文本（按段落拼接） */
function docxToText(buffer) {
  const xmlBuf = readZipEntry(buffer, 'word/document.xml');
  if (!xmlBuf) throw new Error('docx 里找不到 word/document.xml');
  const xml = xmlBuf.toString('utf8');
  const paragraphs = xml.split(/<\/w:p>/);
  const lines = paragraphs.map((p) => {
    const parts = [...p.matchAll(/<w:t[^>]*>([\s\S]*?)<\/w:t>/g)].map((m) => decodeXml(m[1]));
    return parts.join('');
  }).filter((line) => line.trim() !== '');
  return lines.join('\n');
}

function decodeXml(s) {
  return s
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, '&');
}

/**
 * 把一段文本按「1.」「第 2 题」等题号标记切成块。
 *
 * 每块可以带一个「来自第几张照片」的标记：识别整卷连拍时，AI 会在题号后写
 * 「（图2）」，说明这一题的内容出现在第 2 张照片里。批改时据此把原图挂到对应题目上，
 * 否则一组照片拆出来的文字就没法跟图片对上号了。
 */
function splitBlocks(text) {
  const lines = String(text || '').split(/\r?\n/);
  const blocks = [];
  let cur = null;
  const marker = /^\s*(?:第\s*)?(\d{1,2})\s*[题、.．:：)）]\s*(.*)$/;
  // 只认带括号的写法，免得把「图 2 所示的受力分析」这种正文误当成标记吃掉
  const photoTag = /^[（(\[【]\s*(?:第\s*)?(?:图|照片)\s*(\d{1,2})\s*(?:张)?\s*[）)\]】]\s*[：:、.．-]?\s*/;
  lines.forEach((line) => {
    const m = line.match(marker);
    if (m) {
      if (cur && cur.text.trim()) blocks.push(cur);
      let rest = m[2] || '';
      let image = null;
      const tag = rest.match(photoTag);
      if (tag) {
        image = Number(tag[1]);
        rest = rest.slice(tag[0].length);
      }
      cur = { label: m[1], text: rest.trim(), image };
    } else if (cur) {
      cur.text += (cur.text ? '\n' : '') + line;
    }
  });
  if (cur && cur.text.trim()) blocks.push(cur);
  if (!blocks.length && String(text || '').trim()) {
    blocks.push({ label: '', text: String(text).trim(), image: null });
  }
  return blocks;
}

module.exports = { readZipEntry, listZipEntries, docxToText, splitBlocks };
