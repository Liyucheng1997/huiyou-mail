// 邮件服务：每个账户一条长连接的 IMAP（imapflow），本地缓存邮件摘要和原文，SMTP 发信（nodemailer）。
const { app } = require('electron');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { ImapFlow } = require('imapflow');
const nodemailer = require('nodemailer');
const MailComposer = require('nodemailer/lib/mail-composer');
const { simpleParser } = require('mailparser');
const store = require('./store');
const oauth = require('./oauth');
const { makeSnippet, findTextPart, hasAttachments, guessSpecial, sortFolders, SPECIAL_NAMES, litePlan, buildLite, decodePart } = require('./mail-text');

const INITIAL_COUNT = 150; // 第一次同步一个文件夹时拉取的邮件数
const PAGE_COUNT = 100; // “加载更早的邮件”每次的数量
const KEEP_MAX = 2000; // 每个文件夹本地最多缓存的摘要数
const LITE_MIN = 512 * 1024; // 比这大的邮件先只下正文，附件用到时再下
const PREFETCH_MAX = 20; // 每次收信后，后台提前下好最新几封的正文
const READER_IDLE = 15 * 60 * 1000; // 读信连接闲置这么久就断开

let emit = () => {};
// 每个账户两条连接：主连接收信、改标记、等推送；读信连接只管下载正文和附件，这样点开邮件不用排在收信后面
const clients = new Map(); // 连接名 -> { client, connecting }
const READ = 'read';
const connKey = (accountId, role) => (role === READ ? accountId + '\n' + READ : accountId);

// ---------- 缓存 ----------
const cacheRoot = () => path.join(store.dataDir(), 'cache');
const hash = (s) => crypto.createHash('sha1').update(s).digest('hex').slice(0, 16);
const accDir = (id) => path.join(cacheRoot(), id);
const folderFile = (id, p) => path.join(accDir(id), 'msgs', hash(p) + '.json');
// 一封邮件在本机的几种缓存：完整原文、只有正文的“精简版”、单独下载的附件
function bodyFiles(id, p, uid) {
  const base = path.join(accDir(id), 'bodies', `${hash(p)}_${loadFolder(id, p).uidValidity || '0'}_${uid}`);
  return { full: base + '.eml', lite: base + '.lite.eml', part: (n) => `${base}.p${String(n).replace(/[^\d.]/g, '')}.bin` };
}
function writeFile(file, buf) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file + '.tmp', buf);
  fs.renameSync(file + '.tmp', file);
}

function readJson(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return fallback;
  }
}
function writeJson(file, data) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file + '.tmp', JSON.stringify(data));
  fs.renameSync(file + '.tmp', file);
}

const memo = new Map(); // 文件夹缓存的内存副本
function loadFolder(id, p) {
  const key = id + '\n' + p;
  if (!memo.has(key)) memo.set(key, readJson(folderFile(id, p), { uidValidity: null, messages: [], total: 0, unread: 0, complete: false }));
  return memo.get(key);
}
function saveFolder(id, p, data) {
  memo.set(id + '\n' + p, data);
  writeJson(folderFile(id, p), data);
}

function loadFolders(id) {
  return readJson(path.join(accDir(id), 'folders.json'), []);
}
function saveFolders(id, list) {
  writeJson(path.join(accDir(id), 'folders.json'), list);
}

// ---------- 连接 ----------
// 凭据：密码 / 授权码账户是 { pass }，OAuth 账户是 { accessToken }（过期前自动刷新）
async function credentials(acc) {
  if (acc.auth === 'oauth2') return { accessToken: await oauth.accessToken(acc) };
  return { pass: store.accounts.password(acc.id) };
}

function authOf(acc, cred) {
  const user = acc.username || acc.email;
  return cred.accessToken ? { user, accessToken: cred.accessToken } : { user, pass: cred.pass };
}

function imapOptions(acc, cred, role) {
  return {
    host: acc.imap.host,
    port: Number(acc.imap.port) || 993,
    secure: !!acc.imap.secure,
    auth: authOf(acc, cred),
    logger: false,
    clientInfo: { name: 'Huiyou Mail', version: app.getVersion(), vendor: 'Huiyou' }, // 网易邮箱要求客户端发送 ID
    tls: { rejectUnauthorized: !acc.allowInsecure },
    connectionTimeout: 30000,
    greetingTimeout: 20000,
    // 连接悄悄断掉（休眠、换网络）时，2 分钟没回音就放弃重连，不让一次收信卡上 5 分钟
    socketTimeout: 2 * 60 * 1000,
  };
}

function isAuthFailure(err) {
  const msg = String((err && (err.responseText || err.message)) || err || '');
  return !!(err && (err.authenticationFailed || /AUTHENTICATIONFAILED|Invalid credentials|LOGIN failed|authentication failed|535|AUTHENTICATE failed/i.test(msg)));
}

function friendlyError(err, acc = null) {
  const msg = String((err && (err.responseText || err.message)) || err || '未知错误');
  if (err && (err.reauth || err.noClient || err.network)) return err.message;
  if (isAuthFailure(err) && acc && acc.auth === 'oauth2') {
    const name = (oauth.PROVIDERS[acc.oauthProvider] || {}).name || '';
    return `${name} 拒绝了登录：授权可能已失效，或网页版邮箱没有开启 IMAP，请在账户设置里重新登录`;
  }
  if (isAuthFailure(err)) return '登录失败：请确认使用的是授权码 / 应用专用密码，并已在网页版开启 IMAP/SMTP';
  if (/Unsafe Login/i.test(msg)) return '网易拦截了这次登录（Unsafe Login），请在网页版邮箱里确认已开启 IMAP 服务';
  if (/ENOTFOUND|EAI_AGAIN/.test(msg)) return '找不到服务器，请检查服务器地址和网络';
  if (/ETIMEDOUT|timeout/i.test(msg)) return '连接超时，请检查网络或代理';
  if (/ECONNREFUSED/.test(msg)) return '服务器拒绝连接，请检查端口';
  if (/certificate|self.signed|CERT_/i.test(msg)) return '服务器证书无效：' + msg;
  return msg.split('\n')[0];
}

const lastStatus = {}; // 界面刷新后能拿回各账户的同步状态
function status(accountId, s) {
  lastStatus[accountId] = { ...(lastStatus[accountId] || {}), ...s, accountId };
  if (s.state !== 'error') {
    delete lastStatus[accountId].message;
    delete lastStatus[accountId].reauth;
  }
  emit('mail:status', lastStatus[accountId]);
}

async function getClient(accountId, role) {
  const key = connKey(accountId, role);
  let entry = clients.get(key);
  if (entry && entry.client && entry.client.usable) return entry.client;
  if (entry && entry.connecting) return entry.connecting;
  const acc = store.accounts.get(accountId);
  if (!acc) throw new Error('账户不存在');
  entry = entry || {};
  clients.set(key, entry);
  entry.connecting = (async () => {
    const client = new ImapFlow(imapOptions(acc, await credentials(acc), role));
    client.on('error', () => {}); // 错误在调用处处理；这里防止未捕获异常
    client.on('close', () => {
      if (entry.client === client) entry.client = null;
    });
    if (role !== READ) {
      client.on('exists', (info) => {
        if (info && info.count > info.prevCount) scheduleSync(accountId, info.path);
      });
    }
    try {
      await client.connect();
    } catch (err) {
      if (acc.auth === 'oauth2' && isAuthFailure(err)) oauth.forget(accountId); // 下次重新换一个 access token
      throw err;
    }
    entry.client = client;
    entry.capabilities = client.capabilities;
    return client;
  })();
  try {
    return await entry.connecting;
  } finally {
    entry.connecting = null;
  }
}

async function closeConn(key) {
  const entry = clients.get(key);
  clients.delete(key);
  if (entry && entry.client) {
    try {
      await entry.client.logout();
    } catch {
      entry.client.close();
    }
  }
}

async function disconnect(accountId) {
  clearTimeout(readerTimers.get(accountId));
  await Promise.all([closeConn(connKey(accountId)), closeConn(connKey(accountId, READ))]);
}

async function disconnectAll() {
  await Promise.all([...clients.keys()].map(closeConn));
}

// 电脑从休眠醒来：旧连接多半已经断了但自己不知道，直接扔掉，下次用时重连
function dropConnections() {
  for (const entry of clients.values()) {
    const c = entry.client;
    entry.client = null;
    if (c) {
      try {
        c.close();
      } catch {}
    }
  }
}

// 拿到连接执行操作；连接断了会重连一次
async function withClient(accountId, fn, { role, retry = true } = {}) {
  let client;
  try {
    client = await getClient(accountId, role);
    return await fn(client);
  } catch (err) {
    if (err && (err.reauth || err.noClient || err.network || err.gone)) throw err; // 重连也没用
    const dropped = !client || !client.usable || /Connection not available|closed|ECONNRESET|EPIPE|socket/i.test(String(err && err.message));
    if (retry && dropped) {
      const entry = clients.get(connKey(accountId, role));
      if (entry && (!client || entry.client === client)) entry.client = null;
      return withClient(accountId, fn, { role, retry: false });
    }
    throw err;
  }
}

// 对某个文件夹加锁执行操作
function withMailbox(accountId, p, fn, opts) {
  return withClient(
    accountId,
    async (client) => {
      const lock = await client.getMailboxLock(p);
      try {
        return await fn(client);
      } finally {
        lock.release();
      }
    },
    opts
  );
}

// ---------- 读信连接上的任务队列 ----------
// 一次只跑一个。用户点开的（priority 0）排在后台预取（priority 1）前面，而且后点的先做
const readQueues = new Map(); // accountId -> { jobs, running }
const readerTimers = new Map();

function readJob(accountId, p, fn, priority = 0) {
  let q = readQueues.get(accountId);
  if (!q) readQueues.set(accountId, (q = { jobs: [], running: false }));
  const job = { p, fn, priority };
  const promise = new Promise((resolve, reject) => Object.assign(job, { resolve, reject }));
  q.jobs.push(job);
  pumpReads(accountId, q);
  return { promise, job };
}

// 用户等不及点开了一封正在排队预取的邮件：提到最前面
function hurry(accountId, job) {
  const q = readQueues.get(accountId);
  job.priority = 0;
  const i = q ? q.jobs.indexOf(job) : -1;
  if (i >= 0) q.jobs.push(q.jobs.splice(i, 1)[0]);
}

async function pumpReads(accountId, q) {
  if (q.running) return;
  q.running = true;
  clearTimeout(readerTimers.get(accountId));
  while (q.jobs.length) {
    let i = q.jobs.findLastIndex((j) => j.priority === 0);
    if (i < 0) i = 0;
    const job = q.jobs.splice(i, 1)[0];
    try {
      job.resolve(await withMailbox(accountId, job.p, job.fn, { role: READ }));
    } catch (err) {
      job.reject(err);
    }
  }
  q.running = false;
  touchReader(accountId);
}

// 读信连接很久没用就断开
function touchReader(accountId) {
  clearTimeout(readerTimers.get(accountId));
  readerTimers.set(
    accountId,
    setTimeout(() => {
      const q = readQueues.get(accountId);
      if (!q || !q.running) closeConn(connKey(accountId, READ)).catch(() => {});
    }, READER_IDLE)
  );
}

// 用户回到窗口时提前把读信连接连好（登录要一两秒），这样点开第一封也不用等。
// 只给主连接正常的账户连，登录有问题的不在这里反复试
function warmReaders() {
  for (const acc of store.accounts.list()) {
    const main = clients.get(connKey(acc.id));
    if (!main || !main.client || !main.client.usable) continue;
    const reader = clients.get(connKey(acc.id, READ));
    if (reader && ((reader.client && reader.client.usable) || reader.connecting)) touchReader(acc.id);
    else readJob(acc.id, inboxPath(acc.id), async () => {}, 1).promise.catch(() => {});
  }
}

// ---------- 文件夹 ----------
async function listFolders(accountId) {
  const client = await getClient(accountId);
  const raw = await client.list({ statusQuery: { messages: true, unseen: true } });
  const list = raw
    .filter((f) => !(f.flags && f.flags.has('\\Noselect')) && !(f.flags && f.flags.has('\\NonExistent')))
    .map((f) => {
      const specialUse = guessSpecial(f);
      return {
        path: f.path,
        name: SPECIAL_NAMES[specialUse] || f.name,
        rawName: f.name,
        delimiter: f.delimiter,
        parent: f.parentPath || '',
        specialUse,
        total: f.status ? f.status.messages : 0,
        unread: f.status ? f.status.unseen : 0,
      };
    });
  sortFolders(list);
  saveFolders(accountId, list);
  return list;
}

function folderBySpecial(accountId, use) {
  return loadFolders(accountId).find((f) => f.specialUse === use) || null;
}

function inboxPath(accountId) {
  const f = folderBySpecial(accountId, '\\Inbox');
  return f ? f.path : 'INBOX';
}

// ---------- 摘要 ----------
const addr = (a) => ({ name: (a && a.name) || '', address: (a && a.address) || '' });

function toSummary(accountId, p, msg) {
  const env = msg.envelope || {};
  const flags = msg.flags || new Set();
  return {
    accountId,
    path: p,
    uid: msg.uid,
    messageId: env.messageId || '',
    inReplyTo: env.inReplyTo || '',
    subject: env.subject || '',
    from: addr((env.from || [])[0] || (env.sender || [])[0]),
    to: (env.to || []).map(addr),
    cc: (env.cc || []).map(addr),
    date: new Date(env.date || msg.internalDate || Date.now()).getTime() || Date.now(),
    seen: flags.has('\\Seen'),
    flagged: flags.has('\\Flagged'),
    answered: flags.has('\\Answered'),
    draft: flags.has('\\Draft'),
    attachments: hasAttachments(msg.bodyStructure),
    size: msg.size || 0,
    threadId: msg.threadId || '',
    snippet: '',
    _text: findTextPart(msg.bodyStructure),
  };
}

const SUMMARY_QUERY = { uid: true, flags: true, envelope: true, bodyStructure: true, internalDate: true, size: true };

// keep：只留下符合条件的（“N:*”即使没有新邮件，服务器也会把最后一封发回来）
async function fetchSummaries(client, accountId, p, range, opts, keep = null) {
  const out = [];
  const query = { ...SUMMARY_QUERY };
  if (client.capabilities && client.capabilities.has('X-GM-EXT-1')) query.threadId = true;
  for await (const msg of client.fetch(range, query, opts)) {
    const m = toSummary(accountId, p, msg);
    if (!keep || keep(m)) out.push(m);
  }
  await fillSnippets(client, out);
  for (const m of out) delete m._text;
  return out;
}

// 只取正文开头的 3KB 生成预览；按正文所在的 part 编号分组批量拉取
async function fillSnippets(client, list) {
  const groups = new Map();
  for (const m of list) {
    if (!m._text) continue;
    if (!groups.has(m._text.key)) groups.set(m._text.key, []);
    groups.get(m._text.key).push(m);
  }
  for (const [key, msgs] of groups) {
    const byUid = new Map(msgs.map((m) => [m.uid, m]));
    for (let i = 0; i < msgs.length; i += 200) {
      const uids = msgs.slice(i, i + 200).map((m) => m.uid).join(',');
      try {
        for await (const res of client.fetch(uids, { uid: true, bodyParts: [{ key, maxLength: 3000 }] }, { uid: true })) {
          const m = byUid.get(res.uid);
          const buf = res.bodyParts && [...res.bodyParts.values()][0];
          if (!m || !buf) continue;
          const binary = res.binaryParts && res.binaryParts.size > 0;
          m.snippet = makeSnippet(buf, binary ? { ...m._text, encoding: '' } : m._text);
        }
      } catch {
        // 预览失败不影响同步
      }
    }
  }
}

function publicFolder(data) {
  return { total: data.total, unread: data.unread, complete: data.complete, count: data.messages.length };
}

// ---------- 同步 ----------
const syncing = new Map(); // key -> promise
const timers = new Map();

function scheduleSync(accountId, p) {
  const key = accountId + '\n' + p;
  clearTimeout(timers.get(key));
  timers.set(
    key,
    setTimeout(() => {
      timers.delete(key);
      syncFolder(accountId, p).catch(() => {});
    }, 800)
  );
}

// 收件箱里新收到的、来自黑名单发件人的邮件：直接移到“已删除”，也不弹通知
async function applyBlocklist(accountId, p, result) {
  if (p !== inboxPath(accountId) || !result.fetched || !result.fetched.length) return;
  const match = store.blocklist.matcher();
  const hit = result.fetched.filter((m) => match(m.from && m.from.address));
  if (!hit.length) return;
  const uids = new Set(hit.map((m) => m.uid));
  result.newMessages = result.newMessages.filter((m) => !uids.has(m.uid));
  await deleteMessages(accountId, p, [...uids]).catch(() => {});
}

// ---------- 会话（同一个对话的往来邮件，包括自己的回复） ----------
// 连接停在哪个文件夹，服务器就只推送那个文件夹的新邮件（IDLE）。看完别的文件夹后切回收件箱。
const idleTimers = new Map();
function idleInbox(accountId) {
  clearTimeout(idleTimers.get(accountId));
  idleTimers.set(
    accountId,
    setTimeout(() => {
      idleTimers.delete(accountId);
      withMailbox(accountId, inboxPath(accountId), async () => {}).catch(() => {});
    }, 1500)
  );
}

const THREAD_SKIP = ['\\Trash', '\\Junk', '\\Drafts'];
const threadKey = (m) => m.messageId || `${m.path}\n${m.uid}`;

// 本机缓存里找：Gmail 用对话编号，其他邮箱顺着 Message-ID / In-Reply-To 串起来
function localThread(accountId, cur) {
  const pool = [];
  for (const f of loadFolders(accountId)) {
    if (THREAD_SKIP.includes(f.specialUse)) continue;
    if (!memo.has(accountId + '\n' + f.path) && !fs.existsSync(folderFile(accountId, f.path))) continue;
    pool.push(...loadFolder(accountId, f.path).messages);
  }
  if (cur.threadId) return pool.filter((m) => m.threadId === cur.threadId);
  const ids = new Set([cur.messageId, cur.inReplyTo].filter(Boolean));
  const out = new Map([[threadKey(cur), cur]]);
  if (!ids.size) return [cur];
  for (let grew = true; grew; ) {
    grew = false;
    for (const m of pool) {
      if (out.has(threadKey(m))) continue;
      if ((m.messageId && ids.has(m.messageId)) || (m.inReplyTo && ids.has(m.inReplyTo))) {
        out.set(threadKey(m), m);
        if (m.messageId) ids.add(m.messageId);
        if (m.inReplyTo) ids.add(m.inReplyTo);
        grew = true;
      }
    }
  }
  return [...out.values()];
}

async function thread(accountId, p, uid) {
  const cur = loadFolder(accountId, p).messages.find((m) => m.uid === uid);
  if (!cur) return [];
  // 已发送还没同步过：先拉一次，这样能看到自己的回复
  const sent = folderBySpecial(accountId, '\\Sent');
  if (sent && sent.path !== p && !memo.has(accountId + '\n' + sent.path) && !fs.existsSync(folderFile(accountId, sent.path))) {
    await syncFolder(accountId, sent.path).catch(() => {});
    idleInbox(accountId);
  }
  let list = [];
  // Gmail：在“所有邮件”里按对话编号搜，能找到没缓存的更早往来
  const all = folderBySpecial(accountId, '\\All');
  if (cur.threadId && all) {
    try {
      list = await withMailbox(accountId, all.path, async (client) => {
        const uids = ((await client.search({ threadId: cur.threadId }, { uid: true })) || []).sort((a, b) => a - b).slice(-50);
        // 对话里只有这一封（大多数邮件都是）：不用再拉摘要
        return uids.length > 1 ? fetchSummaries(client, accountId, all.path, uids.join(','), { uid: true }) : [];
      });
      idleInbox(accountId);
    } catch {
      list = [];
    }
  }
  if (list.length < 2) list = localThread(accountId, cur);
  // 同一封邮件可能同时在收件箱和“所有邮件”里：按 Message-ID 去重，优先用当前文件夹那份
  const seen = new Map();
  for (const m of list) {
    const k = threadKey(m);
    const prev = seen.get(k);
    if (!prev || (m.path === p && m.uid === uid)) seen.set(k, m);
  }
  const own = ownAddresses();
  return [...seen.values()]
    .sort((a, b) => a.date - b.date)
    .map((m) => ({
      ...m,
      self: own.has(String((m.from && m.from.address) || '').toLowerCase()),
      current: (m.path === p && m.uid === uid) || (!!cur.messageId && m.messageId === cur.messageId),
    }));
}

// 把错误告诉界面（侧栏红字 / 状态栏），返回给用户看的说明
function reportError(accountId, err, p = null) {
  const acc = store.accounts.get(accountId);
  const message = friendlyError(err, acc);
  const reauth = !!err.reauth || !!(acc && acc.auth === 'oauth2' && isAuthFailure(err));
  status(accountId, { state: 'error', path: p, message, reauth });
  return message;
}

// 文件夹的“指纹”：不用打开文件夹，一条 STATUS 就能问到。
// 支持 CONDSTORE 的服务器（Gmail 等）上，邮件数、下一个编号、修改序号都没变 = 什么都没变
async function folderSig(accountId, p) {
  try {
    const st = await withClient(accountId, (client) => client.status(p, { messages: true, uidNext: true, uidValidity: true, unseen: true, highestModseq: true }));
    if (!st || st.highestModseq == null || st.uidNext == null || st.messages == null) return null;
    return { uidValidity: String(st.uidValidity), uidNext: Number(st.uidNext), exists: Number(st.messages), modseq: String(st.highestModseq), unseen: Number(st.unseen) || 0 };
  } catch (err) {
    if (err && (err.reauth || isAuthFailure(err))) throw err;
    return null; // 服务器不支持就走完整同步
  }
}

const sameSig = (data, sig) =>
  !!data.sig && data.uidValidity === sig.uidValidity && data.sig.modseq === sig.modseq && data.sig.uidNext === sig.uidNext && data.sig.exists === sig.exists;

function syncFolder(accountId, p) {
  const key = accountId + '\n' + p;
  if (syncing.has(key)) return syncing.get(key);
  const run = (async () => {
    status(accountId, { state: 'syncing', path: p });
    try {
      const sig = await folderSig(accountId, p);
      const cached = loadFolder(accountId, p);
      let result;
      if (sig && sameSig(cached, sig)) {
        // 和上次同步完全一样：不用打开文件夹，也不用通知界面
        if (cached.unread !== sig.unseen) {
          cached.unread = sig.unseen;
          saveFolder(accountId, p, cached);
          updateFolderCounts(accountId, p, cached);
          emit('mail:changed', { accountId, path: p, newMessages: [] });
        }
        result = { ...publicFolder(cached), newMessages: [] };
      } else {
        result = await withMailbox(accountId, p, (client) => doSync(client, accountId, p, sig));
        await applyBlocklist(accountId, p, result);
        if (p === inboxPath(accountId)) prefetch(accountId, p, result.newMessages);
        delete result.fetched;
        if (p !== inboxPath(accountId)) idleInbox(accountId);
        emit('mail:changed', { accountId, path: p, newMessages: result.newMessages });
      }
      status(accountId, { state: 'idle', path: p, lastSync: Date.now() });
      return result;
    } catch (err) {
      throw new Error(reportError(accountId, err, p));
    }
  })();
  syncing.set(key, run);
  run.finally(() => syncing.delete(key)).catch(() => {});
  return run;
}

const withFlags = (m, f) => ({ ...m, seen: f.has('\\Seen'), flagged: f.has('\\Flagged'), answered: f.has('\\Answered'), draft: f.has('\\Draft') });

// sig：同步前问到的指纹（服务器不支持时为 null）
async function doSync(client, accountId, p, sig) {
  const mb = client.mailbox;
  const uidValidity = String(mb.uidValidity);
  let data = loadFolder(accountId, p);
  const firstSync = data.uidValidity === null;
  if (data.uidValidity !== uidValidity) data = { uidValidity, messages: [], total: 0, unread: 0, complete: false };
  if (sig && sig.uidValidity !== uidValidity) sig = null;
  const nextSig = sig ? { modseq: sig.modseq, uidNext: sig.uidNext, exists: sig.exists } : null;

  if (!mb.exists) {
    data = { ...data, messages: [], total: 0, unread: 0, complete: true, sig: nextSig };
    saveFolder(accountId, p, data);
    updateFolderCounts(accountId, p, data);
    return { ...publicFolder(data), newMessages: [] };
  }

  const known = data.messages;
  const highest = known.length ? known[0].uid : 0;
  let fresh;
  if (!known.length) {
    const start = Math.max(1, mb.exists - INITIAL_COUNT + 1);
    fresh = await fetchSummaries(client, accountId, p, `${start}:*`, {});
    data.complete = start === 1;
  } else if (mb.uidNext && Number(mb.uidNext) <= highest + 1) {
    fresh = []; // 下一个编号还没动过：没有新邮件
  } else {
    fresh = await fetchSummaries(client, accountId, p, `${highest + 1}:*`, { uid: true }, (m) => m.uid > highest);
  }

  // 刷新已缓存邮件的标记，并去掉服务器上已经不存在的
  let kept = known;
  if (known.length) {
    const range = `${known[known.length - 1].uid}:${highest}`;
    const since = sig && data.sig && data.sig.modseq && client.enabled && client.enabled.has('CONDSTORE') ? data.sig.modseq : null;
    if (since) {
      // 只问上次同步之后改过标记的邮件，不用把几百上千封的标记全拉一遍
      const changed = new Map();
      for await (const m of client.fetch(range, { uid: true, flags: true }, { uid: true, changedSince: BigInt(since) })) changed.set(m.uid, m.flags || new Set());
      // 邮件总数对得上就说明没有被删的；对不上再问一次哪些还在
      let alive = null;
      if ((data.total || 0) + fresh.length !== mb.exists) alive = new Set((await client.search({ uid: range }, { uid: true })) || []);
      kept = [];
      for (const m of known) {
        if (alive && !alive.has(m.uid)) continue;
        kept.push(changed.has(m.uid) ? withFlags(m, changed.get(m.uid)) : m);
      }
    } else {
      const flags = new Map();
      for await (const m of client.fetch(range, { uid: true, flags: true }, { uid: true })) flags.set(m.uid, m.flags || new Set());
      kept = [];
      for (const m of known) {
        const f = flags.get(m.uid);
        if (f) kept.push(withFlags(m, f));
      }
    }
  }

  const unread = sig ? sig.unseen : ((await client.search({ seen: false }, { uid: true })) || []).length;
  const messages = [...fresh, ...kept].sort((a, b) => b.uid - a.uid).slice(0, KEEP_MAX);
  data = { ...data, uidValidity, messages, total: mb.exists, unread, sig: nextSig };
  saveFolder(accountId, p, data);
  updateFolderCounts(accountId, p, data);

  const newMessages = firstSync || !known.length ? [] : fresh.filter((m) => !m.seen);
  return { ...publicFolder(data), newMessages, fetched: fresh };
}

function updateFolderCounts(accountId, p, data) {
  const list = loadFolders(accountId);
  const f = list.find((x) => x.path === p);
  if (f && (f.unread !== data.unread || f.total !== data.total)) {
    f.unread = data.unread;
    f.total = data.total;
    saveFolders(accountId, list);
  }
}

async function loadOlder(accountId, p) {
  return withMailbox(accountId, p, async (client) => {
    const data = loadFolder(accountId, p);
    if (!data.messages.length) return publicFolder(data);
    const lowest = data.messages[data.messages.length - 1].uid;
    if (lowest <= 1) {
      data.complete = true;
      saveFolder(accountId, p, data);
      return publicFolder(data);
    }
    const uids = (await client.search({ uid: `1:${lowest - 1}` }, { uid: true })) || [];
    const pick = uids.sort((a, b) => a - b).slice(-PAGE_COUNT);
    const older = pick.length ? await fetchSummaries(client, accountId, p, pick.join(','), { uid: true }) : [];
    data.messages = [...data.messages, ...older].sort((a, b) => b.uid - a.uid);
    data.complete = uids.length <= PAGE_COUNT;
    saveFolder(accountId, p, data);
    emit('mail:changed', { accountId, path: p, newMessages: [] });
    return publicFolder(data);
  });
}

// ---------- 列表（单个文件夹 / 统一视图） ----------
function getMessages(view) {
  if (view.type === 'folder') {
    const data = loadFolder(view.accountId, view.path);
    return { messages: data.messages, ...publicFolder(data) };
  }
  // 统一视图：所有账户的收件箱
  const all = [];
  let complete = true;
  for (const acc of store.accounts.list()) {
    const data = loadFolder(acc.id, inboxPath(acc.id));
    complete = complete && data.complete;
    for (const m of data.messages) {
      if (view.kind === 'unread' && m.seen) continue;
      if (view.kind === 'flagged' && !m.flagged) continue;
      all.push(m);
    }
    if (view.kind === 'flagged') {
      // 星标也看看其他已缓存的文件夹（不含 Gmail 的“所有邮件/星标”这种重复视图）
      for (const f of loadFolders(acc.id)) {
        if (['\\Inbox', '\\All', '\\Flagged', '\\Important', '\\Trash', '\\Junk'].includes(f.specialUse)) continue;
        const key = acc.id + '\n' + f.path;
        if (!memo.has(key) && !fs.existsSync(folderFile(acc.id, f.path))) continue;
        for (const m of loadFolder(acc.id, f.path).messages) if (m.flagged) all.push(m);
      }
    }
  }
  all.sort((a, b) => b.date - a.date);
  return { messages: all, complete, total: all.length, unread: all.filter((m) => !m.seen).length, count: all.length };
}

function unreadSummary() {
  const out = {};
  for (const acc of store.accounts.list()) {
    const data = loadFolder(acc.id, inboxPath(acc.id));
    out[acc.id] = data.unread || 0;
  }
  return out;
}

function patchCached(accountId, p, uids, patch) {
  const data = loadFolder(accountId, p);
  const set = new Set(uids);
  let unreadDelta = 0;
  data.messages = data.messages.map((m) => {
    if (!set.has(m.uid)) return m;
    if ('seen' in patch && patch.seen !== m.seen) unreadDelta += patch.seen ? -1 : 1;
    return { ...m, ...patch };
  });
  data.unread = Math.max(0, (data.unread || 0) + unreadDelta);
  saveFolder(accountId, p, data);
  updateFolderCounts(accountId, p, data);
}

function removeCached(accountId, p, uids) {
  const data = loadFolder(accountId, p);
  const set = new Set(uids);
  const removed = data.messages.filter((m) => set.has(m.uid));
  data.messages = data.messages.filter((m) => !set.has(m.uid));
  data.total = Math.max(0, data.total - removed.length);
  data.unread = Math.max(0, data.unread - removed.filter((m) => !m.seen).length);
  saveFolder(accountId, p, data);
  updateFolderCounts(accountId, p, data);
}

// ---------- 读信 ----------
function gone() {
  const err = new Error('邮件已不存在，可能已在其他设备上删除或移动');
  err.gone = true;
  return err;
}

// 从服务器取一封邮件。每样东西都是一条命令整块取回——按小块分段取在 Gmail 上非常慢，还容易被限速。
// 大邮件只取“精简版”：正文和内嵌小图是真的，附件只留一个空壳（记着它在邮件里的位置），用到时再单独下
async function downloadMessage(client, files, uid, sizeHint) {
  const one = (query) => client.fetchOne(String(uid), query, { uid: true });
  if (!(sizeHint > 0 && sizeHint <= LITE_MIN)) {
    const info = await one({ bodyStructure: true, size: true });
    if (!info) throw gone();
    const plan = info.size > LITE_MIN ? litePlan(info.bodyStructure) : null;
    if (plan) {
      const res = await one({ headers: true, bodyParts: plan.keys });
      if (!res) throw gone();
      const raw = buildLite(plan, res);
      if (raw) {
        writeFile(files.lite, raw);
        return raw;
      }
    }
  }
  const res = await one({ source: true });
  if (!res || !res.source) throw gone();
  writeFile(files.full, res.source);
  return res.source;
}

// 邮件原文（完整的或精简版）：本机有就直接用，没有就下载；同一封同时只下一次
const downloading = new Map();
function rawMessage(accountId, p, uid, priority = 0) {
  const files = bodyFiles(accountId, p, uid);
  if (fs.existsSync(files.full)) return fs.promises.readFile(files.full);
  if (fs.existsSync(files.lite)) return fs.promises.readFile(files.lite);
  const key = `${accountId}\n${p}\n${uid}`;
  const pending = downloading.get(key);
  if (pending) {
    if (priority === 0 && pending.job.priority !== 0) hurry(accountId, pending.job);
    return pending.promise;
  }
  const cached = loadFolder(accountId, p).messages.find((m) => m.uid === uid);
  const task = readJob(accountId, p, (client) => downloadMessage(client, files, uid, cached ? cached.size : 0), priority);
  downloading.set(key, task);
  task.promise.finally(() => downloading.delete(key)).catch(() => {});
  return task.promise;
}

// 收到新邮件后，后台先把正文下好，点开时就不用等
function prefetch(accountId, p, list) {
  const newest = [...(list || [])].sort((a, b) => b.uid - a.uid).slice(0, PREFETCH_MAX);
  for (const m of newest) rawMessage(accountId, p, m.uid, 1).catch(() => {});
}

// 精简版里的空壳附件：返回它在原邮件里的位置（如 "2"、"2.1"），不是空壳返回 ''
const stubPart = (a) => String((a.headers && a.headers.get('x-huiyou-part')) || '').trim();
const stubSize = (a) => Number(a.headers && a.headers.get('x-huiyou-size')) || 0;

// 单独下载空壳附件的真实内容（解码后），一条命令取回所有要的；下过的留在本机。
// stubs：解析精简版得到的附件对象。返回 Map：位置 -> 内容
async function partContents(accountId, p, uid, stubs) {
  const files = bodyFiles(accountId, p, uid);
  const out = new Map();
  const missing = [];
  for (const a of stubs) {
    const part = stubPart(a);
    if (fs.existsSync(files.part(part))) out.set(part, await fs.promises.readFile(files.part(part)));
    else missing.push(a);
  }
  if (missing.length) {
    const got = await readJob(accountId, p, async (client) => {
      const res = await client.fetchOne(String(uid), { bodyParts: missing.map(stubPart) }, { uid: true });
      if (!res || !res.bodyParts) throw gone();
      return new Map([...res.bodyParts].map(([k, v]) => [String(k).toLowerCase(), v]));
    }).promise;
    for (const a of missing) {
      const part = stubPart(a);
      const body = got.get(part.toLowerCase());
      if (!body) throw gone();
      const buf = decodePart(body, a.headers.get('content-transfer-encoding'));
      writeFile(files.part(part), buf);
      out.set(part, buf);
    }
  }
  return out;
}

// 取出几个附件的内容（index 是它在邮件附件列表里的序号）
async function loadAttachments(accountId, p, uid, indexes) {
  const mail = await simpleParser(await rawMessage(accountId, p, uid), { keepCidLinks: true });
  const picked = indexes.map((index) => ({ index, a: mail.attachments[index] })).filter((x) => x.a);
  const stubs = picked.map((x) => x.a).filter(stubPart);
  const got = stubs.length ? await partContents(accountId, p, uid, stubs) : new Map();
  return picked.map(({ index, a }) => ({
    index,
    filename: a.filename || `附件${index + 1}`,
    content: stubPart(a) ? got.get(stubPart(a)) : a.content,
    contentType: a.contentType,
  }));
}

const fmtAddrs = (v) => (v ? (Array.isArray(v) ? v : [v]).flatMap((x) => x.value || []).map((a) => ({ name: a.name || '', address: a.address || '' })) : []);
const INLINE_MAX = 8 * 1024 * 1024; // 比这大的内嵌内容不塞进正文，只当附件列出
const cidOf = (a) => (a.contentId ? a.contentId.replace(/^<|>$/g, '') : '');

async function readMessage(accountId, p, uid) {
  const raw = await rawMessage(accountId, p, uid);
  // cid 链接留着自己换：精简版里图片可能只是空壳，得先把真内容补回来
  const mail = await simpleParser(raw, { skipTextToHtml: false, keepCidLinks: true });
  let html = mail.html || mail.textAsHtml || '';
  const list = mail.attachments || [];
  const CID_RE = /\bcid:([^'"\s]{1,256})/g;
  const citedIds = new Set([...html.matchAll(CID_RE)].map((m) => m[1]));
  const cited = (a) => citedIds.has(cidOf(a));
  // 精简版里留了空壳、但正文其实引用了的内嵌内容：现在补下回来
  const need = list.filter((a) => stubPart(a) && cited(a) && stubSize(a) < INLINE_MAX);
  const got = need.length ? await partContents(accountId, p, uid, need) : new Map();
  const attachments = [];
  const uris = new Map();
  list.forEach((a, index) => {
    const part = stubPart(a);
    const content = part ? got.get(part) : a.content;
    // 正文里引用的内嵌内容换成 data URI。图片照旧也列在附件里（转发时能带上），其他内嵌内容不列
    if (content && cited(a) && content.length < INLINE_MAX) {
      if (!uris.has(cidOf(a))) uris.set(cidOf(a), `data:${a.contentType};base64,${content.toString('base64')}`);
      if (!/^image\/[\w]+$/i.test(a.contentType) && a.contentDisposition !== 'attachment') return;
    }
    const size = part ? (content ? content.length : stubSize(a)) : a.size || a.content.length;
    attachments.push({ index, filename: a.filename || `附件${index + 1}`, contentType: a.contentType, size });
  });
  if (uris.size) html = html.replace(CID_RE, (m, cid) => uris.get(cid) || m);
  return {
    accountId,
    path: p,
    uid,
    subject: mail.subject || '',
    from: fmtAddrs(mail.from)[0] || { name: '', address: '' },
    to: fmtAddrs(mail.to),
    cc: fmtAddrs(mail.cc),
    bcc: fmtAddrs(mail.bcc),
    replyTo: fmtAddrs(mail.replyTo),
    date: mail.date ? mail.date.getTime() : Date.now(),
    messageId: mail.messageId || '',
    inReplyTo: mail.inReplyTo || '',
    references: Array.isArray(mail.references) ? mail.references : mail.references ? [mail.references] : [],
    html,
    text: mail.text || '',
    attachments,
    listUnsubscribe: (mail.headers.get('list-unsubscribe') && JSON.stringify(mail.headers.get('list-unsubscribe'))) || '',
  };
}

async function attachmentContent(accountId, p, uid, index) {
  const [a] = await loadAttachments(accountId, p, uid, [index]);
  if (!a) throw new Error('附件不存在');
  return a;
}

// ---------- 操作 ----------
async function setFlags(accountId, p, uids, patch) {
  if (!uids.length) return;
  const range = uids.join(',');
  await withMailbox(accountId, p, async (client) => {
    const add = [];
    const remove = [];
    if ('seen' in patch) (patch.seen ? add : remove).push('\\Seen');
    if ('flagged' in patch) (patch.flagged ? add : remove).push('\\Flagged');
    if ('answered' in patch) (patch.answered ? add : remove).push('\\Answered');
    if (add.length) await client.messageFlagsAdd(range, add, { uid: true });
    if (remove.length) await client.messageFlagsRemove(range, remove, { uid: true });
  });
  patchCached(accountId, p, uids, patch);
  emit('mail:changed', { accountId, path: p, newMessages: [] });
}

async function moveMessages(accountId, p, uids, dest) {
  if (!uids.length || dest === p) return;
  await withMailbox(accountId, p, (client) => client.messageMove(uids.join(','), dest, { uid: true }));
  removeCached(accountId, p, uids);
  emit('mail:changed', { accountId, path: p, newMessages: [] });
  scheduleSync(accountId, dest);
}

async function deleteMessages(accountId, p, uids, { permanent = false } = {}) {
  const trash = folderBySpecial(accountId, '\\Trash');
  if (!permanent && trash && trash.path !== p) return moveMessages(accountId, p, uids, trash.path);
  await withMailbox(accountId, p, (client) => client.messageDelete(uids.join(','), { uid: true }));
  removeCached(accountId, p, uids);
  emit('mail:changed', { accountId, path: p, newMessages: [] });
}

async function archiveMessages(accountId, p, uids) {
  const target = folderBySpecial(accountId, '\\Archive') || folderBySpecial(accountId, '\\All');
  if (!target) throw new Error('这个邮箱没有“归档”文件夹，可以用“移动到…”放进任意文件夹');
  return moveMessages(accountId, p, uids, target.path);
}

async function markSpam(accountId, p, uids) {
  const junk = folderBySpecial(accountId, '\\Junk');
  if (!junk) throw new Error('这个邮箱没有“垃圾邮件”文件夹');
  return moveMessages(accountId, p, uids, junk.path);
}

async function search(accountId, p, query) {
  return withMailbox(accountId, p, async (client) => {
    const q = String(query || '').trim();
    if (!q) return [];
    const crit = client.capabilities.has('X-GM-EXT-1') ? { gmraw: q } : { or: [{ subject: q }, { from: q }, { to: q }, { body: q }] };
    const uids = ((await client.search(crit, { uid: true })) || []).sort((a, b) => b - a).slice(0, 100);
    if (!uids.length) return [];
    const list = await fetchSummaries(client, accountId, p, uids.join(','), { uid: true });
    return list.sort((a, b) => b.date - a.date);
  });
}

async function createFolder(accountId, name) {
  const client = await getClient(accountId);
  await client.mailboxCreate(name);
  return listFolders(accountId);
}

// ---------- 发信 ----------
function smtpTransport(acc, cred) {
  const auth = authOf(acc, cred);
  return nodemailer.createTransport({
    host: acc.smtp.host,
    port: Number(acc.smtp.port) || 465,
    secure: !!acc.smtp.secure,
    auth: auth.accessToken ? { type: 'OAuth2', user: auth.user, accessToken: auth.accessToken } : auth,
    tls: { rejectUnauthorized: !acc.allowInsecure },
    connectionTimeout: 30000,
  });
}

// 常用联系人：从缓存的发件人 / 收件人里统计，供写信时自动补全
function contacts() {
  const map = new Map();
  const own = ownAddresses();
  const add = (a, w) => {
    if (!a || !a.address) return;
    const k = a.address.toLowerCase();
    if (own.has(k) || /no-?reply|notification|mailer-daemon/i.test(k)) return;
    const c = map.get(k) || { name: '', address: a.address, score: 0, last: 0 };
    if (a.name && !c.name) c.name = a.name;
    c.score += w;
    map.set(k, c);
  };
  for (const acc of store.accounts.list()) {
    for (const f of loadFolders(acc.id)) {
      if (!['\\Inbox', '\\Sent'].includes(f.specialUse)) continue;
      const data = loadFolder(acc.id, f.path);
      for (const m of data.messages) {
        if (f.specialUse === '\\Sent') [...(m.to || []), ...(m.cc || [])].forEach((a) => add(a, 3));
        else add(m.from, 1);
      }
    }
  }
  return [...map.values()].sort((a, b) => b.score - a.score).slice(0, 1000);
}

// 自己的所有地址（账户地址 + 别名），小写
function ownAddresses() {
  return new Set(store.accounts.list().flatMap((a) => [a.email, ...(a.aliases || [])]).map((x) => String(x).toLowerCase()));
}

// 这封信用哪个地址发：账户地址，或账户里登记过的别名
function senderAddress(acc, draft) {
  const want = String(draft.from || '').trim().toLowerCase();
  return want && (acc.aliases || []).includes(want) ? want : acc.email;
}

async function buildMail(acc, draft) {
  const extra = [];
  // 转发 / 编辑草稿时带上原邮件的附件
  if (draft.carry && draft.carry.indexes && draft.carry.indexes.length) {
    const list = await loadAttachments(draft.carry.accountId, draft.carry.path, draft.carry.uid, draft.carry.indexes);
    for (const a of list) extra.push({ filename: a.filename, content: a.content, contentType: a.contentType });
  }
  const mail = {
    from: { name: acc.name || '', address: senderAddress(acc, draft) },
    to: draft.to,
    cc: draft.cc,
    bcc: draft.bcc,
    subject: draft.subject || '',
    html: draft.html,
    text: draft.text,
    attachments: [...extra, ...(draft.attachments || []).map((a) => ({ filename: a.name, path: a.path }))],
  };
  if (draft.inReplyTo) mail.inReplyTo = draft.inReplyTo;
  if (draft.references && draft.references.length) mail.references = draft.references;
  return mail;
}

// keepBcc：存进“已发送 / 草稿箱”的那份保留密送，真正发出去的那份不带
function compile(mail, keepBcc = false) {
  const node = new MailComposer(mail).compile();
  node.keepBcc = keepBcc;
  return node.build();
}

async function send(draft) {
  const acc = store.accounts.get(draft.accountId);
  if (!acc) throw new Error('请选择发件账户');
  const mail = await buildMail(acc, draft);
  const node = new MailComposer(mail).compile();
  const raw = await node.build();
  node.keepBcc = true;
  const archived = await node.build(); // 同一个 Message-ID 的存档版本
  let transport;
  try {
    transport = smtpTransport(acc, await credentials(acc));
    const recipients = [draft.to, draft.cc, draft.bcc].flat().filter(Boolean).map((r) => (typeof r === 'string' ? r : r.address));
    await transport.sendMail({ envelope: { from: senderAddress(acc, draft), to: recipients }, raw });
  } catch (err) {
    if (acc.auth === 'oauth2' && isAuthFailure(err)) oauth.forget(acc.id);
    throw new Error('发送失败：' + friendlyError(err, acc));
  } finally {
    if (transport) transport.close();
  }
  // 存一份到“已发送”（Gmail 等会自动保存的跳过）
  if (acc.saveSent !== false) {
    const sent = folderBySpecial(acc.id, '\\Sent');
    if (sent) {
      getClient(acc.id)
        .then((c) => c.append(sent.path, archived, ['\\Seen']))
        .then(() => scheduleSync(acc.id, sent.path))
        .catch(() => {});
    }
  } else {
    const sent = folderBySpecial(acc.id, '\\Sent');
    if (sent) setTimeout(() => scheduleSync(acc.id, sent.path), 3000);
  }
  // 回复后给原邮件加“已回复”标记
  if (draft.replyTo && draft.replyTo.uid) setFlags(draft.replyTo.accountId, draft.replyTo.path, [draft.replyTo.uid], { answered: true }).catch(() => {});
  // 从草稿发出的：删掉旧草稿
  if (draft.draftOf && draft.draftOf.uid) deleteMessages(draft.draftOf.accountId, draft.draftOf.path, [draft.draftOf.uid], { permanent: true }).catch(() => {});
  return true;
}

async function saveDraft(draft) {
  const acc = store.accounts.get(draft.accountId);
  if (!acc) throw new Error('请选择发件账户');
  const drafts = folderBySpecial(acc.id, '\\Drafts');
  if (!drafts) throw new Error('这个邮箱没有草稿箱');
  const raw = await compile(await buildMail(acc, draft), true);
  const client = await getClient(acc.id);
  await client.append(drafts.path, raw, ['\\Draft', '\\Seen']);
  if (draft.draftOf && draft.draftOf.uid) await deleteMessages(draft.draftOf.accountId, draft.draftOf.path, [draft.draftOf.uid], { permanent: true }).catch(() => {});
  scheduleSync(acc.id, drafts.path);
  return true;
}

// ---------- 账户测试 ----------
// cred: { pass } 或 { accessToken }
async function testAccount(acc, cred) {
  const client = new ImapFlow(imapOptions(acc, cred));
  client.on('error', () => {});
  try {
    await client.connect();
  } catch (err) {
    throw new Error('收信服务器（IMAP）：' + friendlyError(err, acc));
  } finally {
    try {
      await client.logout();
    } catch {}
  }
  const transport = smtpTransport(acc, cred);
  try {
    await transport.verify();
  } catch (err) {
    throw new Error('发信服务器（SMTP）：' + friendlyError(err, acc));
  } finally {
    transport.close();
  }
  return true;
}

function removeAccountCache(accountId) {
  for (const k of [...memo.keys()]) if (k.startsWith(accountId + '\n')) memo.delete(k);
  fs.rmSync(accDir(accountId), { recursive: true, force: true });
}

function cacheSize() {
  let total = 0;
  const walk = (d) => {
    let entries = [];
    try {
      entries = fs.readdirSync(d, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      const f = path.join(d, e.name);
      if (e.isDirectory()) walk(f);
      else total += fs.statSync(f).size;
    }
  };
  walk(cacheRoot());
  return total;
}

function clearBodyCache() {
  for (const acc of store.accounts.list()) fs.rmSync(path.join(accDir(acc.id), 'bodies'), { recursive: true, force: true });
}

module.exports = {
  init: (opts) => (emit = opts.emit),
  statusAll: () => lastStatus,
  thread,
  loadFolder,
  folderBySpecial,
  reportError,
  listFolders,
  loadFolders,
  inboxPath,
  syncFolder,
  loadOlder,
  getMessages,
  unreadSummary,
  readMessage,
  attachmentContent,
  setFlags,
  moveMessages,
  deleteMessages,
  archiveMessages,
  markSpam,
  search,
  createFolder,
  contacts,
  send,
  saveDraft,
  testAccount,
  disconnect,
  disconnectAll,
  dropConnections,
  warmReaders,
  removeAccountCache,
  cacheSize,
  clearBodyCache,
  friendlyError,
};
