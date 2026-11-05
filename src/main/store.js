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
  oauthClients: {},
  aiEffort: 'medium', // low | medium | high
  autoTranslate: false, // 打开外语邮件时自动翻译成中文
  claudePath: '', // 留空自动检测 // { google: { clientId, clientSecret }, microsoft: { clientId } }
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
  // 给渲染进程的版本：去掉密码和 OAuth 令牌
  publicList() {
    return accounts.list().map(({ password, refreshToken, ...rest }) => ({ ...rest, hasPassword: !!password, hasToken: !!refreshToken }));
  },
  get(id) {
    return accounts.list().find((a) => a.id === id) || null;
  },
  password(id) {
    const a = accounts.get(id);
    return a ? decrypt(a.password) : '';
  },
  refreshToken(id) {
    const a = accounts.get(id);
    return a ? decrypt(a.refreshToken) : '';
  },
  setRefreshToken(id, token) {
    const a = accounts.get(id);
    if (!a) return;
    a.refreshToken = encrypt(token);
    writeJson('accounts.json', accounts.list());
  },
  // secret: { password } 或 { refreshToken }；换了登录方式就清掉另一种凭据
  save(account, secret = {}) {
    const list = accounts.list();
    const i = list.findIndex((a) => a.id === account.id);
    const prev = i >= 0 ? list[i] : {};
    const next = { ...prev, ...account };
    delete next.hasPassword;
    delete next.hasToken;
    if (secret.refreshToken) {
      next.refreshToken = encrypt(secret.refreshToken);
      delete next.password;
    } else if (secret.password) {
      next.password = encrypt(secret.password);
      delete next.refreshToken;
    }
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

// ---------- 黑名单：完整地址（a@b.com）或整个域名（@b.com，含子域名） ----------
function normPattern(x) {
  let v = String(x || '').trim().toLowerCase().replace(/^mailto:/, '');
  const m = v.match(/<([^>]+)>/);
  if (m) v = m[1];
  if (!v) return '';
  if (!v.includes('@')) v = '@' + v; // 只给了域名
  return /^[^\s@]*@[^\s@]+\.[^\s@]+$/.test(v) ? v : '';
}
const blocklist = {
  list() {
    return readJson('blocklist.json', []);
  },
  add(patterns, reason = '') {
    const list = blocklist.list();
    const have = new Set(list.map((b) => b.pattern));
    const added = [];
    for (const x of patterns) {
      const pattern = normPattern(x);
      if (!pattern || have.has(pattern)) continue;
      have.add(pattern);
      list.push({ pattern, reason: String(reason || '').slice(0, 200), addedAt: Date.now() });
      added.push(pattern);
    }
    writeJson('blocklist.json', list);
    return added;
  },
  remove(patterns) {
    const drop = new Set(patterns.map(normPattern));
    const list = blocklist.list().filter((b) => !drop.has(b.pattern));
    writeJson('blocklist.json', list);
    return list;
  },
  matcher() {
    const list = blocklist.list();
    if (!list.length) return () => null;
    return (address) => {
      const a = String(address || '').toLowerCase();
      if (!a) return null;
      const domain = a.split('@')[1] || '';
      return (
        list.find((b) => {
          if (!b.pattern.startsWith('@')) return b.pattern === a;
          const d = b.pattern.slice(1);
          return domain === d || domain.endsWith('.' + d);
        }) || null
      );
    };
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

module.exports = { settings, accounts, blocklist, state, readJson, writeJson, dataDir: dir };
