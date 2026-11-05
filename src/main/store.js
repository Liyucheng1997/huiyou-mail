// 本地存储：设置、账户（密码用系统 safeStorage 加密）、界面状态。全部是 userData 下的 JSON 文件。
const { app, safeStorage } = require('electron');
const fs = require('fs');
const path = require('path');

const dir = () => app.getPath('userData');
const file = (name) => path.join(dir(), name);

function readJson(name, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file(name), 'utf8'));
  } catch {
    return fallback;
  }
}

function writeJson(name, data) {
  const p = file(name);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  const tmp = p + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2));
  fs.renameSync(tmp, p);
}

// ---------- 设置 ----------
const DEFAULT_SETTINGS = {
  theme: 'system', // system | light | dark
  syncInterval: 3, // 分钟
  notifications: true,
  closeToTray: true,
  openAtLogin: false,
  loadRemoteImages: false,
  autoUpdate: true,
  density: 'comfortable', // comfortable | compact
  markReadOnOpen: true,
};

let settingsCache = null;
const settings = {
  get() {
    if (!settingsCache) settingsCache = { ...DEFAULT_SETTINGS, ...readJson('settings.json', {}) };
    return settingsCache;
  },
  set(patch) {
    settingsCache = { ...settings.get(), ...patch };
    writeJson('settings.json', settingsCache);
    return settingsCache;
  },
};

// ---------- 账户 ----------
function encrypt(text) {
  if (!text) return '';
  if (safeStorage.isEncryptionAvailable()) return 'enc:' + safeStorage.encryptString(text).toString('base64');
  return 'b64:' + Buffer.from(text, 'utf8').toString('base64');
}

function decrypt(value) {
  if (!value) return '';
  if (value.startsWith('enc:')) return safeStorage.decryptString(Buffer.from(value.slice(4), 'base64'));
  if (value.startsWith('b64:')) return Buffer.from(value.slice(4), 'base64').toString('utf8');
  return value;
}

let accountsCache = null;
const accounts = {
  list() {
    if (!accountsCache) accountsCache = readJson('accounts.json', []);
    return accountsCache;
  },
  // 给渲染进程的版本：去掉密码
  publicList() {
    return accounts.list().map(({ password, ...rest }) => ({ ...rest, hasPassword: !!password }));
  },
  get(id) {
    return accounts.list().find((a) => a.id === id) || null;
  },
  password(id) {
    const a = accounts.get(id);
    return a ? decrypt(a.password) : '';
  },
  save(account, plainPassword) {
    const list = accounts.list();
    const i = list.findIndex((a) => a.id === account.id);
    const prev = i >= 0 ? list[i] : {};
    const next = { ...prev, ...account };
    if (plainPassword) next.password = encrypt(plainPassword);
    if (i >= 0) list[i] = next;
    else list.push(next);
    writeJson('accounts.json', list);
    return next;
  },
  remove(id) {
    accountsCache = accounts.list().filter((a) => a.id !== id);
    writeJson('accounts.json', accountsCache);
  },
  reorder(ids) {
    const list = accounts.list();
    accountsCache = ids.map((id) => list.find((a) => a.id === id)).filter(Boolean);
    for (const a of list) if (!accountsCache.includes(a)) accountsCache.push(a);
    writeJson('accounts.json', accountsCache);
  },
};

// ---------- 界面状态（窗口大小、上次选中的文件夹等） ----------
const state = {
  get() {
    return readJson('state.json', {});
  },
  set(patch) {
    const next = { ...state.get(), ...patch };
    writeJson('state.json', next);
    return next;
  },
};

module.exports = { settings, accounts, state, readJson, writeJson, dataDir: dir };
