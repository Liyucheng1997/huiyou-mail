// 设置大面板：左侧分类，右侧内容（通用 / 账户 / 存储 / 关于）
import { h, escapeHtml, fmtSize } from './util.js';
import { icon } from './icons.js';
import { state, api, loadAccounts, accountColorIndex, refreshUnread, loadMessages } from './state.js';
import { openModal, toast, switchEl, segmented, confirmDialog } from './ui.js';
import { openAccountDialog } from './account-dialog.js';
import { applyTheme } from './theme.js';
import { updateStatus } from './update.js';

const SECTIONS = [
  { id: 'general', label: '通用', icon: 'sliders' },
  { id: 'accounts', label: '邮箱账户', icon: 'user' },
  { id: 'signin', label: '登录方式', icon: 'shield' },
  { id: 'ai', label: 'AI 助手', icon: 'sparkle' },
  { id: 'storage', label: '存储', icon: 'database' },
  { id: 'about', label: '关于与更新', icon: 'info' },
];

export function openSettings(section = 'general') {
  const content = h(`<div class="settings">
    <nav class="settings-nav">
      <div class="settings-nav-title">设置</div>
      ${SECTIONS.map((s) => `<button class="nav-item" data-s="${s.id}">${icon(s.icon, 17)}<span class="nav-label">${s.label}</span></button>`).join('')}
    </nav>
    <div class="settings-main"></div>
  </div>`);
  const m = openModal({ title: null, content, width: 880, className: 'settings-modal' });
  const x = h(`<button class="modal-x settings-x" title="关闭">${icon('close', 14)}</button>`);
  x.onclick = () => m.close();
  m.el.appendChild(x);
  const main = content.querySelector('.settings-main');
  const show = (id) => {
    content.querySelectorAll('.settings-nav .nav-item').forEach((b) => b.classList.toggle('active', b.dataset.s === id));
    main.innerHTML = '';
    main.scrollTop = 0;
    ({ general, accounts, signin, ai, storage, about })[id](main, () => show(id));
  };
  content.querySelectorAll('.settings-nav .nav-item').forEach((b) => (b.onclick = () => show(b.dataset.s)));
  show(section);
}

function pageHead(kicker, title, desc = '') {
  return h(`<div class="page-head"><div class="kicker">${kicker}</div><div class="page-title">${escapeHtml(title)}</div>${desc ? `<div class="page-desc">${escapeHtml(desc)}</div>` : ''}</div>`);
}

function row(label, desc, control) {
  const el = h(`<div class="set-row"><div class="set-text"><div class="set-label">${escapeHtml(label)}</div>${desc ? `<div class="set-desc">${escapeHtml(desc)}</div>` : ''}</div><div class="set-ctl"></div></div>`);
  el.querySelector('.set-ctl').appendChild(control);
  return el;
}

async function save(patch) {
  state.settings = await api.settings.set(patch);
}

function general(main) {
  const s = state.settings;
  main.appendChild(pageHead('GENERAL', '通用'));
  const card = h('<div class="set-card"></div>');
  card.appendChild(
    row('外观', '', segmented([{ label: '跟随系统', value: 'system' }, { label: '浅色', value: 'light' }, { label: '深色', value: 'dark' }], s.theme, async (v) => {
      await save({ theme: v });
      applyTheme();
    }))
  );
  card.appendChild(
    row('列表密度', '紧凑模式不显示邮件预览', segmented([{ label: '舒适', value: 'comfortable' }, { label: '紧凑', value: 'compact' }], s.density, async (v) => {
      await save({ density: v });
      document.documentElement.dataset.density = v;
    }))
  );
  const interval = h(`<select class="input">${[1, 2, 3, 5, 10, 15, 30].map((n) => `<option value="${n}" ${n === Number(s.syncInterval) ? 'selected' : ''}>每 ${n} 分钟</option>`).join('')}</select>`);
  interval.onchange = () => save({ syncInterval: Number(interval.value) });
  card.appendChild(row('自动收信', '服务器推送的新邮件会立即收到；这里设置定时检查的间隔', interval));
  main.appendChild(card);

  const card2 = h('<div class="set-card"></div>');
  card2.appendChild(row('新邮件通知', '窗口不在前台时，用系统通知提醒', switchEl(s.notifications, (v) => save({ notifications: v }))));
  card2.appendChild(row('关闭窗口时留在托盘', '继续在后台收信；从托盘图标右键退出', switchEl(s.closeToTray, (v) => save({ closeToTray: v }))));
  card2.appendChild(row('开机自动启动', '启动时最小化到托盘', switchEl(s.openAtLogin, (v) => save({ openAtLogin: v }))));
  main.appendChild(card2);

  const card3 = h('<div class="set-card"></div>');
  card3.appendChild(row('打开邮件后标为已读', '', switchEl(s.markReadOnOpen !== false, (v) => save({ markReadOnOpen: v }))));
  card3.appendChild(row('自动显示远程图片', '关闭时可防止发件人通过图片追踪你是否读过邮件', switchEl(s.loadRemoteImages, (v) => save({ loadRemoteImages: v }))));
  main.appendChild(card3);
}

function accounts(main, refresh) {
  main.appendChild(pageHead('ACCOUNTS', '邮箱账户', '密码和授权码用 Windows 系统加密保存在本机，不会上传到任何地方。'));
  const card = h('<div class="set-card"></div>');
  if (!state.accounts.length) card.appendChild(h('<div class="set-empty muted">还没有添加邮箱</div>'));
  for (const a of state.accounts) {
    const st = state.status[a.id] || {};
    const el = h(`<div class="acc-row">
      <span class="acc-badge lg acc-c${accountColorIndex(a.id)}">${escapeHtml(([...(a.label || a.name || a.email)][0] || '?').toUpperCase())}</span>
      <div class="acc-text">
        <div class="set-label">${escapeHtml(a.label ? `${a.label} · ${a.email}` : a.email)}</div>
        <div class="set-desc">${st.state === 'error' ? `<span class="state-dot danger"></span>${escapeHtml(st.message || '')}` : `<span class="state-dot success"></span>${escapeHtml(a.auth === 'oauth2' ? `通过 ${a.oauthProvider === 'microsoft' ? 'Microsoft' : 'Google'} 登录 · ${a.imap.host}` : a.imap.host)}`}</div>
      </div>
      <button class="btn btn-sm" data-a="edit">编辑</button>
      <button class="btn btn-danger btn-sm" data-a="remove">移除</button>
    </div>`);
    el.querySelector('[data-a=edit]').onclick = async () => {
      await openAccountDialog(a);
    };
    el.querySelector('[data-a=remove]').onclick = async () => {
      const ok = await confirmDialog({ title: `移除 ${a.email}？`, message: '只会删除本机上的账户和缓存，服务器上的邮件不受影响。', okText: '移除', danger: true });
      if (!ok) return;
      await api.accounts.remove(a.id);
      if (state.view.accountId === a.id) state.view = { type: 'unified', kind: 'inbox' };
      await loadAccounts();
      await refreshUnread();
      await loadMessages({ keepSelection: false });
      toast('已移除', 'success');
      refresh();
    };
    card.appendChild(el);
  }
  main.appendChild(card);
  const add = h(`<button class="btn btn-primary">${icon('plus', 15)}添加邮箱</button>`);
  add.onclick = () => openAccountDialog();
  main.appendChild(h('<div class="set-actions"></div>')).appendChild(add);
}

// Gmail / Outlook 的浏览器登录需要用户自己的 OAuth 客户端
const OAUTH_GUIDE = {
  google: {
    title: 'Google（Gmail）',
    url: 'https://console.cloud.google.com/auth/clients',
    urlText: '打开 Google Cloud 控制台',
    steps: [
      '在 Google Cloud 控制台新建一个项目，名字随意，例如“汇邮”。',
      '进入“Google Auth Platform”，按提示填写应用名称和你的邮箱，用户类型选“外部”。',
      '在“目标对象”里点“发布应用”改成正式版，否则每 7 天要重新登录一次。登录时看到“Google 尚未验证此应用”，点“高级 → 继续”即可，这是你自己的应用。',
      '在“客户端”里新建客户端，应用类型选“桌面应用”，把客户端 ID 和客户端密钥粘贴到下面。',
    ],
    fields: [
      { key: 'clientId', placeholder: '客户端 ID（以 .apps.googleusercontent.com 结尾）' },
      { key: 'clientSecret', placeholder: '客户端密钥（以 GOCSPX- 开头）' },
    ],
  },
  microsoft: {
    title: 'Microsoft（Outlook / Hotmail / Microsoft 365）',
    url: 'https://entra.microsoft.com/#view/Microsoft_AAD_RegisteredApps/ApplicationsListBlade',
    urlText: '打开 Microsoft Entra',
    steps: [
      '在 Microsoft Entra 管理中心打开“应用注册 → 新注册”（需要一个免费的 Azure 账号）。',
      '“受支持的帐户类型”选“任何组织目录中的帐户和个人 Microsoft 帐户”。',
      '“重定向 URI”的平台选“公共客户端/本机(移动和桌面)”，地址填 <code>http://localhost</code>。',
      '注册完成后，把“应用程序(客户端) ID”粘贴到下面。',
    ],
    fields: [{ key: 'clientId', placeholder: '应用程序(客户端) ID，形如 xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx' }],
  },
};

async function signin(main) {
  main.appendChild(
    pageHead('SIGN-IN', '登录方式', 'Gmail 和 Outlook 可以直接用账号在浏览器里登录，不用应用专用密码。这需要一个属于你自己的 OAuth 客户端，按下面的步骤创建一次即可，免费。')
  );
  const st = await api.oauth.status();
  for (const [id, g] of Object.entries(OAUTH_GUIDE)) {
    const saved = (state.settings.oauthClients || {})[id] || {};
    const card = h(`<div class="set-card oauth-card">
      <div class="oauth-head"><div class="set-label">${escapeHtml(g.title)}</div><span class="oauth-badge"></span></div>
      <ol class="oauth-steps">${g.steps.map((t) => `<li>${t}</li>`).join('')}</ol>
      <div class="oauth-fields">
        ${g.fields.map((f) => `<input class="input" data-k="${f.key}" placeholder="${escapeHtml(f.placeholder)}" spellcheck="false" autocomplete="off">`).join('')}
        <div><button class="btn btn-ghost btn-sm" data-a="open">${icon('external', 14)}${g.urlText}</button></div>
      </div>
    </div>`);
    const badge = card.querySelector('.oauth-badge');
    const paint = (s) => {
      badge.innerHTML = s.configured
        ? `<span class="state-dot success"></span>${s.source === 'builtin' ? '使用内置客户端' : '已配置'}`
        : '<span class="state-dot"></span>未配置';
    };
    paint(st[id]);
    card.querySelectorAll('[data-k]').forEach((input) => {
      input.value = saved[input.dataset.k] || '';
      input.onchange = async () => {
        const all = { ...(state.settings.oauthClients || {}) };
        all[id] = { ...(all[id] || {}), [input.dataset.k]: input.value.trim() };
        await save({ oauthClients: all });
        paint((await api.oauth.status())[id]);
        toast('已保存', 'success', 1500);
      };
    });
    card.querySelector('[data-a=open]').onclick = () => api.app.openExternal(g.url);
    main.appendChild(card);
  }
  main.appendChild(h('<div class="set-desc muted">客户端 ID 只保存在本机。登录时的账号密码在浏览器里输入，不经过汇邮；汇邮只保存加密后的授权令牌。</div>'));
}

async function ai(main, refresh) {
  main.appendChild(pageHead('AI', 'AI 助手', '由你电脑上的 Claude Code 驱动，使用你自己的 Claude 订阅额度，模型 Claude Opus 5.5。邮件内容只发给 Claude，用来回答你的问题。'));
  const st = await api.ai.status();
  const card = h('<div class="set-card"></div>');
  const state1 = h(`<span class="oauth-badge"><span class="state-dot ${st.ready ? 'success' : 'warning'}"></span>${st.ready ? '已连接' : '没有找到'}</span>`);
  card.appendChild(row('Claude Code', st.ready ? st.path : '请先安装 Claude Code，并在终端运行 claude 登录', state1));
  const pathInput = h(`<input class="input" style="width:260px" placeholder="自动检测" spellcheck="false">`);
  pathInput.value = state.settings.claudePath || '';
  pathInput.onchange = async () => {
    await save({ claudePath: pathInput.value.trim() });
    refresh();
  };
  card.appendChild(row('claude.exe 位置', '自动检测不到时，填 claude.exe 的完整路径', pathInput));
  card.appendChild(
    row('思考深度', '越深越准，也更慢、更耗订阅额度；改了以后从下一次新对话开始生效', segmented([{ label: '快', value: 'low' }, { label: '标准', value: 'medium' }, { label: '深入', value: 'high' }], state.settings.aiEffort || 'medium', (v) => save({ aiEffort: v })))
  );
  main.appendChild(card);

  main.appendChild(h('<div class="set-section-title">黑名单</div>'));
  const list = await api.blocklist.list();
  const card2 = h('<div class="set-card"></div>');
  if (!list.length) card2.appendChild(h('<div class="set-empty muted">还没有拉黑任何发件人。可以在邮件上右键“拉黑”，或者让 AI 助手帮你清理。</div>'));
  for (const b of list) {
    const el = h(`<div class="block-row"><div class="block-text"><div class="set-label">${escapeHtml(b.pattern)}</div><div class="set-desc">${escapeHtml(b.pattern.startsWith('@') ? '整个域名' : '这个地址')}${b.reason ? ' · ' + escapeHtml(b.reason) : ''}</div></div><button class="btn btn-sm">解除</button></div>`);
    el.querySelector('button').onclick = async () => {
      await api.blocklist.remove([b.pattern]);
      toast('已解除', 'success', 1500);
      refresh();
    };
    card2.appendChild(el);
  }
  main.appendChild(card2);
  main.appendChild(h('<div class="set-desc muted">被拉黑的发件人发来的新邮件，收信时会自动移到“已删除”。</div>'));
}

async function storage(main, refresh) {
  main.appendChild(pageHead('STORAGE', '存储', '邮件列表和打开过的邮件原文会缓存在本机，离线也能查看。'));
  const card = h('<div class="set-card"></div>');
  const size = h('<span class="tabular muted">计算中…</span>');
  card.appendChild(row('缓存大小', '', size));
  const clear = h('<button class="btn btn-sm">清除邮件正文缓存</button>');
  clear.onclick = async () => {
    await api.cache.clear();
    toast('已清除', 'success');
    refresh();
  };
  card.appendChild(row('清除缓存', '只删除本机缓存的邮件正文，下次打开时会重新下载', clear));
  main.appendChild(card);
  size.textContent = fmtSize(await api.cache.size());
}

async function about(main) {
  const info = await api.app.info();
  main.appendChild(pageHead('ABOUT', '关于与更新'));
  const card = h(`<div class="set-card about">
    <div class="about-top">
      <span class="logo-mark lg">汇</span>
      <div><div class="about-name">汇邮</div><div class="set-desc">版本 <span class="tabular">${escapeHtml(info.version)}</span> · 把所有邮箱汇到一处</div></div>
    </div>
  </div>`);
  const st = updateStatus();
  const stText = { checking: '正在检查…', downloading: `正在下载 ${st.version || ''}（${st.percent || 0}%）`, downloaded: `${st.version} 已下载，重启即可更新`, none: '已是最新版本', available: `发现新版本 ${st.version}`, error: st.message || '' }[st.state] || '';
  const check = h('<button class="btn btn-sm">检查更新</button>');
  check.onclick = () => api.update.check();
  card.appendChild(row('检查更新', stText, check));
  card.appendChild(row('自动更新', '安装版会在后台下载新版本，退出时自动安装', switchEl(state.settings.autoUpdate, (v) => save({ autoUpdate: v }))));
  const gh = h(`<button class="btn btn-ghost btn-sm">${icon('external', 14)}GitHub</button>`);
  gh.onclick = () => api.app.openExternal('https://github.com/Liyucheng1997/huiyou-mail');
  card.appendChild(row('项目主页', '下载、更新说明和问题反馈', gh));
  main.appendChild(card);
}
