// 阅读区：工具栏、邮件头、正文（沙箱 iframe，默认拦截远程图片）、附件
import { $, h, escapeHtml, bus, longDate, displayName, initials, fmtSize, parseKey } from './util.js';
import { icon } from './icons.js';
import { state, api, findMessage, selectedMessages, setFlags, toggleSeen, toggleFlag, trash, archive, spam, move, folderOf, accountById, accountColorIndex } from './state.js';
import { toast, menuAt } from './ui.js';
import { openCompose } from './compose.js';
import { messageMenu } from './list.js';

let root;
let loadSeq = 0;
export const opened = { message: null }; // 当前打开的完整邮件（给回复/转发用）
const allowImages = new Set(); // 本次运行中允许显示远程图片的邮件
let readTimer = null;

export function initReader() {
  root = $('#reader');
  bus.on('reader', render);
  render();
}

function emptyView(text) {
  root.innerHTML = `<div class="empty reader-empty">${icon('mailOpen', 40)}<div>${escapeHtml(text)}</div></div>`;
}

async function render() {
  clearTimeout(readTimer);
  const seq = ++loadSeq;
  opened.message = null;
  if (state.selected.size > 1) return renderMulti();
  if (!state.current) return emptyView(state.accounts.length ? '选择一封邮件阅读' : '添加邮箱后，邮件会显示在这里');
  const summary = findMessage(state.current);
  if (!summary) return emptyView('选择一封邮件阅读');

  root.innerHTML = '';
  root.appendChild(toolbar(summary));
  const body = h(`<div class="reader-body"><div class="reader-loading"><div class="spinner"></div></div></div>`);
  root.appendChild(body);
  // 先用摘要把邮件头画出来，正文下载完再补上
  body.innerHTML = '';
  body.appendChild(headerEl(summary, null));
  const loading = h('<div class="reader-loading"><div class="spinner"></div></div>');
  body.appendChild(loading);

  let msg;
  try {
    msg = await api.mail.read({ accountId: summary.accountId, path: summary.path, uid: summary.uid });
  } catch (err) {
    if (seq !== loadSeq) return;
    loading.innerHTML = `<div class="empty">${icon('warning', 34)}<div>${escapeHtml(err.message)}</div><button class="btn btn-sm" data-a="retry">重试</button></div>`;
    loading.querySelector('[data-a=retry]').onclick = render;
    return;
  }
  if (seq !== loadSeq) return;
  opened.message = { ...msg, summary };
  body.innerHTML = '';
  body.appendChild(headerEl(summary, msg));
  if (msg.attachments.length) body.appendChild(attachmentsEl(msg));
  body.appendChild(contentEl(msg));

  if (!summary.seen && state.settings.markReadOnOpen !== false) {
    readTimer = setTimeout(() => {
      if (state.current && parseKey(state.current).uid === summary.uid) setFlags([summary], { seen: true });
    }, 600);
  }
}

function renderMulti() {
  const msgs = selectedMessages();
  root.innerHTML = '';
  const el = h(`<div class="empty reader-empty multi">
    ${icon('mails', 40)}
    <div class="multi-title">已选择 ${msgs.length} 封邮件</div>
    <div class="multi-actions">
      <button class="btn" data-a="seen">${icon('mailOpen', 15)}${msgs.some((m) => !m.seen) ? '标为已读' : '标为未读'}</button>
      <button class="btn" data-a="star">${icon('star', 15)}${msgs.some((m) => !m.flagged) ? '加星标' : '取消星标'}</button>
      <button class="btn" data-a="archive">${icon('archive', 15)}归档</button>
      <button class="btn btn-danger" data-a="trash">${icon('trash', 15)}删除</button>
    </div>
  </div>`);
  el.querySelector('[data-a=seen]').onclick = () => toggleSeen(msgs).then(render);
  el.querySelector('[data-a=star]').onclick = () => toggleFlag(msgs).then(render);
  el.querySelector('[data-a=archive]').onclick = () => archive(msgs);
  el.querySelector('[data-a=trash]').onclick = () => trash(msgs);
  root.appendChild(el);
}

function toolbar(m) {
  const f = folderOf(m.accountId, m.path);
  const isDraft = m.draft || f?.specialUse === '\\Drafts';
  const el = h(`<div class="reader-toolbar">
    <div class="tb-group">
      ${isDraft ? `<button class="btn btn-primary btn-sm" data-a="edit">${icon('pen', 14)}编辑草稿</button>` : ''}
      <button class="icon-btn" data-a="reply" title="回复 (R)">${icon('reply')}</button>
      <button class="icon-btn" data-a="replyAll" title="全部回复 (A)">${icon('replyAll')}</button>
      <button class="icon-btn" data-a="forward" title="转发 (F)">${icon('forward')}</button>
    </div>
    <span class="tb-sep"></span>
    <div class="tb-group">
      <button class="icon-btn" data-a="archive" title="归档 (E)">${icon('archive')}</button>
      <button class="icon-btn" data-a="trash" title="删除 (Delete)">${icon('trash')}</button>
      <button class="icon-btn" data-a="spam" title="垃圾邮件">${icon('spam')}</button>
      <button class="icon-btn" data-a="move" title="移动到…">${icon('folderMove')}</button>
    </div>
    <span class="tb-sep"></span>
    <div class="tb-group">
      <button class="icon-btn" data-a="seen" title="${m.seen ? '标为未读' : '标为已读'} (U)">${icon(m.seen ? 'mail' : 'mailOpen')}</button>
      <button class="icon-btn ${m.flagged ? 'starred' : ''}" data-a="star" title="星标 (S)">${icon('star')}</button>
    </div>
    <span class="flex"></span>
    <button class="icon-btn" data-a="more" title="更多">${icon('more')}</button>
  </div>`);
  el.onclick = (e) => {
    const b = e.target.closest('[data-a]');
    if (!b) return;
    const a = b.dataset.a;
    if (a === 'edit') return openCompose({ mode: 'draft', source: m });
    if (['reply', 'replyAll', 'forward'].includes(a)) return openCompose({ mode: a, source: m });
    if (a === 'archive') return archive([m]);
    if (a === 'trash') return trash([m]);
    if (a === 'spam') return spam([m]);
    if (a === 'seen') {
      clearTimeout(readTimer);
      return toggleSeen([m]).then(() => b.replaceWith(toolbarSeenBtn(m)));
    }
    if (a === 'star') return toggleFlag([m]).then(() => b.classList.toggle('starred', m.flagged));
    if (a === 'move') {
      const folders = (state.folders[m.accountId] || []).filter((x) => x.path !== m.path);
      return menuAt(b, folders.length ? folders.map((x) => ({ label: x.name, icon: 'folder', onClick: () => move([m], x.path) })) : [{ label: '没有其他文件夹', disabled: true }]);
    }
    if (a === 'more') return menuAt(b, messageMenu([m]));
  };
  return el;
}

function toolbarSeenBtn(m) {
  const b = h(`<button class="icon-btn" data-a="seen" title="${m.seen ? '标为未读' : '标为已读'} (U)">${icon(m.seen ? 'mail' : 'mailOpen')}</button>`);
  return b;
}

function addrList(list) {
  return list
    .map((a) => `<span class="addr" title="${escapeHtml(a.address)}">${escapeHtml(a.name || a.address)}</span>`)
    .join('<span class="addr-sep">、</span>');
}

function headerEl(summary, msg) {
  const from = (msg && msg.from) || summary.from;
  const to = (msg && msg.to) || summary.to || [];
  const cc = (msg && msg.cc) || summary.cc || [];
  const acc = accountById(summary.accountId);
  const el = h(`<div class="reader-head">
    <h1 class="reader-subject">${escapeHtml((msg && msg.subject) || summary.subject || '(无主题)')}</h1>
    <div class="reader-meta">
      <span class="avatar lg">${escapeHtml(initials(from))}</span>
      <div class="reader-from">
        <div class="reader-from-line"><span class="reader-name">${escapeHtml(displayName(from) || '(未知发件人)')}</span><span class="reader-addr">${escapeHtml(from.address || '')}</span></div>
        <div class="reader-to">发给 ${addrList(to) || '(无)'}${cc.length ? `<span class="reader-cc">　抄送 ${addrList(cc)}</span>` : ''}</div>
      </div>
      <div class="reader-date">
        <div class="tabular">${escapeHtml(longDate((msg && msg.date) || summary.date))}</div>
        ${acc ? `<div class="reader-acc"><span class="acc-dot acc-c${accountColorIndex(acc.id)}"></span>${escapeHtml(acc.email)}</div>` : ''}
      </div>
    </div>
  </div>`);
  return el;
}

function attachmentsEl(msg) {
  const el = h(`<div class="attachments"></div>`);
  for (const a of msg.attachments) {
    const isImg = /^image\//.test(a.contentType);
    const item = h(`<div class="att" title="${escapeHtml(a.filename)}">
      <span class="att-ico">${icon(isImg ? 'image' : 'file', 18)}</span>
      <div class="att-text"><div class="att-name">${escapeHtml(a.filename)}</div><div class="att-size tabular">${fmtSize(a.size)}</div></div>
      <button class="icon-btn att-dl" title="另存为…">${icon('download', 15)}</button>
    </div>`);
    const ref = { accountId: msg.accountId, path: msg.path, uid: msg.uid, index: a.index };
    item.onclick = async (e) => {
      if (e.target.closest('.att-dl')) {
        try {
          const saved = await api.mail.saveAttachment(ref);
          if (saved) toast('已保存', 'success');
        } catch (err) {
          toast(err.message, 'error', 4000);
        }
        return;
      }
      try {
        await api.mail.openAttachment(ref);
      } catch (err) {
        toast('打开失败：' + err.message, 'error', 4000);
      }
    };
    el.appendChild(item);
  }
  return el;
}

const REMOTE_RE = /(<img[^>]+src\s*=\s*["']?\s*https?:|url\(\s*["']?\s*https?:|<link[^>]+href\s*=\s*["']?\s*https?:|background\s*=\s*["']?\s*https?:)/i;

function contentEl(msg) {
  const key = `${msg.accountId}|${msg.path}|${msg.uid}`;
  const wrap = h('<div class="reader-content"></div>');
  const hasRemote = REMOTE_RE.test(msg.html);
  const allow = state.settings.loadRemoteImages || allowImages.has(key);
  if (hasRemote && !allow) {
    const bar = h(`<div class="remote-bar"><span class="state-dot warning"></span><span>为保护隐私，已阻止远程图片</span><button class="btn btn-ghost btn-sm">显示图片</button></div>`);
    bar.querySelector('button').onclick = () => {
      allowImages.add(key);
      wrap.replaceWith(contentEl(msg));
    };
    wrap.appendChild(bar);
  }
  const frame = document.createElement('iframe');
  frame.className = 'mail-frame';
  // 不允许脚本；允许同源只是为了让外层量高度、接管链接点击
  frame.setAttribute('sandbox', 'allow-same-origin allow-popups allow-popups-to-escape-sandbox');
  frame.setAttribute('referrerpolicy', 'no-referrer');
  frame.srcdoc = buildDoc(msg, allow);
  frame.onload = () => {
    const doc = frame.contentDocument;
    if (!doc) return;
    doc.addEventListener('click', (e) => {
      const a = e.target.closest('a[href]');
      if (!a) return;
      e.preventDefault();
      const href = a.getAttribute('href');
      if (/^(https?|mailto):/i.test(href)) {
        if (/^mailto:/i.test(href)) openCompose({ mode: 'new', to: decodeURIComponent(href.slice(7).split('?')[0]) });
        else api.app.openExternal(href);
      }
    });
    const fit = () => {
      frame.style.height = Math.max(120, doc.documentElement.scrollHeight) + 'px';
    };
    fit();
    new ResizeObserver(fit).observe(doc.documentElement);
    doc.querySelectorAll('img').forEach((img) => img.addEventListener('load', fit));
  };
  wrap.appendChild(frame);
  return wrap;
}

function buildDoc(msg, allowRemote) {
  let html = msg.html || `<pre>${escapeHtml(msg.text || '')}</pre>`;
  html = html.replace(/<script[\s\S]*?<\/script>/gi, '').replace(/<meta[^>]+http-equiv[^>]*>/gi, '');
  // 被拦截的远程图片直接隐藏，免得显示破图图标
  if (!allowRemote) html = html.replace(/<img\b([^>]*?)\bsrc\s*=\s*(["']?)\s*https?:/gi, '<img data-blocked="1" style="display:none"$1src=$2about:blank#');
  const img = allowRemote ? "img-src data: blob: https: http:; media-src https: http:; font-src data: https:;" : 'img-src data: blob:; font-src data:;';
  const csp = `default-src 'none'; style-src 'unsafe-inline' ${allowRemote ? 'https: http:' : ''}; ${img}`;
  return `<!doctype html><html><head><meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="${csp}">
<base target="_blank">
<style>
  html,body{margin:0;padding:0;background:#fff;color:#1d1d1f;}
  body{font-family:-apple-system,BlinkMacSystemFont,'PingFang SC','Microsoft YaHei',sans-serif;font-size:14px;line-height:1.65;padding:4px 2px 24px;word-wrap:break-word;overflow-wrap:anywhere;}
  img{max-width:100%;height:auto;}
  table{max-width:100%;}
  pre{white-space:pre-wrap;font-family:inherit;margin:0;}
  blockquote{margin:8px 0;padding-left:12px;border-left:3px solid #d2d2d7;color:#6e6e73;}
  a{color:#0071e3;}
</style></head><body>${html}</body></html>`;
}

// 给快捷键用
export function readerAction(a) {
  const m = state.current && findMessage(state.current);
  if (!m) return;
  if (['reply', 'replyAll', 'forward'].includes(a)) openCompose({ mode: a, source: m });
}
