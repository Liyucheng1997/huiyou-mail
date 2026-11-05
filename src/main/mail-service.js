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
const { makeSnippet, findTextPart, hasAttachments, guessSpecial, sortFolders, SPECIAL_NAMES } = require('./mail-text');

const INITIAL_COUNT = 150; // 第一次同步一个文件夹时拉取的邮件数
const PAGE_COUNT = 100; // “加载更早的邮件”每次的数量
const KEEP_MAX = 2000; // 每个文件夹本地最多缓存的摘要数

let emit = () => {};
const clients = new Map(); // accountId -> { client, connecting, folders }

// ---------- 缓存 ----------
const cacheRoot = () => path.join(store.dataDir(), 'cache');
const hash = (s) => crypto.createHash('sha1').update(s).digest('hex').slice(0, 16);
const accDir = (id) => path.join(cacheRoot(), id);
const folderFile = (id, p) => path.join(accDir(id), 'msgs', hash(p) + '.json');
const bodyFile = (id, p, uv, uid) => path.join(accDir(id), 'bodies', `${hash(p)}_${uv}_${uid}.eml`);

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
function imapOptions(acc, pass) {
  return {
    host: acc.imap.host,
    port: Number(acc.imap.port) || 993,
    secure: !!acc.imap.secure,
    auth: { user: acc.username || acc.email, pass },
    logger: false,
    clientInfo: { name: 'Huiyou Mail', version: app.getVersion(), vendor: 'Huiyou' }, // 网易邮箱要求客户端发送 ID
    tls: { rejectUnauthorized: !acc.allowInsecure },
    connectionTimeout: 30000,
    greetingTimeout: 20000,
    socketTimeout: 5 * 60 * 1000,
  };
}

function friendlyError(err) {
  const msg = String((err && (err.responseText || err.message)) || err || '未知错误');
  if (err && (err.authenticationFailed || /AUTHENTICATIONFAILED|Invalid credentials|LOGIN failed|authentication failed|535/i.test(msg)))
    return '登录失败：请确认使用的是授权码 / 应用专用密码，并已在网页版开启 IMAP/SMTP';
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
  if (s.state !== 'error') delete lastStatus[accountId].message;
  emit('mail:status', lastStatus[accountId]);
}

async function getClient(accountId) {
  let entry = clients.get(accountId);
  if (entry && entry.client && entry.client.usable) return entry.client;
  if (entry && entry.connecting) return entry.connecting;
  const acc = store.accounts.get(accountId);
  if (!acc) throw new Error('账户不存在');
  entry = entry || {};
  clients.set(accountId, entry);
  entry.connecting = (async () => {
    const client = new ImapFlow(imapOptions(acc, store.accounts.password(accountId)));
    client.on('error', () => {}); // 错误在调用处处理；这里防止未捕获异常
    client.on('close', () => {
      if (entry.client === client) entry.client = null;
    });
    client.on('exists', (info) => {
      if (info && info.count > info.prevCount) scheduleSync(accountId, info.path);
    });
    await client.connect();
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

async function disconnect(accountId) {
  const entry = clients.get(accountId);
  clients.delete(accountId);
  if (entry && entry.client) {
    try {
      await entry.client.logout();
    } catch {
      entry.client.close();
    }
  }
}

async function disconnectAll() {
  await Promise.all([...clients.keys()].map(disconnect));
}

// 对某个文件夹加锁执行操作；连接断了会重连一次
async function withMailbox(accountId, p, fn, retry = true) {
  let client;
  try {
    client = await getClient(accountId);
    const lock = await client.getMailboxLock(p);
    try {
      return await fn(client);
    } finally {
      lock.release();
    }
  } catch (err) {
    const dropped = !client || !client.usable || /Connection not available|closed|ECONNRESET|EPIPE|socket/i.test(String(err && err.message));
    if (retry && dropped) {
      const entry = clients.get(accountId);
      if (entry) entry.client = null;
      return withMailbox(accountId, p, fn, false);
    }
    throw err;
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

async function fetchSummaries(client, accountId, p, range, opts) {
  const out = [];
  const query = { ...SUMMARY_QUERY };
  if (client.capabilities && client.capabilities.has('X-GM-EXT-1')) query.threadId = true;
  for await (const msg of client.fetch(range, query, opts)) out.push(toSummary(accountId, p, msg));
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

function syncFolder(accountId, p) {
  const key = accountId + '\n' + p;
  if (syncing.has(key)) return syncing.get(key);
  const run = (async () => {
    status(accountId, { state: 'syncing', path: p });
    try {
      const result = await withMailbox(accountId, p, (client) => doSync(client, accountId, p));
      status(accountId, { state: 'idle', path: p, lastSync: Date.now() });
      emit('mail:changed', { accountId, path: p, newMessages: result.newMessages });
      return result;
    } catch (err) {
      status(accountId, { state: 'error', path: p, message: friendlyError(err) });
      throw new Error(friendlyError(err));
    }
  })();
  syncing.set(key, run);
  run.finally(() => syncing.delete(key)).catch(() => {});
  return run;
}

async function doSync(client, accountId, p) {
  const mb = client.mailbox;
  const uidValidity = String(mb.uidValidity);
  let data = loadFolder(accountId, p);
  const firstSync = data.uidValidity === null;
  if (data.uidValidity !== uidValidity) data = { uidValidity, messages: [], total: 0, unread: 0, complete: false };

  if (!mb.exists) {
    data = { ...data, messages: [], total: 0, unread: 0, complete: true };
    saveFolder(accountId, p, data);
    return { ...publicFolder(data), newMessages: [] };
  }

  const known = data.messages;
  const highest = known.length ? known[0].uid : 0;
  let fresh;
  if (!known.length) {
    const start = Math.max(1, mb.exists - INITIAL_COUNT + 1);
    fresh = await fetchSummaries(client, accountId, p, `${start}:*`, {});
    data.complete = start === 1;
  } else {
    fresh = (await fetchSummaries(client, accountId, p, `${highest + 1}:*`, { uid: true })).filter((m) => m.uid > highest);
  }

  // 刷新已缓存邮件的标记，并去掉服务器上已经不存在的
  let kept = known;
  if (known.length) {
    const lowest = known[known.length - 1].uid;
    const flags = new Map();
    for await (const m of client.fetch(`${lowest}:${highest}`, { uid: true, flags: true }, { uid: true })) flags.set(m.uid, m.flags || new Set());
    kept = [];
    for (const m of known) {
      const f = flags.get(m.uid);
      if (!f) continue;
      kept.push({ ...m, seen: f.has('\\Seen'), flagged: f.has('\\Flagged'), answered: f.has('\\Answered'), draft: f.has('\\Draft') });
    }
  }

  const unseen = await client.search({ seen: false }, { uid: true });
  const messages = [...fresh, ...kept].sort((a, b) => b.uid - a.uid).slice(0, KEEP_MAX);
  data = { ...data, uidValidity, messages, total: mb.exists, unread: (unseen || []).length };
  saveFolder(accountId, p, data);
  updateFolderCounts(accountId, p, data);

  const newMessages = firstSync || !known.length ? [] : fresh.filter((m) => !m.seen);
  return { ...publicFolder(data), newMessages };
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
async function rawMessage(accountId, p, uid) {
  const data = loadFolder(accountId, p);
  const file = bodyFile(accountId, p, data.uidValidity || '0', uid);
  if (fs.existsSync(file)) return fs.readFileSync(file);
  const buf = await withMailbox(accountId, p, async (client) => {
    const res = await client.download(String(uid), undefined, { uid: true });
    if (!res || !res.content) throw new Error('邮件已不存在，可能已在其他设备上删除或移动');
    const chunks = [];
    for await (const c of res.content) chunks.push(c);
    return Buffer.concat(chunks);
  });
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, buf);
  return buf;
}

const fmtAddrs = (v) => (v ? (Array.isArray(v) ? v : [v]).flatMap((x) => x.value || []).map((a) => ({ name: a.name || '', address: a.address || '' })) : []);

async function readMessage(accountId, p, uid) {
  const raw = await rawMessage(accountId, p, uid);
  const mail = await simpleParser(raw, { skipTextToHtml: false });
  let html = mail.html || mail.textAsHtml || '';
  const attachments = [];
  (mail.attachments || []).forEach((a, index) => {
    const cid = a.contentId ? a.contentId.replace(/^<|>$/g, '') : '';
    // 正文里引用的内嵌图片换成 data URI，不当成附件列出
    if (cid && html.includes('cid:' + cid) && a.content.length < 8 * 1024 * 1024) {
      const uri = `data:${a.contentType};base64,${a.content.toString('base64')}`;
      html = html.split('cid:' + cid).join(uri);
      if (a.contentDisposition !== 'attachment') return;
    }
    attachments.push({ index, filename: a.filename || `附件${index + 1}`, contentType: a.contentType, size: a.size || a.content.length });
  });
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
  const mail = await simpleParser(await rawMessage(accountId, p, uid));
  const a = mail.attachments[index];
  if (!a) throw new Error('附件不存在');
  return { filename: a.filename || `附件${index + 1}`, content: a.content, contentType: a.contentType };
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
function smtpTransport(acc, pass) {
  return nodemailer.createTransport({
    host: acc.smtp.host,
    port: Number(acc.smtp.port) || 465,
    secure: !!acc.smtp.secure,
    auth: { user: acc.username || acc.email, pass },
    tls: { rejectUnauthorized: !acc.allowInsecure },
    connectionTimeout: 30000,
  });
}

// 常用联系人：从缓存的发件人 / 收件人里统计，供写信时自动补全
function contacts() {
  const map = new Map();
  const own = new Set(store.accounts.list().map((a) => a.email.toLowerCase()));
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

async function buildMail(acc, draft) {
  const extra = [];
  // 转发 / 编辑草稿时带上原邮件的附件
  if (draft.carry && draft.carry.indexes && draft.carry.indexes.length) {
    const mail = await simpleParser(await rawMessage(draft.carry.accountId, draft.carry.path, draft.carry.uid));
    for (const i of draft.carry.indexes) {
      const a = mail.attachments[i];
      if (a) extra.push({ filename: a.filename || `附件${i + 1}`, content: a.content, contentType: a.contentType });
    }
  }
  const mail = {
    from: { name: acc.name || '', address: acc.email },
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
  const transport = smtpTransport(acc, store.accounts.password(acc.id));
  try {
    const recipients = [draft.to, draft.cc, draft.bcc].flat().filter(Boolean).map((r) => (typeof r === 'string' ? r : r.address));
    await transport.sendMail({ envelope: { from: acc.email, to: recipients }, raw });
  } catch (err) {
    throw new Error('发送失败：' + friendlyError(err));
  } finally {
    transport.close();
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
async function testAccount(acc, pass) {
  const client = new ImapFlow(imapOptions(acc, pass));
  client.on('error', () => {});
  try {
    await client.connect();
  } catch (err) {
    throw new Error('收信服务器（IMAP）：' + friendlyError(err));
  } finally {
    try {
      await client.logout();
    } catch {}
  }
  const transport = smtpTransport(acc, pass);
  try {
    await transport.verify();
  } catch (err) {
    throw new Error('发信服务器（SMTP）：' + friendlyError(err));
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
  removeAccountCache,
  cacheSize,
  clearBodyCache,
  friendlyError,
};
