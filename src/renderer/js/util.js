// 通用小工具
export const $ = (sel, root = document) => root.querySelector(sel);
export const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

export function h(html) {
  const t = document.createElement('template');
  t.innerHTML = html.trim();
  return t.content.firstElementChild;
}

export function escapeHtml(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
}

export function debounce(fn, ms) {
  let t;
  return (...a) => {
    clearTimeout(t);
    t = setTimeout(() => fn(...a), ms);
  };
}

// 极简事件总线
const handlers = new Map();
export const bus = {
  on(ev, fn) {
    if (!handlers.has(ev)) handlers.set(ev, new Set());
    handlers.get(ev).add(fn);
    return () => handlers.get(ev).delete(fn);
  },
  emit(ev, payload) {
    (handlers.get(ev) || []).forEach((fn) => fn(payload));
  },
};

const WEEK = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'];
const pad = (n) => String(n).padStart(2, '0');
const startOfDay = (d) => new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();

// 列表里的短日期
export function shortDate(ts) {
  const d = new Date(ts);
  const now = new Date();
  const today = startOfDay(now);
  if (ts >= today) return `${pad(d.getHours())}:${pad(d.getMinutes())}`;
  if (ts >= today - 86400000) return '昨天';
  if (ts >= today - 6 * 86400000) return WEEK[d.getDay()];
  if (d.getFullYear() === now.getFullYear()) return `${d.getMonth() + 1}月${d.getDate()}日`;
  return `${d.getFullYear()}/${d.getMonth() + 1}/${d.getDate()}`;
}

// 阅读区的完整日期
export function longDate(ts) {
  const d = new Date(ts);
  const now = new Date();
  const time = `${pad(d.getHours())}:${pad(d.getMinutes())}`;
  const day = startOfDay(d);
  const today = startOfDay(now);
  if (day === today) return `今天 ${time}`;
  if (day === today - 86400000) return `昨天 ${time}`;
  const year = d.getFullYear() === now.getFullYear() ? '' : `${d.getFullYear()}年`;
  return `${year}${d.getMonth() + 1}月${d.getDate()}日 ${WEEK[d.getDay()]} ${time}`;
}

// 列表分组标题
export function dayGroup(ts) {
  const now = new Date();
  const today = startOfDay(now);
  if (ts >= today) return '今天';
  if (ts >= today - 86400000) return '昨天';
  if (ts >= today - 6 * 86400000) return '本周';
  if (ts >= today - 30 * 86400000) return '最近一个月';
  const d = new Date(ts);
  if (d.getFullYear() === now.getFullYear()) return `${d.getMonth() + 1}月`;
  return `${d.getFullYear()}年`;
}

export function fmtSize(n) {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(n < 10240 ? 1 : 0)} KB`;
  if (n < 1024 * 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)} MB`;
  return `${(n / 1024 / 1024 / 1024).toFixed(2)} GB`;
}

export function displayName(a) {
  if (!a) return '';
  return a.name || (a.address ? a.address.split('@')[0] : '');
}

export function initials(a) {
  const n = displayName(a).replace(/^["'\s]+/, '');
  if (!n) return '?';
  const ch = [...n][0];
  return /[a-z]/i.test(ch) ? ch.toUpperCase() : ch;
}

export const msgKey = (m) => `${m.accountId}|${m.path}|${m.uid}`;

export function parseKey(key) {
  const [accountId, ...rest] = key.split('|');
  const uid = Number(rest.pop());
  return { accountId, path: rest.join('|'), uid };
}

export function relTime(ts) {
  if (!ts) return '';
  const s = Math.round((Date.now() - ts) / 1000);
  if (s < 45) return '刚刚';
  if (s < 3600) return `${Math.round(s / 60)} 分钟前`;
  if (s < 86400) return `${Math.round(s / 3600)} 小时前`;
  return shortDate(ts);
}
