// 邮件列表：按日期分组，未读蓝点、星标、附件、账户标记；支持多选、右键菜单、拖到文件夹
import { $, h, escapeHtml, bus, shortDate, dayGroup, displayName, initials, msgKey } from './util.js';
import { icon } from './icons.js';
import {
  state, api, visibleMessages, viewTitle, viewSubtitle, select, selectedMessages, findMessage, loadMessages,
  setFlags, toggleSeen, toggleFlag, trash, archive, spam, move, accountColorIndex, accountById, folderOf, syncView,
} from './state.js';
import { showMenu, toast, segmented } from './ui.js';
import { openCompose } from './compose.js';

let root, scroller, header;
const ROW_LIMIT_STEP = 300;
let rowLimit = ROW_LIMIT_STEP;

export function initList() {
  root = $('#list');
  root.innerHTML = '';
  header = h('<div class="list-header"></div>');
  scroller = h('<div class="list-scroll" tabindex="-1"></div>');
  root.append(header, scroller);
  bus.on('messages', renderRows);
  bus.on('selection', updateSelection);
  bus.on('view', () => {
    rowLimit = ROW_LIMIT_STEP;
    scroller.scrollTop = 0;
    renderHeader();
    renderRows();
  });
  bus.on('accounts', () => (renderHeader(), renderRows()));
  bus.on('folders', renderHeader);
  bus.on('drop-to-folder', ({ accountId, path, keys }) => {
    const msgs = keys.map(findMessage).filter((m) => m && m.accountId === accountId && m.path !== path);
    if (msgs.length) move(msgs, path);
    else if (keys.length) toast('只能移动到同一个邮箱的文件夹', 'error');
  });
  scroller.addEventListener('scroll', () => {
    if (scroller.scrollTop + scroller.clientHeight > scroller.scrollHeight - 400 && visibleMessages().length > rowLimit) {
      rowLimit += ROW_LIMIT_STEP;
      renderRows();
    }
  });
  renderHeader();
  renderRows();
}

function renderHeader() {
  const title = state.serverResults ? '搜索结果' : viewTitle();
  const sub = state.serverResults ? `“${state.query}”· ${state.serverResults.length} 封` : viewSubtitle();
  header.innerHTML = `<div class="list-title-row">
      <div class="list-titles"><div class="list-title">${escapeHtml(title)}</div><div class="list-sub">${escapeHtml(sub)}</div></div>
      <div class="list-tools"></div>
    </div>`;
  const tools = header.querySelector('.list-tools');
  if (state.serverResults) {
    const clear = h(`<button class="btn btn-sm">清除搜索</button>`);
    clear.onclick = () => bus.emit('clear-search');
    tools.appendChild(clear);
  } else {
    tools.appendChild(
      segmented(
        [
          { label: '全部', value: 'all' },
          { label: '未读', value: 'unread' },
        ],
        state.filter,
        (v) => {
          state.filter = v;
          renderRows();
        }
      )
    );
  }
}

function emptyState() {
  if (!state.accounts.length)
    return `<div class="empty">${icon('mails', 34)}<div>添加你的第一个邮箱</div><button class="btn btn-primary btn-sm" data-a="add">添加邮箱</button></div>`;
  if (state.query) return `<div class="empty">${icon('search', 34)}<div>没有找到匹配的邮件</div><div class="empty-sub">按回车在服务器上搜索</div></div>`;
  if (state.filter === 'unread') return `<div class="empty">${icon('check', 34)}<div>全部已读</div></div>`;
  return `<div class="empty">${icon('inbox', 34)}<div>这里没有邮件</div></div>`;
}

function rowHtml(m) {
  const key = msgKey(m);
  const unified = (state.view.type === 'unified' || !!state.serverResults) && state.accounts.length > 1;
  const sentFolder = ['\\Sent', '\\Drafts'].includes(folderOf(m.accountId, m.path)?.specialUse);
  const who = sentFolder ? (m.to || []).map(displayName).join('、') || '(无收件人)' : displayName(m.from) || '(未知发件人)';
  const avatarOf = sentFolder ? (m.to || [])[0] : m.from;
  const acc = accountById(m.accountId);
  return `<div class="mrow ${m.seen ? '' : 'unread'} ${state.selected.has(key) ? 'selected' : ''}" data-key="${escapeHtml(key)}" draggable="true">
    <span class="mrow-dot"></span>
    <span class="avatar">${escapeHtml(initials(avatarOf))}${
      unified && acc ? `<span class="avatar-acc acc-c${accountColorIndex(m.accountId)}" title="${escapeHtml(acc.email)}"></span>` : ''
    }</span>
    <div class="mrow-main">
      <div class="mrow-line1">
        <span class="mrow-from">${m.draft ? '<span class="tag-draft">草稿</span>' : ''}${escapeHtml(who)}</span>
        ${m.attachments ? `<span class="mrow-clip">${icon('clip', 13)}</span>` : ''}
        ${m.answered ? `<span class="mrow-clip" title="已回复">${icon('reply', 13)}</span>` : ''}
        <span class="mrow-date tabular">${shortDate(m.date)}</span>
      </div>
      <div class="mrow-line2">
        <span class="mrow-subject">${escapeHtml(m.subject || '(无主题)')}</span>
        <button class="mrow-star ${m.flagged ? 'on' : ''}" data-a="star" title="星标">${icon('star', 14)}</button>
      </div>
      <div class="mrow-snippet">${escapeHtml(m.snippet || '')}</div>
    </div>
    <div class="mrow-actions">
      <button class="icon-btn" data-a="archive" title="归档 (E)">${icon('archive', 15)}</button>
      <button class="icon-btn" data-a="trash" title="删除 (Delete)">${icon('trash', 15)}</button>
      <button class="icon-btn" data-a="seen" title="${m.seen ? '标为未读' : '标为已读'} (U)">${icon(m.seen ? 'mail' : 'mailOpen', 15)}</button>
    </div>
  </div>`;
}

function renderRows() {
  if (!scroller) return;
  renderHeader();
  const list = visibleMessages();
  const top = scroller.scrollTop;
  if (!list.length) {
    scroller.innerHTML = emptyState();
    const add = scroller.querySelector('[data-a=add]');
    if (add) add.onclick = () => import('./account-dialog.js').then((m) => m.openAccountDialog());
    return;
  }
  const parts = [];
  let group = null;
  for (const m of list.slice(0, rowLimit)) {
    const g = dayGroup(m.date);
    if (g !== group) {
      group = g;
      parts.push(`<div class="list-group">${escapeHtml(g)}</div>`);
    }
    parts.push(rowHtml(m));
  }
  const canLoadMore = state.view.type === 'folder' && !state.serverResults && !state.query && !state.meta.complete;
  if (canLoadMore && list.length <= rowLimit) parts.push(`<div class="list-more"><button class="btn btn-sm" data-a="older">加载更早的邮件</button></div>`);
  if (state.view.type === 'unified' && !state.serverResults && list.length <= rowLimit) {
    parts.push(`<div class="list-more muted">“全部收件箱”显示每个邮箱最近的邮件；要看更早的，请打开对应邮箱的收件箱。</div>`);
  }
  scroller.innerHTML = parts.join('');
  scroller.scrollTop = top;
  const older = scroller.querySelector('[data-a=older]');
  if (older) older.onclick = () => loadOlder(older);
}

async function loadOlder(btn) {
  btn.disabled = true;
  btn.textContent = '正在加载…';
  try {
    await api.mail.loadOlder({ accountId: state.view.accountId, path: state.view.path });
    rowLimit += ROW_LIMIT_STEP;
    await loadMessages();
  } catch (err) {
    toast(err.message, 'error', 4000);
    btn.disabled = false;
    btn.textContent = '加载更早的邮件';
  }
}

function updateSelection() {
  scroller.querySelectorAll('.mrow').forEach((el) => el.classList.toggle('selected', state.selected.has(el.dataset.key)));
  const cur = state.current && scroller.querySelector(`.mrow[data-key="${CSS.escape(state.current)}"]`);
  if (cur) cur.scrollIntoView({ block: 'nearest' });
}

// ---------- 事件 ----------
document.addEventListener('click', (e) => {
  const row = e.target.closest('#list .mrow');
  if (!row) return;
  const key = row.dataset.key;
  const m = findMessage(key);
  const action = e.target.closest('[data-a]')?.dataset.a;
  if (action && m) {
    e.stopPropagation();
    if (action === 'star') toggleFlag([m]);
    if (action === 'archive') archive([m]);
    if (action === 'trash') trash([m]);
    if (action === 'seen') toggleSeen([m]);
    return;
  }
  select(key, { additive: e.ctrlKey || e.metaKey, range: e.shiftKey });
});

document.addEventListener('dblclick', (e) => {
  const row = e.target.closest('#list .mrow');
  if (!row) return;
  const m = findMessage(row.dataset.key);
  if (m && m.draft) openCompose({ mode: 'draft', source: m });
});

document.addEventListener('contextmenu', (e) => {
  const row = e.target.closest('#list .mrow');
  if (!row) return;
  e.preventDefault();
  if (!state.selected.has(row.dataset.key)) select(row.dataset.key);
  showMenu(messageMenu(selectedMessages()), e.clientX, e.clientY);
});

document.addEventListener('dragstart', (e) => {
  const row = e.target.closest && e.target.closest('#list .mrow');
  if (!row) return;
  if (!state.selected.has(row.dataset.key)) select(row.dataset.key);
  const keys = [...state.selected];
  e.dataTransfer.setData('application/x-huiyou-mail', JSON.stringify(keys));
  e.dataTransfer.effectAllowed = 'move';
  const ghost = h(`<div class="drag-ghost">${keys.length > 1 ? `${keys.length} 封邮件` : escapeHtml(findMessage(keys[0])?.subject || '邮件')}</div>`);
  document.body.appendChild(ghost);
  e.dataTransfer.setDragImage(ghost, 10, 10);
  setTimeout(() => ghost.remove(), 0);
});

export function messageMenu(msgs) {
  if (!msgs.length) return [];
  const one = msgs.length === 1 ? msgs[0] : null;
  const sameAccount = msgs.every((m) => m.accountId === msgs[0].accountId);
  const folders = sameAccount ? (state.folders[msgs[0].accountId] || []).filter((f) => !msgs.every((m) => m.path === f.path)) : [];
  const items = [];
  if (one) {
    items.push(
      { label: '回复', icon: 'reply', shortcut: 'R', onClick: () => openCompose({ mode: 'reply', source: one }) },
      { label: '全部回复', icon: 'replyAll', shortcut: 'A', onClick: () => openCompose({ mode: 'replyAll', source: one }) },
      { label: '转发', icon: 'forward', shortcut: 'F', onClick: () => openCompose({ mode: 'forward', source: one }) },
      'sep'
    );
  }
  const anyUnread = msgs.some((m) => !m.seen);
  const anyUnflagged = msgs.some((m) => !m.flagged);
  items.push(
    { label: anyUnread ? '标为已读' : '标为未读', icon: anyUnread ? 'mailOpen' : 'mail', shortcut: 'U', onClick: () => setFlags(msgs, { seen: anyUnread }) },
    { label: anyUnflagged ? '加星标' : '取消星标', icon: 'star', shortcut: 'S', onClick: () => setFlags(msgs, { flagged: anyUnflagged }) },
    'sep',
    { label: '归档', icon: 'archive', shortcut: 'E', onClick: () => archive(msgs) },
    {
      label: '移动到',
      icon: 'folderMove',
      disabled: !folders.length,
      submenu: folders.map((f) => ({ label: f.name, icon: 'folder', onClick: () => move(msgs, f.path) })),
    },
    { label: '标为垃圾邮件', icon: 'spam', onClick: () => spam(msgs) },
    { label: '删除', icon: 'trash', shortcut: 'Del', danger: true, onClick: () => trash(msgs) }
  );
  if (!sameAccount) items.find((i) => i.label === '移动到').disabled = true;
  return items;
}

export function focusList() {
  scroller && scroller.focus();
}

// 上下移动选中
export function moveSelection(delta) {
  const list = visibleMessages().map(msgKey);
  if (!list.length) return;
  let i = state.current ? list.indexOf(state.current) : -1;
  i = Math.max(0, Math.min(list.length - 1, i + delta));
  select(list[i]);
}

export { syncView };
