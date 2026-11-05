// 汇邮 主进程：窗口、托盘、IPC、定时同步、新邮件通知。
const { app, BrowserWindow, ipcMain, shell, dialog, Tray, Menu, Notification, nativeImage, nativeTheme } = require('electron');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const store = require('./store');
const mail = require('./mail-service');
const providers = require('./providers');
const oauth = require('./oauth');
const ai = require('./ai-service');
const updater = require('./update-service');

const isDev = process.argv.includes('--dev');
const APP_NAME = '汇邮';
app.setName('Huiyou Mail');
// 开发 / 测试用：把数据放到单独目录，不碰正在使用的那份
if (process.env.HUIYOU_USER_DATA) app.setPath('userData', process.env.HUIYOU_USER_DATA);
// 任务栏按这个 ID 归组并缓存图标。开发时跑的是 electron.exe（Electron 图标），
// 用不同的 ID，免得 Windows 把安装版的任务栏图标记成 Electron 的
app.setAppUserModelId(app.isPackaged ? 'io.github.liyucheng1997.huiyou-mail' : 'io.github.liyucheng1997.huiyou-mail.dev');

let win = null;
let tray = null;
let quitting = false;
let syncTimer = null;

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => showWindow());
}

// 窗口 / 任务栏用多尺寸 ICO（Windows 下更清晰），托盘和通知用 PNG
const iconPath = (ext = 'png') => path.join(__dirname, '..', '..', 'build', `icon.${ext}`);

function send(channel, payload) {
  if (win && !win.isDestroyed()) win.webContents.send(channel, payload);
}

function titleColors(dark) {
  return dark ? { color: '#000000', symbolColor: '#f5f5f7', height: 54 } : { color: '#f5f5f7', symbolColor: '#1d1d1f', height: 54 };
}

function isDark() {
  const t = store.settings.get().theme;
  return t === 'dark' || (t === 'system' && nativeTheme.shouldUseDarkColors);
}

function createWindow() {
  const st = store.state.get();
  const b = st.bounds || {};
  win = new BrowserWindow({
    width: b.width || 1280,
    height: b.height || 820,
    x: b.x,
    y: b.y,
    minWidth: 760,
    minHeight: 520,
    show: false,
    title: APP_NAME,
    icon: iconPath(process.platform === 'win32' ? 'ico' : 'png'),
    backgroundColor: isDark() ? '#000000' : '#f5f5f7',
    titleBarStyle: 'hidden',
    titleBarOverlay: titleColors(isDark()),
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      spellcheck: false,
    },
  });
  if (st.maximized) win.maximize();
  win.loadFile(path.join(__dirname, '..', 'renderer', 'index.html'));
  win.once('ready-to-show', () => {
    if (!process.argv.includes('--hidden')) win.show();
  });

  // 邮件里的链接一律交给系统浏览器
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^(https?|mailto):/i.test(url)) shell.openExternal(url);
    return { action: 'deny' };
  });
  win.webContents.on('will-navigate', (e, url) => {
    if (url !== win.webContents.getURL()) {
      e.preventDefault();
      if (/^(https?|mailto):/i.test(url)) shell.openExternal(url);
    }
  });
  win.webContents.on('before-input-event', (e, input) => {
    if (input.type === 'keyDown' && input.key === 'F12') win.webContents.toggleDevTools();
    if (input.type === 'keyDown' && input.control && input.shift && input.key.toLowerCase() === 'r') win.webContents.reload();
  });

  const saveBounds = () => {
    if (!win || win.isDestroyed()) return;
    const maximized = win.isMaximized();
    store.state.set({ maximized, ...(maximized || win.isMinimized() ? {} : { bounds: win.getBounds() }) });
  };
  win.on('resize', debounce(saveBounds, 500));
  win.on('move', debounce(saveBounds, 500));
  win.on('close', (e) => {
    saveBounds();
    if (!quitting && store.settings.get().closeToTray && tray) {
      e.preventDefault();
      win.hide();
    }
  });
  win.on('closed', () => (win = null));
  if (isDev) win.webContents.openDevTools({ mode: 'detach' });
}

function debounce(fn, ms) {
  let t;
  return (...a) => {
    clearTimeout(t);
    t = setTimeout(() => fn(...a), ms);
  };
}

function showWindow() {
  if (!win) createWindow();
  if (win.isMinimized()) win.restore();
  win.show();
  win.focus();
}

function createTray() {
  const img = nativeImage.createFromPath(iconPath()).resize({ width: 16, height: 16 });
  tray = new Tray(img);
  tray.setToolTip(APP_NAME);
  tray.setContextMenu(
    Menu.buildFromTemplate([
      { label: '打开汇邮', click: showWindow },
      { label: '写邮件', click: () => (showWindow(), send('app:command', 'compose')) },
      { label: '立即收信', click: () => syncAll() },
      { type: 'separator' },
      { label: '退出', click: () => ((quitting = true), app.quit()) },
    ])
  );
  tray.on('click', showWindow);
}

// ---------- 同步调度 ----------
const firstRun = new Set();
async function syncAccount(id) {
  try {
    if (!firstRun.has(id)) {
      try {
        await mail.listFolders(id);
      } catch (err) {
        mail.reportError(id, err);
        throw err;
      }
      firstRun.add(id);
      send('mail:folders', { accountId: id });
    }
    await mail.syncFolder(id, mail.inboxPath(id));
  } catch {
    // 错误已经通过 mail:status 告诉界面
  }
}

async function syncAll() {
  await Promise.all(store.accounts.list().map((a) => syncAccount(a.id)));
}

function scheduleSync() {
  clearInterval(syncTimer);
  const minutes = Math.max(1, Number(store.settings.get().syncInterval) || 3);
  syncTimer = setInterval(syncAll, minutes * 60 * 1000);
}

// ---------- 新邮件通知 ----------
function notify({ accountId, path: p, newMessages }) {
  if (!newMessages || !newMessages.length || !store.settings.get().notifications || !Notification.isSupported()) return;
  if (p !== mail.inboxPath(accountId)) return;
  if (win && win.isVisible() && win.isFocused()) return;
  const acc = store.accounts.get(accountId);
  const first = newMessages[0];
  const n = new Notification({
    title: newMessages.length > 1 ? `${acc ? acc.email : ''} 收到 ${newMessages.length} 封新邮件` : first.from.name || first.from.address,
    body: newMessages.length > 1 ? newMessages.slice(0, 3).map((m) => `${m.from.name || m.from.address}：${m.subject}`).join('\n') : `${first.subject}\n${first.snippet || ''}`.trim(),
    icon: iconPath(),
    silent: false,
  });
  n.on('click', () => {
    showWindow();
    send('mail:open', { accountId, path: p, uid: first.uid });
  });
  n.show();
}

// ---------- IPC ----------
function handle(channel, fn) {
  ipcMain.handle(channel, async (_e, ...args) => {
    try {
      return { ok: true, data: await fn(...args) };
    } catch (err) {
      return { ok: false, error: (err && err.message) || String(err) };
    }
  });
}

function registerIpc() {
  handle('app:info', () => ({ version: app.getVersion(), name: APP_NAME, packaged: app.isPackaged, platform: process.platform }));
  handle('app:open-external', (url) => {
    if (/^(https?|mailto):/i.test(url)) shell.openExternal(url);
  });
  handle('app:set-title-colors', (dark) => {
    if (win) win.setTitleBarOverlay(titleColors(dark));
  });
  handle('app:set-badge', ({ count, dataUrl }) => {
    if (!win) return;
    win.setOverlayIcon(count > 0 && dataUrl ? nativeImage.createFromDataURL(dataUrl) : null, count > 0 ? `${count} 封未读` : '');
    win.setTitle(count > 0 ? `${APP_NAME}（${count}）` : APP_NAME);
    if (tray) tray.setToolTip(count > 0 ? `${APP_NAME} · ${count} 封未读` : APP_NAME);
  });
  handle('app:system-dark', () => nativeTheme.shouldUseDarkColors);

  handle('settings:get', () => store.settings.get());
  handle('settings:set', (patch) => {
    const next = store.settings.set(patch);
    if ('syncInterval' in patch) scheduleSync();
    if ('aiEffort' in patch || 'claudePath' in patch) ai.reset();
    if ('openAtLogin' in patch) app.setLoginItemSettings({ openAtLogin: !!patch.openAtLogin, args: ['--hidden'] });
    return next;
  });
  handle('state:get', () => store.state.get());
  handle('state:set', (patch) => store.state.set(patch));

  handle('providers:list', () => providers.PROVIDERS);
  handle('providers:detect', (email) => {
    const id = providers.detect(email);
    return { id, guess: providers.guess(email) };
  });

  handle('accounts:list', () => store.accounts.publicList());
  // oauthTicket：刚在浏览器里登录拿到的“票”；否则用填的密码，或已保存的凭据
  async function credentialsFor(account, password, oauthTicket) {
    if (oauthTicket) return { accessToken: oauth.ticket(oauthTicket).accessToken };
    if (password) return { pass: password };
    const saved = account.id && store.accounts.get(account.id);
    if (saved && saved.auth === 'oauth2') return { accessToken: await oauth.accessToken(saved) };
    return { pass: account.id ? store.accounts.password(account.id) : '' };
  }
  handle('accounts:test', async ({ account, password, oauthTicket }) => {
    const cred = await credentialsFor(account, password, oauthTicket);
    const acc = oauthTicket ? { ...account, auth: 'oauth2', oauthProvider: oauth.ticket(oauthTicket).provider } : account;
    return mail.testAccount(acc, cred);
  });
  handle('accounts:save', async ({ account, password, oauthTicket }) => {
    const isNew = !account.id;
    if (isNew) {
      account.id = crypto.randomUUID();
      account.createdAt = Date.now();
    }
    let secret = {};
    if (oauthTicket) {
      const t = oauth.ticket(oauthTicket);
      account.auth = 'oauth2';
      account.oauthProvider = t.provider;
      secret = { refreshToken: t.refreshToken };
      oauth.prime(account.id, t);
      oauth.dropTicket(oauthTicket);
    } else if (password) {
      account.auth = 'password';
      delete account.oauthProvider;
      secret = { password };
      oauth.forget(account.id);
    }
    const saved = store.accounts.save(account, secret);
    await mail.disconnect(saved.id);
    firstRun.delete(saved.id);
    syncAccount(saved.id);
    return store.accounts.publicList().find((a) => a.id === saved.id);
  });
  handle('accounts:remove', async (id) => {
    await mail.disconnect(id);
    oauth.forget(id);
    store.accounts.remove(id);
    mail.removeAccountCache(id);
    firstRun.delete(id);
  });
  handle('accounts:reorder', (ids) => store.accounts.reorder(ids));

  handle('ai:status', () => ai.status());
  handle('ai:send', (payload) => ai.send(payload));
  handle('ai:interrupt', () => ai.interrupt());
  handle('ai:reset', () => ai.reset());
  handle('ai:approve', ({ requestId, ok }) => ai.answerApproval(requestId, ok));
  handle('ai:resolve', (id) => ai.resolve(id));
  handle('ai:translate', (req) => {
    ai.translate(req); // 结果通过 ai:translate 事件流式推送
    return true;
  });
  handle('ai:translate-cancel', (requestId) => ai.cancelTranslate(requestId));
  handle('ai:translation', (ref) => ai.cachedTranslation(ref));
  handle('blocklist:list', () => store.blocklist.list());
  handle('blocklist:add', ({ senders, reason }) => store.blocklist.add(senders, reason));
  handle('blocklist:remove', (senders) => store.blocklist.remove(senders));

  handle('oauth:status', () => oauth.status());
  handle('oauth:start', async ({ provider, loginHint }) => {
    try {
      return await oauth.authorize(provider, { loginHint });
    } finally {
      // 浏览器里登录完，把汇邮带回前台
      if (win) {
        if (win.isMinimized()) win.restore();
        win.show();
        win.focus();
      }
    }
  });
  handle('oauth:cancel', () => oauth.cancel());

  handle('mail:sync-all', () => syncAll());
  handle('mail:status-all', () => mail.statusAll());
  handle('mail:folders', (accountId) => mail.loadFolders(accountId));
  handle('mail:refresh-folders', async (accountId) => {
    const list = await mail.listFolders(accountId);
    send('mail:folders', { accountId });
    return list;
  });
  handle('mail:sync', ({ accountId, path: p }) => mail.syncFolder(accountId, p));
  handle('mail:load-older', ({ accountId, path: p }) => mail.loadOlder(accountId, p));
  handle('mail:messages', (view) => mail.getMessages(view));
  handle('mail:unread', () => mail.unreadSummary());
  handle('mail:read', ({ accountId, path: p, uid }) => mail.readMessage(accountId, p, uid));
  handle('mail:flags', ({ accountId, path: p, uids, patch }) => mail.setFlags(accountId, p, uids, patch));
  handle('mail:move', ({ accountId, path: p, uids, dest }) => mail.moveMessages(accountId, p, uids, dest));
  handle('mail:delete', ({ accountId, path: p, uids, permanent }) => mail.deleteMessages(accountId, p, uids, { permanent }));
  handle('mail:archive', ({ accountId, path: p, uids }) => mail.archiveMessages(accountId, p, uids));
  handle('mail:spam', ({ accountId, path: p, uids }) => mail.markSpam(accountId, p, uids));
  handle('mail:search', ({ accountId, path: p, query }) => mail.search(accountId, p, query));
  handle('mail:create-folder', ({ accountId, name }) => mail.createFolder(accountId, name));
  handle('mail:contacts', () => mail.contacts());
  handle('mail:send', (draft) => mail.send(draft));
  handle('mail:save-draft', (draft) => mail.saveDraft(draft));

  handle('mail:save-attachment', async ({ accountId, path: p, uid, index }) => {
    const a = await mail.attachmentContent(accountId, p, uid, index);
    const res = await dialog.showSaveDialog(win, { defaultPath: path.join(app.getPath('downloads'), a.filename) });
    if (res.canceled || !res.filePath) return null;
    fs.writeFileSync(res.filePath, a.content);
    return res.filePath;
  });
  handle('mail:open-attachment', async ({ accountId, path: p, uid, index }) => {
    const a = await mail.attachmentContent(accountId, p, uid, index);
    const dir = path.join(os.tmpdir(), 'huiyou-mail', crypto.randomUUID().slice(0, 8));
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, a.filename.replace(/[\\/:*?"<>|]/g, '_'));
    fs.writeFileSync(file, a.content);
    const err = await shell.openPath(file);
    if (err) throw new Error(err);
    return file;
  });
  handle('mail:pick-files', async () => {
    const res = await dialog.showOpenDialog(win, { properties: ['openFile', 'multiSelections'] });
    if (res.canceled) return [];
    return res.filePaths.map((f) => ({ path: f, name: path.basename(f), size: fs.statSync(f).size }));
  });
  handle('mail:file-info', (paths) =>
    paths.filter((f) => fs.existsSync(f) && fs.statSync(f).isFile()).map((f) => ({ path: f, name: path.basename(f), size: fs.statSync(f).size }))
  );

  handle('cache:size', () => mail.cacheSize());
  handle('cache:clear', () => mail.clearBodyCache());

  updater.register(ipcMain);
}

app.whenReady().then(() => {
  if (!app.requestSingleInstanceLock()) return;
  Menu.setApplicationMenu(null);
  mail.init({
    emit: (channel, payload) => {
      send(channel, payload);
      if (channel === 'mail:changed') notify(payload);
    },
  });
  ai.init((channel, payload) => send(channel, payload));
  registerIpc();
  createWindow();
  createTray();
  nativeTheme.on('updated', () => send('theme:system-changed', nativeTheme.shouldUseDarkColors));
  updater.init({
    send,
    beforeInstall: () => {
      quitting = true;
    },
  });
  scheduleSync();
  // 启动后先同步一次（界面会显示缓存，再刷新）
  setTimeout(syncAll, 600);
});

app.on('before-quit', () => {
  quitting = true;
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

app.on('will-quit', () => {
  ai.reset();
  mail.disconnectAll();
});
