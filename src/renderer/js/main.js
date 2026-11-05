// 渲染进程入口：顶栏、搜索、状态栏、快捷键、未读角标，以及主进程事件
import { $, h, bus, debounce, msgKey, escapeHtml } from './util.js';
import { icon } from './icons.js';
import {
  state, api, loadAccounts, loadMessages, loadFolders, refreshUnread, setView, syncView, select, selectedMessages,
  toggleSeen, toggleFlag, trash, archive, inboxOf,
} from './state.js';
import { initSidebar, statusText } from './sidebar.js';
import { initList, moveSelection } from './list.js';
import { initReader, readerAction } from './reader.js';
import { openCompose, isComposing } from './compose.js';
import { openSettings } from './settings.js';
import { openAccountDialog } from './account-dialog.js';
import { initTheme, toggleTheme, isDark } from './theme.js';
import { initUpdate, restartToUpdate, openDownload, updateStatus } from './update.js';
import { toast, topOverlay } from './ui.js';
import { initAi, toggleAi, isAiOpen } from './ai-panel.js';

async function boot() {
  state.settings = await api.settings.get();
  document.documentElement.dataset.density = state.settings.density || 'comfortable';
  await initTheme();
  buildTitlebar();
  const saved = await api.state.get();
  if (saved.view && (saved.view.type === 'unified' || saved.view.accountId)) state.view = saved.view;
  await loadAccounts();
  state.status = await api.mail.statusAll();
  if (state.view.accountId && !state.accounts.some((a) => a.id === state.view.accountId)) state.view = { type: 'unified', kind: 'inbox' };
  initSidebar();
  initList();
  initReader();
  initAi();
  initStatusbar();
  await refreshUnread();
  await loadMessages();
  initUpdate();
  wireEvents();
  if (!state.accounts.length) setTimeout(() => openAccountDialog(), 300);
}

// ---------- 顶栏 ----------
function buildTitlebar() {
  const tb = $('#titlebar');
  tb.innerHTML = `
    <div class="brand"><span class="logo-mark">汇</span><div class="brand-text"><div class="brand-name">汇邮</div><div class="brand-sub">Huiyou Mail</div></div></div>
    <div class="search">
      ${icon('search', 16)}
      <input id="search" placeholder="搜索邮件" spellcheck="false">
      <kbd class="search-kbd">/</kbd>
      <button class="search-clear hidden" title="清除">${icon('close', 12)}</button>
    </div>
    <div class="tb-actions">
      <button class="btn ai-btn" title="AI 助手 (Ctrl+J)">${icon('sparkle', 15)}AI 助手</button>
      <button class="btn btn-primary compose-btn">${icon('pen', 15)}写邮件</button>
      <button class="tb-round" data-a="sync" title="立即收信 (F5)">${icon('refresh', 17)}</button>
      <button class="tb-round" data-a="theme" title="切换深色 / 浅色">${icon(isDark() ? 'sun' : 'moon', 17)}</button>
      <button class="tb-round" data-a="settings" title="设置">${icon('gear', 17)}</button>
    </div>`;
  tb.querySelector('.compose-btn').onclick = () => openCompose({ mode: 'new' });
  const aiBtn = tb.querySelector('.ai-btn');
  aiBtn.onclick = () => toggleAi();
  bus.on('ai-toggle', (on) => aiBtn.classList.toggle('active', on));
  tb.querySelector('[data-a=sync]').onclick = manualSync;
  tb.querySelector('[data-a=theme]').onclick = toggleTheme;
  tb.querySelector('[data-a=settings]').onclick = () => openSettings();
  bus.on('theme', (dark) => (tb.querySelector('[data-a=theme]').innerHTML = icon(dark ? 'sun' : 'moon', 17)));

  const input = $('#search');
  const clearBtn = tb.querySelector('.search-clear');
  const apply = debounce(() => {
    state.query = input.value;
    clearBtn.classList.toggle('hidden', !input.value);
    if (state.serverResults && !input.value) state.serverResults = null;
    bus.emit('messages');
  }, 120);
  input.addEventListener('input', apply);
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') serverSearch(input.value);
    if (e.key === 'Escape') clearSearch();
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      input.blur();
      moveSelection(1);
    }
  });
  clearBtn.onclick = clearSearch;
  bus.on('clear-search', clearSearch);
  bus.on('view', () => {
    if (input.value) clearSearch();
  });
}

function clearSearch() {
  const input = $('#search');
  input.value = '';
  state.query = '';
  state.serverResults = null;
  $('#titlebar .search-clear').classList.add('hidden');
  bus.emit('messages');
}

let searchSeq = 0;
async function serverSearch(q) {
  q = q.trim();
  if (!q || !state.accounts.length) return;
  const seq = ++searchSeq;
  const targets = state.view.type === 'folder' ? [{ accountId: state.view.accountId, path: state.view.path }] : state.accounts.map((a) => ({ accountId: a.id, path: inboxOf(a.id) }));
  setStatus({ text: '正在服务器上搜索…', busy: true });
  const results = await Promise.all(targets.map((t) => api.mail.search({ ...t, query: q }).catch((err) => (toast(err.message, 'error', 4000), []))));
  if (seq !== searchSeq) return;
  state.serverResults = results.flat().sort((a, b) => b.date - a.date);
  state.selected.clear();
  state.current = null;
  bus.emit('messages');
  bus.emit('reader');
  renderStatus();
}

async function manualSync() {
  const btn = $('#titlebar [data-a=sync]');
  btn.classList.add('spinning');
  try {
    if (state.view.type === 'folder') await syncView();
    await api.mail.syncAll();
  } finally {
    btn.classList.remove('spinning');
  }
}

// ---------- 状态栏 ----------
let statusOverride = null;
function setStatus(s) {
  statusOverride = s;
  renderStatus(true);
}

function initStatusbar() {
  renderStatus();
  setInterval(renderStatus, 30000);
  bus.on('update', renderStatus);
}

function renderStatus(keep = false) {
  const bar = $('#statusbar');
  if (!keep) statusOverride = null;
  const s = statusOverride || statusText();
  bar.innerHTML = `<div class="sb-left">${s.busy ? '<span class="mini-spin"></span>' : s.error ? '<span class="state-dot danger"></span>' : ''}<span>${escapeHtml(s.text || '')}</span></div><div class="sb-right"></div>`;
  const right = bar.querySelector('.sb-right');
  const u = updateStatus();
  if (u.state === 'downloading') right.appendChild(h(`<span class="sb-item tabular">↓ ${u.percent || 0}%</span>`));
  if (u.state === 'downloaded') {
    const b = h(`<button class="sb-link">↻ 重启以更新</button>`);
    b.onclick = restartToUpdate;
    right.appendChild(b);
  }
  if (u.state === 'available') {
    const b = h(`<button class="sb-link">新版本 ${escapeHtml(u.version)}</button>`);
    b.onclick = openDownload;
    right.appendChild(b);
  }
  if (s.error) {
    const left = bar.querySelector('.sb-left');
    left.classList.add('clickable');
    left.onclick = () => openSettings('accounts');
  }
}

// ---------- 任务栏角标：只数你不在时新来的邮件，切回汇邮就清零 ----------
// （总未读数大多是没用的旧邮件，挂个 99+ 没意义）
function drawBadge(count) {
  if (!count) return null;
  const c = document.createElement('canvas');
  c.width = c.height = 32;
  const g = c.getContext('2d');
  g.fillStyle = '#d70015';
  g.beginPath();
  g.arc(16, 16, 16, 0, Math.PI * 2);
  g.fill();
  g.fillStyle = '#fff';
  g.font = `600 ${count > 99 ? 13 : count > 9 ? 16 : 19}px "Segoe UI", sans-serif`;
  g.textAlign = 'center';
  g.textBaseline = 'middle';
  g.fillText(count > 99 ? '99+' : String(count), 16, 17);
  return c.toDataURL();
}

let fresh = 0;
let lastBadge = '';
function updateBadge() {
  const unread = Object.values(state.unread).reduce((a, b) => a + b, 0);
  const key = `${fresh}/${unread}`;
  if (key === lastBadge) return;
  lastBadge = key;
  api.app.setBadge({ count: fresh, unread, dataUrl: drawBadge(fresh) });
}

// ---------- 主进程事件 ----------
function wireEvents() {
  bus.on('unread', updateBadge);
  updateBadge();

  const reload = debounce(() => loadMessages(), 150);
  window.addEventListener('focus', () => {
    fresh = 0;
    updateBadge();
  });
  api.mail.onChanged(({ accountId, path, newMessages }) => {
    if (newMessages && newMessages.length && path === inboxOf(accountId) && !document.hasFocus()) {
      fresh += newMessages.length;
      updateBadge();
    }
    const v = state.view;
    if (v.type === 'unified' || (v.accountId === accountId && v.path === path)) reload();
    refreshUnread();
    loadFolders(accountId);
  });
  api.mail.onStatus((s) => {
    state.status[s.accountId] = { ...(state.status[s.accountId] || {}), ...s };
    bus.emit('status');
    renderStatus();
  });
  api.mail.onFolders(({ accountId }) => loadFolders(accountId).then(() => bus.emit('messages')));
  api.mail.onOpen(async ({ accountId, path, uid }) => {
    await setView({ type: 'folder', accountId, path });
    select(`${accountId}|${path}|${uid}`);
  });
  api.app.onCommand((cmd) => {
    if (cmd === 'compose') openCompose({ mode: 'new' });
  });

  document.addEventListener('keydown', onKey);
}

function onKey(e) {
  const t = e.target;
  const typing = t.isContentEditable || ['INPUT', 'TEXTAREA', 'SELECT'].includes(t.tagName);
  if (e.key === 'F5') {
    e.preventDefault();
    return manualSync();
  }
  if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'n') {
    e.preventDefault();
    return openCompose({ mode: 'new' });
  }
  if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'j') {
    e.preventDefault();
    return toggleAi();
  }
  if ((e.ctrlKey || e.metaKey) && e.key === ',') {
    e.preventDefault();
    return openSettings();
  }
  if (typing || topOverlay() || isComposing() || e.altKey) return;
  if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'a') {
    e.preventDefault();
    import('./state.js').then(({ visibleMessages }) => {
      state.selected = new Set(visibleMessages().map(msgKey));
      state.current = null;
      bus.emit('selection');
      bus.emit('reader');
    });
    return;
  }
  if (e.ctrlKey || e.metaKey) return;
  const sel = selectedMessages();
  switch (e.key) {
    case '/':
      e.preventDefault();
      $('#search').focus();
      break;
    case 'ArrowDown':
    case 'j':
      e.preventDefault();
      moveSelection(1);
      break;
    case 'ArrowUp':
    case 'k':
      e.preventDefault();
      moveSelection(-1);
      break;
    case 'Delete':
    case '#':
      if (sel.length) trash(sel);
      break;
    case 'e':
      if (sel.length) archive(sel);
      break;
    case 'u':
      if (sel.length) toggleSeen(sel).then(() => bus.emit('reader'));
      break;
    case 's':
      if (sel.length) toggleFlag(sel).then(() => bus.emit('reader'));
      break;
    case 'r':
      readerAction('reply');
      break;
    case 'a':
      readerAction('replyAll');
      break;
    case 'f':
      readerAction('forward');
      break;
    case 'c':
      openCompose({ mode: 'new' });
      break;
    case 't':
      readerAction('translate');
      break;
    case 'Escape':
      if (state.selected.size) {
        state.selected.clear();
        state.current = null;
        bus.emit('selection');
        bus.emit('reader');
      }
      break;
  }
}

boot().catch((err) => {
  console.error(err);
  document.body.appendChild(h(`<div class="fatal">启动失败：${escapeHtml(err.message)}</div>`));
});
