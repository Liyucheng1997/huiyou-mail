// 全局状态与常用操作。界面各部分通过 bus 事件刷新。
import { bus, msgKey, parseKey } from './util.js';
import { toast } from './ui.js';

export const state = {
  accounts: [],
  folders: {}, // accountId -> [folder]
  status: {}, // accountId -> { state, message, lastSync, path }
  unread: {}, // accountId -> 收件箱未读数
  view: { type: 'unified', kind: 'inbox' },
  filter: 'all', // all | unread
  query: '',
  serverResults: null, // 服务器搜索结果（数组）
  messages: [],
  meta: { complete: true, total: 0, unread: 0 },
  selected: new Set(), // 选中的邮件 key
  anchor: null, // shift 多选的起点
  current: null, // 正在阅读的邮件 key
  settings: {},
  collapsed: {}, // 侧栏折叠
};

export const api = window.api;

export const ACCOUNT_COLORS = 4;
export function accountColorIndex(accountId) {
  const i = state.accounts.findIndex((a) => a.id === accountId);
  return i < 0 ? 0 : i % ACCOUNT_COLORS;
}
export function accountById(id) {
  return state.accounts.find((a) => a.id === id) || null;
}

export function folderOf(accountId, path) {
  return (state.folders[accountId] || []).find((f) => f.path === path) || null;
}
export function specialFolder(accountId, use) {
  return (state.folders[accountId] || []).find((f) => f.specialUse === use) || null;
}
export function inboxOf(accountId) {
  const f = specialFolder(accountId, '\\Inbox');
  return f ? f.path : 'INBOX';
}

export function viewTitle(view = state.view) {
  if (view.type === 'unified') return { inbox: '全部收件箱', unread: '未读', flagged: '星标邮件' }[view.kind];
  const f = folderOf(view.accountId, view.path);
  return f ? f.name : view.path;
}

export function viewSubtitle(view = state.view) {
  if (view.type === 'unified') return state.accounts.length > 1 ? `${state.accounts.length} 个邮箱` : state.accounts[0]?.email || '';
  return accountById(view.accountId)?.email || '';
}

export const sameView = (a, b) => a.type === b.type && a.kind === b.kind && a.accountId === b.accountId && a.path === b.path;

// 当前列表里能看到的邮件（应用了未读筛选和本地搜索）
export function visibleMessages() {
  let list = state.serverResults || state.messages;
  if (state.filter === 'unread') list = list.filter((m) => !m.seen);
  const q = state.query.trim().toLowerCase();
  if (q && !state.serverResults) {
    list = list.filter((m) =>
      [m.subject, m.snippet, m.from.name, m.from.address, ...(m.to || []).map((t) => t.name + ' ' + t.address)].join(' ').toLowerCase().includes(q)
    );
  }
  return list;
}

export function findMessage(key) {
  return (state.serverResults || []).find((m) => msgKey(m) === key) || state.messages.find((m) => msgKey(m) === key) || null;
}

// ---------- 加载 ----------
export async function loadAccounts() {
  state.accounts = await api.accounts.list();
  await Promise.all(state.accounts.map(async (a) => (state.folders[a.id] = await api.mail.folders(a.id))));
  bus.emit('accounts');
}

export async function loadFolders(accountId) {
  state.folders[accountId] = await api.mail.folders(accountId);
  bus.emit('folders', accountId);
}

let loadSeq = 0;
export async function loadMessages({ keepSelection = true } = {}) {
  const seq = ++loadSeq;
  const res = await api.mail.messages(state.view);
  if (seq !== loadSeq) return;
  state.messages = res.messages;
  state.meta = { complete: res.complete, total: res.total, unread: res.unread };
  if (!keepSelection) state.selected.clear();
  else {
    const keys = new Set(state.messages.map(msgKey));
    if (state.serverResults) state.serverResults.forEach((m) => keys.add(msgKey(m)));
    for (const k of [...state.selected]) if (!keys.has(k)) state.selected.delete(k);
  }
  bus.emit('messages');
}

export async function refreshUnread() {
  state.unread = await api.mail.unread();
  bus.emit('unread');
}

export async function setView(view) {
  if (sameView(view, state.view)) return;
  state.view = view;
  state.serverResults = null;
  state.selected.clear();
  state.current = null;
  bus.emit('view');
  bus.emit('reader');
  api.state.set({ view });
  await loadMessages();
  if (view.type === 'folder') syncView();
}

// 同步当前视图（文件夹或所有收件箱）
export async function syncView() {
  try {
    if (state.view.type === 'folder') await api.mail.sync({ accountId: state.view.accountId, path: state.view.path });
    else await api.mail.syncAll();
  } catch (err) {
    toast(err.message, 'error', 4000);
  }
}

// ---------- 选择 ----------
export function select(key, { additive = false, range = false } = {}) {
  const list = visibleMessages().map(msgKey);
  if (range && state.anchor && list.includes(state.anchor)) {
    const a = list.indexOf(state.anchor);
    const b = list.indexOf(key);
    if (!additive) state.selected.clear();
    for (let i = Math.min(a, b); i <= Math.max(a, b); i++) state.selected.add(list[i]);
  } else if (additive) {
    if (state.selected.has(key)) state.selected.delete(key);
    else state.selected.add(key);
    state.anchor = key;
  } else {
    state.selected = new Set([key]);
    state.anchor = key;
  }
  const single = state.selected.size === 1 ? [...state.selected][0] : null;
  state.current = single;
  bus.emit('selection');
  bus.emit('reader');
}

export function selectedMessages() {
  return [...state.selected].map(findMessage).filter(Boolean);
}

// 按 账户+文件夹 分组，批量调用
function groups(msgs) {
  const map = new Map();
  for (const m of msgs) {
    const k = m.accountId + '\n' + m.path;
    if (!map.has(k)) map.set(k, { accountId: m.accountId, path: m.path, uids: [] });
    map.get(k).uids.push(m.uid);
  }
  return [...map.values()];
}

// 本地先改，界面立刻响应
function patchLocal(msgs, patch) {
  const keys = new Set(msgs.map(msgKey));
  const apply = (m) => (keys.has(msgKey(m)) ? Object.assign(m, patch) : m);
  state.messages.forEach(apply);
  (state.serverResults || []).forEach(apply);
  bus.emit('messages');
}

function removeLocal(msgs) {
  const keys = new Set(msgs.map(msgKey));
  const list = visibleMessages().map(msgKey);
  // 删除后自动选中下一封
  let next = null;
  if (state.current && keys.has(state.current)) {
    const i = list.indexOf(state.current);
    for (let j = i + 1; j < list.length && !next; j++) if (!keys.has(list[j])) next = list[j];
    for (let j = i - 1; j >= 0 && !next; j--) if (!keys.has(list[j])) next = list[j];
  }
  state.messages = state.messages.filter((m) => !keys.has(msgKey(m)));
  if (state.serverResults) state.serverResults = state.serverResults.filter((m) => !keys.has(msgKey(m)));
  for (const k of keys) state.selected.delete(k);
  bus.emit('messages');
  if (next) select(next);
  else {
    state.current = null;
    bus.emit('reader');
  }
}

async function run(msgs, fn, okText) {
  try {
    await Promise.all(groups(msgs).map(fn));
    if (okText) toast(okText, 'success');
  } catch (err) {
    toast(err.message, 'error', 4000);
    loadMessages();
  }
  refreshUnread();
}

export function setFlags(msgs, patch) {
  if (!msgs.length) return;
  patchLocal(msgs, patch);
  return run(msgs, (g) => api.mail.flags({ ...g, patch }));
}

export function toggleSeen(msgs) {
  const seen = msgs.some((m) => !m.seen);
  return setFlags(msgs, { seen });
}

export function toggleFlag(msgs) {
  const flagged = msgs.some((m) => !m.flagged);
  return setFlags(msgs, { flagged });
}

export function trash(msgs) {
  if (!msgs.length) return;
  const inTrash = msgs.every((m) => folderOf(m.accountId, m.path)?.specialUse === '\\Trash');
  removeLocal(msgs);
  return run(msgs, (g) => api.mail.remove({ ...g, permanent: inTrash }), inTrash ? `已彻底删除 ${msgs.length} 封邮件` : `已移到“已删除”`);
}

export function archive(msgs) {
  if (!msgs.length) return;
  removeLocal(msgs);
  return run(msgs, (g) => api.mail.archive(g), '已归档');
}

export function spam(msgs) {
  if (!msgs.length) return;
  removeLocal(msgs);
  return run(msgs, (g) => api.mail.spam(g), '已移到垃圾邮件');
}

export function move(msgs, dest) {
  if (!msgs.length) return;
  removeLocal(msgs);
  return run(msgs, (g) => api.mail.move({ ...g, dest }), '已移动');
}

export { parseKey };
