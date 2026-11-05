// 侧栏：智能邮箱（全部收件箱 / 未读 / 星标）+ 每个账户的文件夹
import { $, h, escapeHtml, bus, relTime } from './util.js';
import { icon, folderIcon } from './icons.js';
import { state, api, setView, sameView, accountColorIndex, loadFolders } from './state.js';
import { showMenu, toast, promptDialog } from './ui.js';
import { openAccountDialog } from './account-dialog.js';
import { openSettings } from './settings.js';

const MAIN_SPECIAL = ['\\Inbox', '\\Drafts', '\\Sent', '\\Archive', '\\Junk', '\\Trash'];
let root;

export function initSidebar() {
  root = $('#sidebar');
  ['accounts', 'folders', 'unread', 'view', 'status'].forEach((ev) => bus.on(ev, render));
  render();
}

function count(n) {
  return n ? `<span class="nav-count tabular">${n > 9999 ? '9999+' : n}</span>` : '';
}

function navItem({ label, iconName, active, n, cls = '' }) {
  return h(`<button class="nav-item ${active ? 'active' : ''} ${cls}">
    ${icon(iconName, 17)}<span class="nav-label">${escapeHtml(label)}</span>${count(n)}
  </button>`);
}

function render() {
  if (!root) return;
  const scroll = root.querySelector('.sidebar-scroll');
  const top = scroll ? scroll.scrollTop : 0;
  root.innerHTML = '';
  const box = h('<div class="sidebar-scroll"></div>');
  root.appendChild(box);

  const totalUnread = Object.values(state.unread).reduce((a, b) => a + b, 0);
  box.appendChild(h('<div class="nav-group-title">智能邮箱</div>'));
  const smart = [
    { kind: 'inbox', label: '全部收件箱', iconName: 'inboxes', n: totalUnread },
    { kind: 'unread', label: '未读', iconName: 'dot', n: 0 },
    { kind: 'flagged', label: '星标', iconName: 'star', n: 0 },
  ];
  for (const s of smart) {
    const view = { type: 'unified', kind: s.kind };
    const el = navItem({ ...s, active: sameView(view, state.view) });
    el.onclick = () => setView(view);
    box.appendChild(el);
  }

  for (const acc of state.accounts) box.appendChild(accountSection(acc));

  if (!state.accounts.length) {
    box.appendChild(h(`<div class="nav-empty">还没有添加邮箱。<br>添加后，所有邮件会汇总到“全部收件箱”。</div>`));
  }

  const footer = h(`<div class="sidebar-footer">
    <button class="btn btn-ghost btn-sm add-account">${icon('plus', 15)}添加邮箱</button>
  </div>`);
  footer.querySelector('.add-account').onclick = () => openAccountDialog();
  root.appendChild(footer);
  box.scrollTop = top;
}

function accountSection(acc) {
  const folders = state.folders[acc.id] || [];
  const st = state.status[acc.id] || {};
  const collapsed = !!state.collapsed[acc.id];
  const sec = h(`<div class="nav-account ${collapsed ? 'collapsed' : ''}">
    <div class="nav-account-head" title="${escapeHtml(acc.email)}">
      <span class="acc-badge acc-c${accountColorIndex(acc.id)}">${escapeHtml(([...(acc.label || acc.name || acc.email)][0] || '?').toUpperCase())}</span>
      <span class="nav-account-name">${escapeHtml(acc.label || acc.email)}</span>
      <span class="nav-account-state">${
        st.state === 'syncing' ? '<span class="mini-spin"></span>' : st.state === 'error' ? '<span class="state-dot danger"></span>' : ''
      }</span>
      <span class="nav-chevron">${icon('chevronDown', 14)}</span>
    </div>
    <div class="nav-account-body"></div>
  </div>`);
  const head = sec.querySelector('.nav-account-head');
  head.onclick = () => {
    state.collapsed[acc.id] = !collapsed;
    render();
  };
  head.oncontextmenu = (e) => {
    e.preventDefault();
    showMenu(
      [
        { label: '立即收信', icon: 'refresh', onClick: () => syncAccount(acc) },
        { label: '刷新文件夹列表', icon: 'folder', onClick: () => refreshFolders(acc) },
        { label: '新建文件夹…', icon: 'plus', onClick: () => createFolder(acc) },
        'sep',
        { label: '账户设置…', icon: 'gear', onClick: () => openSettings('accounts', acc.id) },
      ],
      e.clientX,
      e.clientY
    );
  };
  const body = sec.querySelector('.nav-account-body');
  if (st.state === 'error') {
    const err = h(`<button class="nav-error" title="${st.reauth ? '点击重新登录' : '点击重试'}">${escapeHtml(st.message || '同步失败')}</button>`);
    err.onclick = () => (st.reauth ? openAccountDialog(acc) : syncAccount(acc));
    body.appendChild(err);
  }
  if (!folders.length && st.state !== 'error') body.appendChild(h('<div class="nav-hint">正在读取文件夹…</div>'));

  const main = folders.filter((f) => MAIN_SPECIAL.includes(f.specialUse));
  const rest = folders.filter((f) => !MAIN_SPECIAL.includes(f.specialUse));
  for (const f of main) body.appendChild(folderItem(acc, f));
  if (rest.length) {
    const key = acc.id + ':more';
    const open = !!state.collapsed[key];
    const more = h(`<button class="nav-item nav-more">${icon(open ? 'chevronDown' : 'chevron', 15)}<span class="nav-label">${open ? '收起' : `更多文件夹（${rest.length}）`}</span></button>`);
    more.onclick = () => {
      state.collapsed[key] = !open;
      render();
    };
    body.appendChild(more);
    if (open) for (const f of rest) body.appendChild(folderItem(acc, f, true));
  }
  return sec;
}

function folderItem(acc, f, nested = false) {
  const view = { type: 'folder', accountId: acc.id, path: f.path };
  const showCount = ['\\Inbox', '\\Junk', null].includes(f.specialUse) || !f.specialUse;
  const n = f.specialUse === '\\Drafts' ? f.total : showCount ? f.unread : 0;
  const depth = nested && f.delimiter ? Math.min(3, f.path.split(f.delimiter).length - 1) : 0;
  const el = navItem({ label: f.name, iconName: folderIcon(f), active: sameView(view, state.view), n, cls: nested ? 'nested' : '' });
  if (depth) el.style.paddingLeft = 10 + depth * 14 + 'px';
  el.title = f.path;
  el.onclick = () => setView(view);
  // 拖放邮件到文件夹
  el.addEventListener('dragover', (e) => {
    if (e.dataTransfer.types.includes('application/x-huiyou-mail')) {
      e.preventDefault();
      el.classList.add('drop');
    }
  });
  el.addEventListener('dragleave', () => el.classList.remove('drop'));
  el.addEventListener('drop', (e) => {
    el.classList.remove('drop');
    const data = JSON.parse(e.dataTransfer.getData('application/x-huiyou-mail') || '[]');
    bus.emit('drop-to-folder', { accountId: acc.id, path: f.path, keys: data });
  });
  return el;
}

async function syncAccount(acc) {
  try {
    await api.mail.sync({ accountId: acc.id, path: (state.folders[acc.id] || []).find((f) => f.specialUse === '\\Inbox')?.path || 'INBOX' });
  } catch (err) {
    toast(err.message, 'error', 4000);
  }
}

async function refreshFolders(acc) {
  try {
    await api.mail.refreshFolders(acc.id);
    await loadFolders(acc.id);
    toast('文件夹已刷新', 'success');
  } catch (err) {
    toast(err.message, 'error', 4000);
  }
}

async function createFolder(acc) {
  const name = await promptDialog({ title: '新建文件夹', label: `在 ${acc.email} 中新建`, placeholder: '文件夹名称', okText: '新建' });
  if (!name) return;
  try {
    await api.mail.createFolder({ accountId: acc.id, name });
    await loadFolders(acc.id);
    toast('已新建文件夹', 'success');
  } catch (err) {
    toast(err.message, 'error', 4000);
  }
}

export function statusText() {
  const list = Object.entries(state.status);
  if (list.some(([, s]) => s.state === 'syncing')) return { text: '正在收信…', busy: true };
  const errors = list.filter(([, s]) => s.state === 'error');
  if (errors.length) return { text: `${errors.length} 个邮箱同步失败`, error: true };
  const last = Math.max(0, ...list.map(([, s]) => s.lastSync || 0));
  return { text: last ? `已同步 · ${relTime(last)}` : state.accounts.length ? '等待同步' : '' };
}
