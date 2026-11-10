// 邮件文本小工具：解码正文片段生成预览、判断附件、文件夹排序与中文名。
const iconv = require('iconv-lite');

function decodeTransfer(buf, encoding) {
  const enc = String(encoding || '').toLowerCase();
  if (enc === 'base64') {
    let s = buf.toString('ascii').replace(/[^A-Za-z0-9+/=]/g, '');
    s = s.slice(0, s.length - (s.length % 4));
    return Buffer.from(s, 'base64');
  }
  if (enc === 'quoted-printable') {
    const s = buf.toString('binary').replace(/=\r?\n/g, '');
    const out = [];
    for (let i = 0; i < s.length; i++) {
      if (s[i] === '=' && /^[0-9A-Fa-f]{2}$/.test(s.substr(i + 1, 2))) {
        out.push(parseInt(s.substr(i + 1, 2), 16));
        i += 2;
      } else out.push(s.charCodeAt(i) & 0xff);
    }
    return Buffer.from(out);
  }
  return buf;
}

function decodeCharset(buf, charset) {
  let cs = String(charset || 'utf-8').toLowerCase();
  if (cs === 'gb2312' || cs === 'gbk') cs = 'gb18030';
  try {
    if (iconv.encodingExists(cs)) return iconv.decode(buf, cs);
  } catch {}
  return buf.toString('utf8');
}

const ENTITIES = { nbsp: ' ', amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", '#39': "'", zwnj: '', zwj: '' };

function htmlToText(html) {
  return String(html)
    .replace(/<(style|script|head|title)[^>]*>[\s\S]*?(<\/\1>|$)/gi, ' ')
    .replace(/<!--[\s\S]*?(-->|$)/g, ' ')
    .replace(/<br\s*\/?>|<\/(p|div|tr|li|h\d)>/gi, '\n')
    .replace(/<[^>]*>?/g, ' ')
    .replace(/&(#x?[0-9a-f]+|\w+);/gi, (m, e) => {
      if (e[0] === '#') {
        const n = e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
        return Number.isFinite(n) && n > 0 && n < 0x110000 ? String.fromCodePoint(n) : ' ';
      }
      return ENTITIES[e.toLowerCase()] ?? m;
    });
}

function makeSnippet(buf, part) {
  let text = decodeCharset(decodeTransfer(buf, part.encoding), part.charset);
  if (part.html) text = htmlToText(text);
  return text
    .replace(/�+$/, '')
    .replace(/[​-‍﻿͏­]/g, '')
    .replace(/^>.*$/gm, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 180);
}

// 在 bodyStructure 里找用来做预览的正文：优先 text/plain，其次 text/html
function findTextPart(node) {
  let html = null;
  const walk = (n) => {
    if (!n) return null;
    if (n.childNodes && n.childNodes.length) {
      for (const c of n.childNodes) {
        const r = walk(c);
        if (r) return r;
      }
      return null;
    }
    if (n.disposition === 'attachment') return null;
    const part = n.part || '1';
    const info = { key: part, encoding: n.encoding, charset: n.parameters && n.parameters.charset };
    if (n.type === 'text/plain') return info;
    if (n.type === 'text/html' && !html) html = { ...info, html: true };
    return null;
  };
  return walk(node) || html;
}

function hasAttachments(node) {
  if (!node) return false;
  if (node.childNodes && node.childNodes.length) return node.childNodes.some(hasAttachments);
  if (node.disposition === 'attachment') return true;
  const name = (node.dispositionParameters && node.dispositionParameters.filename) || (node.parameters && node.parameters.name);
  if (name && !/^text\//.test(node.type) && !(node.disposition === 'inline' && node.id)) return true;
  return false;
}

// ---------- 大邮件的“精简版” ----------
// 带大附件的邮件，打开时不需要把附件也下回来。做法：照着服务器给的结构，只取正文和内嵌小图，
// 附件位置放一个空壳（原来的头 + 空内容），拼回一封结构相同的小邮件，后面照常解析。
const LITE_SAVE_MIN = 256 * 1024; // 省不下这么多就不折腾，直接下整封
const LITE_KEEP_SMALL = 4096; // 这么小的部分顺手带上
const LITE_INLINE_MAX = 3 * 1024 * 1024; // 单张内嵌图片上限
const LITE_INLINE_TOTAL = 8 * 1024 * 1024; // 内嵌图片合计上限
const LITE_EMBEDDED_MAX = 1024 * 1024; // 内嵌的转发邮件：小的整个带上，大的不做精简

const isMultipart = (n) => /^multipart\//.test(n.type || '') && Array.isArray(n.childNodes);

// 返回 { root, keys, skip }；不值得或没把握做精简时返回 null
function litePlan(root) {
  if (!root || !isMultipart(root)) return null;
  const keys = [];
  const skip = new Set();
  let saved = 0;
  let inlineLeft = LITE_INLINE_TOTAL;
  let ok = true;
  const walk = (n) => {
    if (!n.part) return (ok = false);
    keys.push(n.part + '.MIME');
    if (isMultipart(n)) {
      if (!n.parameters || !n.parameters.boundary) return (ok = false);
      return n.childNodes.forEach(walk);
    }
    const size = n.size || 0;
    const attached = n.disposition === 'attachment';
    let keep = size <= LITE_KEEP_SMALL;
    if (/^text\/(plain|html)$/.test(n.type) && !attached) keep = true;
    // 带 Content-ID 的内嵌图片多半是正文里引用的，先带上。
    // 这里猜漏了也没关系：读信时发现正文引用了空壳，会再补下
    if (/^image\//.test(n.type) && n.id && !attached && size <= LITE_INLINE_MAX && size <= inlineLeft) {
      keep = true;
      inlineLeft -= size;
    }
    if (n.type === 'message/rfc822' && n.disposition === 'inline') {
      // 解析时会展开成正文的一部分，空壳会丢内容
      if (size > LITE_EMBEDDED_MAX) return (ok = false);
      keep = true;
    }
    if (keep) keys.push(n.part);
    else {
      skip.add(n.part);
      saved += size;
    }
  };
  if (!root.parameters || !root.parameters.boundary) return null;
  root.childNodes.forEach(walk);
  return ok && saved >= LITE_SAVE_MIN ? { root, keys, skip } : null;
}

// 附件解码后大概多大（服务器报的是编码后的大小）
function decodedSize(n) {
  const size = n.size || 0;
  return String(n.encoding || '').toLowerCase() === 'base64' ? Math.round((size * 57) / 78) : size;
}

const CRLF = Buffer.from('\r\n');

// res：一次 FETCH 的结果（headers = 整封邮件的头，bodyParts = 各部分的头和内容）。缺东西时返回 null
function buildLite(plan, res) {
  const parts = new Map();
  for (const [k, v] of res.bodyParts || []) parts.set(String(k).toLowerCase(), v);
  if (!res.headers || !res.headers.length) return null;
  const out = [];
  let ok = true;
  // 头部去掉结尾的空行，方便补自己的标记；最后统一加回空行
  const head = (buf, extra = '') => {
    let end = buf.length;
    while (end > 0 && (buf[end - 1] === 10 || buf[end - 1] === 13)) end--;
    out.push(buf.subarray(0, end), CRLF, Buffer.from(extra, 'ascii'), CRLF);
  };
  const body = (n) => {
    if (isMultipart(n)) {
      const b = n.parameters.boundary;
      for (const c of n.childNodes) {
        out.push(Buffer.from(`--${b}\r\n`, 'binary'));
        const mime = parts.get(c.part.toLowerCase() + '.mime');
        if (!mime) return (ok = false);
        if (plan.skip.has(c.part)) {
          head(mime, `X-Huiyou-Part: ${c.part}\r\nX-Huiyou-Size: ${decodedSize(c)}\r\n`);
        } else {
          head(mime);
          body(c);
        }
        out.push(CRLF);
      }
      out.push(Buffer.from(`--${b}--\r\n`, 'binary'));
      return;
    }
    const content = parts.get(n.part.toLowerCase());
    if (!content && (n.size || 0) > 0) return (ok = false);
    if (content) out.push(content);
  };
  head(res.headers);
  body(plan.root);
  return ok ? Buffer.concat(out) : null;
}

// 把单独下载的附件解码成原始内容
function decodePart(buf, encoding) {
  const enc = String(encoding || '').trim().toLowerCase();
  if (enc === 'base64') return Buffer.from(buf.toString('latin1'), 'base64');
  if (enc === 'quoted-printable') return require('libqp').decode(buf.toString('latin1'));
  return buf;
}

const SPECIAL_NAMES = {
  '\\Inbox': '收件箱',
  '\\Drafts': '草稿箱',
  '\\Sent': '已发送',
  '\\Archive': '归档',
  '\\All': '所有邮件',
  '\\Flagged': '已加星标',
  '\\Important': '重要',
  '\\Junk': '垃圾邮件',
  '\\Trash': '已删除',
};
const SPECIAL_ORDER = ['\\Inbox', '\\Drafts', '\\Sent', '\\Archive', '\\All', '\\Junk', '\\Trash'];

// 部分国内邮箱不报告 SPECIAL-USE，按名字兜底
const NAME_GUESS = [
  [/^(sent|sent messages|sent items|已发送|已发送邮件)$/i, '\\Sent'],
  [/^(drafts?|草稿箱|草稿)$/i, '\\Drafts'],
  [/^(trash|deleted|deleted messages|deleted items|已删除|已删除邮件)$/i, '\\Trash'],
  [/^(junk|spam|junk e-?mail|bulk mail|垃圾邮件|垃圾箱)$/i, '\\Junk'],
  [/^(archive|archives|归档)$/i, '\\Archive'],
];

function guessSpecial(folder) {
  if (folder.specialUse) return folder.specialUse;
  if (folder.path.toUpperCase() === 'INBOX') return '\\Inbox';
  for (const [re, use] of NAME_GUESS) if (re.test(folder.name)) return use;
  return null;
}

function sortFolders(list) {
  const rank = (f) => {
    const i = SPECIAL_ORDER.indexOf(f.specialUse);
    return i >= 0 ? i : f.specialUse ? 50 : 100;
  };
  return list.sort((a, b) => rank(a) - rank(b) || a.path.localeCompare(b.path, 'zh-CN'));
}

module.exports = { makeSnippet, findTextPart, hasAttachments, htmlToText, guessSpecial, sortFolders, SPECIAL_NAMES, litePlan, buildLite, decodePart };
