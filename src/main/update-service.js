// 自动更新：安装版用 electron-updater 从 GitHub Releases 后台下载，退出时静默安装；
// 便携版无法自我替换，只检查新版本并提示去下载页。
const { app, net } = require('electron');
const settings = require('./store').settings;

const REPO = 'Liyucheng1997/huiyou-mail';
const FIRST_CHECK_DELAY = 15 * 1000;
const CHECK_INTERVAL = 4 * 60 * 60 * 1000;

let send = () => {};
let beforeInstall = () => {};
let updater = null;
let status = { state: 'idle' };
let manual = false; // 本次检查是用户手动发起的：要把“已是最新”和错误也告诉界面
let checking = null;
let timer = null;

const isPortable = () => !!process.env.PORTABLE_EXECUTABLE_DIR;

function setStatus(next) {
  status = { ...next, manual, current: app.getVersion(), portable: isPortable() };
  send('update:status', status);
}

function getUpdater() {
  if (updater) return updater;
  ({ autoUpdater: updater } = require('electron-updater'));
  updater.autoDownload = true;
  updater.autoInstallOnAppQuit = true;
  updater.logger = null;
  // 测试用：HUIYOU_UPDATE_URL 指向一个放着 latest.yml 的目录，代替 GitHub Releases
  if (process.env.HUIYOU_UPDATE_URL) updater.setFeedURL({ provider: 'generic', url: process.env.HUIYOU_UPDATE_URL });
  updater.on('checking-for-update', () => setStatus({ state: 'checking' }));
  updater.on('update-not-available', () => setStatus({ state: 'none' }));
  updater.on('update-available', (info) => setStatus({ state: 'downloading', version: info.version, percent: 0 }));
  updater.on('download-progress', (p) => setStatus({ ...status, state: 'downloading', percent: Math.floor(p.percent) }));
  updater.on('update-downloaded', (info) => setStatus({ state: 'downloaded', version: info.version, notes: releaseNotes(info.releaseNotes) }));
  updater.on('error', (err) => setStatus({ state: 'error', message: String((err && err.message) || err).split('\n')[0] }));
  return updater;
}

function releaseNotes(notes) {
  if (Array.isArray(notes)) notes = notes.map((n) => n.note).join('\n');
  // GitHub 返回的是 HTML，去掉标签只留文字
  return String(notes || '').replace(/<[^>]+>/g, '').replace(/\n{3,}/g, '\n\n').trim();
}

function newer(a, b) {
  const pa = a.split(/[.-]/).map((x) => parseInt(x, 10) || 0);
  const pb = b.split(/[.-]/).map((x) => parseInt(x, 10) || 0);
  for (let i = 0; i < 3; i++) if (pa[i] !== pb[i]) return pa[i] > pb[i];
  return false;
}

async function checkPortable() {
  setStatus({ state: 'checking' });
  try {
    const res = await net.fetch(`https://api.github.com/repos/${REPO}/releases/latest`, { headers: { Accept: 'application/vnd.github+json' } });
    if (!res.ok) throw new Error(`GitHub 返回 ${res.status}`);
    const rel = await res.json();
    const version = String(rel.tag_name || '').replace(/^v/, '');
    if (version && newer(version, app.getVersion())) setStatus({ state: 'available', version, url: rel.html_url, notes: String(rel.body || '').trim() });
    else setStatus({ state: 'none' });
  } catch (err) {
    setStatus({ state: 'error', message: err.message });
  }
}

async function check(isManual = false) {
  if (!app.isPackaged) {
    manual = isManual;
    return setStatus({ state: 'error', message: '从源码运行时不检查更新' });
  }
  // 正在下载或已经下载好了：不重复下载，把当前状态再告诉界面一次
  if (status.state === 'downloading' || status.state === 'downloaded') {
    manual = isManual;
    return setStatus(status);
  }
  if (checking) {
    manual = manual || isManual;
    return checking;
  }
  manual = isManual;
  // 失败时 updater 会发出 error 事件，这里只吞掉 Promise 的拒绝（包括后台下载的那个）
  const run = () => getUpdater().checkForUpdates().then((r) => {
    if (r && r.downloadPromise) r.downloadPromise.catch(() => {});
  }, () => {});
  checking = (isPortable() ? checkPortable() : run()).finally(() => {
    checking = null;
  });
  return checking;
}

function install() {
  if (status.state !== 'downloaded') return false;
  beforeInstall();
  // 静默安装（沿用原安装位置），装完自动重新打开
  setImmediate(() => getUpdater().quitAndInstall(true, true));
  return true;
}

function init(opts) {
  send = opts.send;
  beforeInstall = opts.beforeInstall;
  if (!app.isPackaged || timer) return;
  const auto = () => settings.get().autoUpdate && check(false);
  setTimeout(auto, FIRST_CHECK_DELAY);
  timer = setInterval(auto, CHECK_INTERVAL);
}

function register(ipcMain) {
  ipcMain.handle('update:status', () => ({ ...status, current: app.getVersion(), portable: isPortable() }));
  ipcMain.handle('update:check', async () => {
    await check(true);
  });
  ipcMain.handle('update:install', () => install());
}

module.exports = { init, register };
