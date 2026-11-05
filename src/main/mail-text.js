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

module.exports = { makeSnippet, findTextPart, hasAttachments, htmlToText, guessSpecial, sortFolders, SPECIAL_NAMES };
