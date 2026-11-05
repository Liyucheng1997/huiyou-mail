// OAuth 登录（Gmail / Outlook）：系统浏览器里授权 + 本机回环地址接收回调 + PKCE。
// 拿到的 refresh token 加密存进账户，access token 只放内存，过期前自动刷新。
const { shell, net } = require('electron');
const http = require('http');
const crypto = require('crypto');
const store = require('./store');
const builtin = require('./oauth-clients');

const PROVIDERS = {
  google: {
    name: 'Google',
    authUrl: 'https://accounts.google.com/o/oauth2/v2/auth',
    tokenUrl: 'https://oauth2.googleapis.com/token',
    scope: 'https://mail.google.com/ openid email profile',
    redirectHost: '127.0.0.1', // Google 桌面客户端：任意端口的 127.0.0.1 都可以
    extra: { access_type: 'offline', prompt: 'consent' },
    needsSecret: true,
  },
  microsoft: {
    name: 'Microsoft',
    authUrl: 'https://login.microsoftonline.com/common/oauth2/v2.0/authorize',
    tokenUrl: 'https://login.microsoftonline.com/common/oauth2/v2.0/token',
    scope: 'https://outlook.office.com/IMAP.AccessAsUser.All https://outlook.office.com/SMTP.Send offline_access openid email profile',
    redirectHost: 'localhost', // 应用注册里填 http://localhost，端口不参与匹配
    extra: { prompt: 'select_account' },
    scopeOnToken: true,
  },
};

const TIMEOUT = 5 * 60 * 1000;
const b64url = (buf) => Buffer.from(buf).toString('base64url');

function codeError(message, props = {}) {
  return Object.assign(new Error(message), props);
}

// 客户端 ID：设置里填的 > 环境变量 > 内置
function client(provider) {
  const s = ((store.settings.get().oauthClients || {})[provider]) || {};
  const env = (k) => process.env[`HUIYOU_${provider.toUpperCase()}_${k}`] || '';
  const b = builtin[provider] || {};
  const pick = (k, envKey) => String(s[k] || '').trim() || env(envKey) || b[k] || '';
  const clientId = pick('clientId', 'CLIENT_ID');
  const clientSecret = pick('clientSecret', 'CLIENT_SECRET');
  const source = String(s.clientId || '').trim() ? 'settings' : env('CLIENT_ID') ? 'env' : b.clientId ? 'builtin' : '';
  return { clientId, clientSecret, source };
}

// 测试用：HUIYOU_OAUTH_BASE 指向本地模拟服务器
function endpoints(provider) {
  const base = process.env.HUIYOU_OAUTH_BASE;
  if (base) return { authUrl: `${base}/${provider}/authorize`, tokenUrl: `${base}/${provider}/token` };
  return PROVIDERS[provider];
}

function status() {
  const out = {};
  for (const id of Object.keys(PROVIDERS)) {
    const c = client(id);
    out[id] = { name: PROVIDERS[id].name, configured: !!c.clientId && (!PROVIDERS[id].needsSecret || !!c.clientSecret), source: c.source };
  }
  return out;
}

function describe(data, provider) {
  const name = PROVIDERS[provider].name;
  const err = data.error || '';
  if (err === 'invalid_grant') return `${name} 授权已失效或被撤销，请重新登录`;
  if (err === 'invalid_client' || err === 'unauthorized_client') return `${name} 不认这个 OAuth 客户端：请检查“设置 → 登录方式”里的客户端 ID 和密钥`;
  if (err === 'access_denied') return '你在浏览器里取消了授权';
  return `${name} 登录失败：${data.error_description || err || '未知错误'}`.split('\n')[0];
}

async function tokenRequest(provider, params) {
  const c = client(provider);
  const body = new URLSearchParams({ client_id: c.clientId, ...params });
  if (c.clientSecret) body.set('client_secret', c.clientSecret);
  if (PROVIDERS[provider].scopeOnToken) body.set('scope', PROVIDERS[provider].scope);
  let res;
  try {
    res = await net.fetch(endpoints(provider).tokenUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
      body: body.toString(),
    });
  } catch (err) {
    throw codeError(`连不上 ${PROVIDERS[provider].name} 的登录服务器，请检查网络或代理（${err.message}）`, { network: true });
  }
  const data = await res.json().catch(() => ({}));
  if (!res.ok || data.error || !data.access_token) throw codeError(describe(data, provider), { oauthError: data.error || 'http_' + res.status });
  return data;
}

function decodeIdToken(token) {
  try {
    return JSON.parse(Buffer.from(String(token).split('.')[1], 'base64url').toString('utf8'));
  } catch {
    return {};
  }
}

// ---------- 浏览器授权 ----------
const PAGE = (ok, text) => `<!doctype html><meta charset="utf-8"><title>汇邮</title>
<style>body{margin:0;height:100vh;display:grid;place-items:center;background:#f5f5f7;font-family:-apple-system,"PingFang SC","Microsoft YaHei",sans-serif;color:#1d1d1f}
.c{background:#fff;border-radius:20px;padding:40px 48px;text-align:center;box-shadow:0 1px 2px rgba(0,0,0,.04),0 4px 16px rgba(0,0,0,.04);max-width:420px}
.i{width:48px;height:48px;border-radius:50%;margin:0 auto 16px;display:grid;place-items:center;color:#fff;font-size:24px;background:${ok ? '#0071e3' : '#d70015'}}
h1{font-size:22px;font-weight:600;letter-spacing:-.02em;margin:0 0 8px}p{color:#6e6e73;margin:0;line-height:1.6}
@media(prefers-color-scheme:dark){body{background:#000;color:#f5f5f7}.c{background:#1c1c1e}p{color:#a1a1a6}}</style>
<div class="c"><div class="i">${ok ? '✓' : '!'}</div><h1>${ok ? '已登录' : '登录没有完成'}</h1><p>${text}</p></div>`;

// 在本机随机端口上等授权回调；Microsoft 用 localhost，浏览器可能走 IPv6，所以两个地址都监听
function loopback(state, host) {
  return new Promise((resolve, reject) => {
    let settle;
    const result = new Promise((res, rej) => (settle = { res, rej }));
    result.catch(() => {}); // 由 authorize 处理；这里防止未处理的拒绝警告
    const onRequest = (req, res) => {
      const u = new URL(req.url, 'http://localhost');
      const q = u.searchParams;
      if (!q.has('code') && !q.has('error')) {
        res.writeHead(404).end();
        return;
      }
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
      if (q.get('state') !== state) {
        res.end(PAGE(false, '这次回调和汇邮发起的登录对不上，请回到汇邮重新点“登录”。'));
        return;
      }
      if (q.has('error')) {
        res.end(PAGE(false, q.get('error') === 'access_denied' ? '你取消了授权。可以关闭这个页面，回到汇邮重试。' : '授权失败，可以关闭这个页面，回到汇邮查看原因。'));
        settle.rej(codeError(describe({ error: q.get('error'), error_description: q.get('error_description') }, host.provider), { oauthError: q.get('error') }));
        return;
      }
      res.end(PAGE(true, '可以关闭这个页面，回到汇邮了。'));
      settle.res(q.get('code'));
    };
    const servers = [http.createServer(onRequest)];
    const close = () => servers.forEach((s) => s.close());
    servers[0].once('error', reject);
    servers[0].listen(0, '127.0.0.1', () => {
      const port = servers[0].address().port;
      if (host.name === 'localhost') {
        const v6 = http.createServer(onRequest);
        v6.on('error', () => {}); // 没有 IPv6 也没关系
        v6.listen(port, '::1');
        servers.push(v6);
      }
      resolve({ port, close, result, abort: (err) => settle.rej(err) });
    });
  });
}

let pending = null;

function cancel() {
  if (pending) pending.abort(codeError('已取消登录', { cancelled: true }));
}

async function authorize(provider, { loginHint } = {}) {
  const p = PROVIDERS[provider];
  if (!p) throw new Error('不支持的登录方式');
  const c = client(provider);
  if (!c.clientId || (p.needsSecret && !c.clientSecret))
    throw codeError(`还没有配置 ${p.name} 的 OAuth 客户端，请先到“设置 → 登录方式”填写`, { noClient: true });
  cancel();

  const verifier = b64url(crypto.randomBytes(32));
  const challenge = b64url(crypto.createHash('sha256').update(verifier).digest());
  const state = b64url(crypto.randomBytes(16));
  const lb = await loopback(state, { name: p.redirectHost, provider });
  const redirectUri = `http://${p.redirectHost}:${lb.port}`;
  const url = new URL(endpoints(provider).authUrl);
  const params = {
    client_id: c.clientId,
    response_type: 'code',
    redirect_uri: redirectUri,
    scope: p.scope,
    state,
    code_challenge: challenge,
    code_challenge_method: 'S256',
    ...p.extra,
  };
  if (loginHint) params.login_hint = loginHint;
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);

  const timer = setTimeout(() => lb.abort(codeError('等了 5 分钟还没有完成登录，已取消', { cancelled: true })), TIMEOUT);
  const me = (pending = { abort: lb.abort });
  try {
    if (process.env.HUIYOU_OAUTH_HEADLESS) net.fetch(url.toString()).catch((err) => lb.abort(err));
    else await shell.openExternal(url.toString());
    const code = await lb.result;
    const data = await tokenRequest(provider, { grant_type: 'authorization_code', code, redirect_uri: redirectUri, code_verifier: verifier });
    if (!data.refresh_token) throw new Error(`${p.name} 没有返回长期授权（refresh token），请重新登录一次`);
    const claims = decodeIdToken(data.id_token);
    const email = String(claims.email || claims.preferred_username || claims.upn || loginHint || '').trim();
    if (!email.includes('@')) throw new Error(`没能从 ${p.name} 拿到邮箱地址，请重试`);
    return issueTicket({
      provider,
      email,
      name: claims.name || '',
      refreshToken: data.refresh_token,
      accessToken: data.access_token,
      expiresAt: Date.now() + (Number(data.expires_in) || 3600) * 1000,
    });
  } finally {
    clearTimeout(timer);
    lb.close();
    if (pending === me) pending = null;
  }
}

// 登录结果先放在主进程里，渲染进程只拿到一张“票”，refresh token 不出主进程
const tickets = new Map();
function issueTicket(data) {
  const id = b64url(crypto.randomBytes(12));
  tickets.set(id, { ...data, issued: Date.now() });
  for (const [k, t] of tickets) if (Date.now() - t.issued > 30 * 60 * 1000) tickets.delete(k);
  return { ticket: id, provider: data.provider, email: data.email, name: data.name };
}
function ticket(id) {
  const t = tickets.get(id);
  if (!t) throw new Error('登录已过期，请重新点“登录”');
  return t;
}
function dropTicket(id) {
  tickets.delete(id);
}

// ---------- access token ----------
const cache = new Map(); // accountId -> { token, expiresAt }
const refreshing = new Map();

function reauthError(acc) {
  const name = (PROVIDERS[acc.oauthProvider] || {}).name || '';
  return codeError(`${name} 授权已失效，请在账户设置里重新登录`, { reauth: true });
}

async function accessToken(acc) {
  const c = cache.get(acc.id);
  if (c && c.expiresAt - Date.now() > 2 * 60 * 1000) return c.token;
  if (refreshing.has(acc.id)) return refreshing.get(acc.id);
  const job = (async () => {
    const rt = store.accounts.refreshToken(acc.id);
    if (!rt) throw reauthError(acc);
    let data;
    try {
      data = await tokenRequest(acc.oauthProvider, { grant_type: 'refresh_token', refresh_token: rt });
    } catch (err) {
      if (err.oauthError === 'invalid_grant') throw reauthError(acc);
      throw err;
    }
    // Microsoft 每次刷新都会换一个新的 refresh token
    if (data.refresh_token && data.refresh_token !== rt) store.accounts.setRefreshToken(acc.id, data.refresh_token);
    cache.set(acc.id, { token: data.access_token, expiresAt: Date.now() + (Number(data.expires_in) || 3600) * 1000 });
    return data.access_token;
  })();
  refreshing.set(acc.id, job);
  try {
    return await job;
  } finally {
    refreshing.delete(acc.id);
  }
}

function prime(accountId, t) {
  cache.set(accountId, { token: t.accessToken, expiresAt: t.expiresAt });
}

function forget(accountId) {
  cache.delete(accountId);
}

module.exports = { PROVIDERS, status, authorize, cancel, ticket, dropTicket, accessToken, prime, forget };
