// AI 助手面板：停靠在阅读区右侧。对话流式显示；删除 / 拉黑等操作在这里出确认卡片；
// 回答里的 mail://mN 链接点一下就打开对应邮件；AI 起草的邮件直接打开写信窗口。
import { $, h, escapeHtml, bus } from './util.js';
import { icon } from './icons.js';
import { state, api, setView, select, selectedMessages, viewTitle } from './state.js';
import { toast } from './ui.js';
import { openCompose } from './compose.js';

const TOOL_LABEL = {
  list_accounts: () => '查看邮箱账户',
  list_messages: (a) => ({ unread: '查看未读邮件', flagged: '查看星标邮件', folder: `查看“${a.folder || '文件夹'}”` })[a.scope] || (a.query ? `查找“${a.query}”` : a.from ? `查看 ${a.from} 的邮件` : '查看收件箱'),
  read_message: () => '阅读邮件',
  search_server: (a) => `在服务器上搜索“${a.query || ''}”`,
  sender_stats: () => '统计发件人',
  list_blocked: () => '查看黑名单',
  mark_read: (a) => `把 ${(a.ids || []).length} 封邮件标为${a.read ? '已读' : '未读'}`,
  flag_messages: (a) => `${a.flagged ? '星标' : '取消星标'} ${(a.ids || []).length} 封邮件`,
  delete_messages: (a) => `删除 ${(a.ids || []).length} 封邮件`,
  archive_messages: (a) => `归档 ${(a.ids || []).length} 封邮件`,
  mark_spam: (a) => `把 ${(a.ids || []).length} 封邮件标为垃圾邮件`,
  move_messages: (a) => `移动 ${(a.ids || []).length} 封邮件到“${a.folder || ''}”`,
  block_senders: (a) => `拉黑 ${(a.senders || []).join('、')}`,
  unblock_senders: (a) => `解除拉黑 ${(a.senders || []).join('、')}`,
  draft_email: () => '起草邮件',
};
const READS = new Set(['list_accounts', 'list_messages', 'read_message', 'search_server', 'sender_stats', 'list_blocked']);

const SUGGESTIONS = [
  { icon: 'mailOpen', text: '总结一下今天的未读邮件' },
  { icon: 'spam', text: '找出广告和推广邮件，帮我清理掉' },
  { icon: 'reply', text: '最近有哪些邮件需要我回复？' },
  { icon: 'pen', text: '帮我回复当前选中的这封邮件' },
];

let root;
let body;
let input;
let sendBtn;
let busy = false;
let open = false;
let cur = null; // 正在流式输出的那段文字 { el, text }
let thinkingEl = null;
const tools = new Map(); // tool_use id -> 行元素

export function isAiOpen() {
  return open;
}

export function toggleAi(force) {
  open = typeof force === 'boolean' ? force : !open;
  root.classList.toggle('hidden', !open);
  document.body.classList.toggle('ai-open', open);
  bus.emit('ai-toggle', open);
  if (open) setTimeout(() => input.focus(), 50);
}

export function initAi() {
  root = $('#ai');
  root.innerHTML = `
    <div class="ai-head">
      <span class="ai-mark">${icon('sparkle', 16)}</span>
      <div class="ai-head-text"><div class="ai-title">AI 助手</div><div class="ai-sub">Claude Opus 5.5 · 使用你的 Claude 订阅</div></div>
      <button class="tb-round sm" data-a="new" title="新对话">${icon('plus', 16)}</button>
      <button class="tb-round sm" data-a="close" title="关闭 (Ctrl+J)">${icon('close', 14)}</button>
    </div>
    <div class="ai-body"></div>
    <div class="ai-foot">
      <div class="ai-input">
        <textarea rows="1" placeholder="让 AI 帮你处理邮件…" spellcheck="false"></textarea>
        <button class="ai-send" title="发送 (Enter)">${icon('send', 15)}</button>
      </div>
      <div class="ai-hint">删除、拉黑等操作会先请你确认；写好的邮件由你自己发送</div>
    </div>`;
  body = root.querySelector('.ai-body');
  input = root.querySelector('textarea');
  sendBtn = root.querySelector('.ai-send');
  root.querySelector('[data-a=close]').onclick = () => toggleAi(false);
  root.querySelector('[data-a=new]').onclick = newChat;
  sendBtn.onclick = () => (busy ? api.ai.interrupt() : submit());
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
      e.preventDefault();
      if (!busy) submit();
    }
  });
  input.addEventListener('input', autosize);
  body.addEventListener('click', onLinkClick);

  api.ai.onEvent(onEvent);
  api.ai.onDraft((d) =>
    openCompose({ mode: d.mode, source: d.source, accountId: d.accountId, prefill: { to: d.to, cc: d.cc, subject: d.subject, body: d.body } })
  );
  renderEmpty();
}

function autosize() {
  input.style.height = 'auto';
  input.style.height = Math.min(input.scrollHeight, 160) + 'px';
  input.style.overflowY = input.scrollHeight > 160 ? 'auto' : 'hidden';
}

async function renderEmpty() {
  body.innerHTML = '';
  const st = await api.ai.status().catch(() => ({ ready: false }));
  const empty = h(`<div class="ai-empty">
    <div class="ai-empty-mark">${icon('sparkle', 26)}</div>
    <div class="ai-empty-title">有什么可以帮你？</div>
    <div class="ai-empty-sub">我可以读你的邮件、总结要点、清理广告、拉黑发件人，或者帮你起草回复。</div>
    ${st.ready ? '' : `<div class="ai-warn"><span class="state-dot warning"></span><span>没有找到 Claude Code。请先安装 Claude Code，并在终端运行 <code>claude</code> 登录。</span></div>`}
    <div class="ai-suggest"></div>
  </div>`);
  const box = empty.querySelector('.ai-suggest');
  for (const s of SUGGESTIONS) {
    const b = h(`<button class="ai-chip">${icon(s.icon, 15)}<span>${escapeHtml(s.text)}</span></button>`);
    b.onclick = () => {
      input.value = s.text;
      submit();
    };
    box.appendChild(b);
  }
  body.appendChild(empty);
}

async function newChat() {
  if (busy) await api.ai.interrupt().catch(() => {});
  await api.ai.reset().catch(() => {});
  setBusy(false);
  tools.clear();
  cur = null;
  renderEmpty();
  input.focus();
}

function setBusy(b) {
  busy = b;
  sendBtn.classList.toggle('stop', b);
  sendBtn.title = b ? '停止' : '发送 (Enter)';
  sendBtn.innerHTML = b ? '<span class="ai-stop-sq"></span>' : icon('send', 15);
  if (!b) hideThinking();
}

// 告诉 AI 用户此刻在看什么
function context() {
  const v = state.view;
  let view = viewTitle();
  if (v.type === 'folder') {
    const acc = state.accounts.find((a) => a.id === v.accountId);
    view = `${acc ? acc.email : ''} 的“${view}”文件夹`;
  }
  const selected = selectedMessages().map((m) => ({ accountId: m.accountId, path: m.path, uid: m.uid, subject: m.subject, from: m.from, date: m.date }));
  return { view, selected };
}

async function submit() {
  const text = input.value.trim();
  if (!text || busy) return;
  if (body.querySelector('.ai-empty')) body.innerHTML = '';
  input.value = '';
  autosize();
  addBubble(text);
  setBusy(true);
  showThinking();
  try {
    await api.ai.send({ text, context: context() });
  } catch (err) {
    addError(err.message);
    setBusy(false);
  }
}

// ---------- 渲染 ----------
function scrollEnd() {
  body.scrollTop = body.scrollHeight;
}

function addBubble(text) {
  cur = null;
  body.appendChild(h(`<div class="ai-user"><div class="ai-bubble">${escapeHtml(text).replace(/\n/g, '<br>')}</div></div>`));
  scrollEnd();
}

function showThinking() {
  if (thinkingEl) return body.appendChild(thinkingEl);
  thinkingEl = h('<div class="ai-thinking"><span></span><span></span><span></span></div>');
  body.appendChild(thinkingEl);
  scrollEnd();
}
function hideThinking() {
  if (thinkingEl) thinkingEl.remove();
}

function addError(msg) {
  cur = null;
  hideThinking();
  body.appendChild(h(`<div class="ai-error"><span class="state-dot danger"></span><span>${escapeHtml(msg)}</span></div>`));
  scrollEnd();
}

function appendText(delta) {
  hideThinking();
  if (!cur) {
    cur = { el: h('<div class="ai-msg md"></div>'), text: '' };
    body.appendChild(cur.el);
  }
  cur.text += delta;
  cur.el.innerHTML = markdown(cur.text);
  scrollEnd();
}

function addTool(e) {
  cur = null;
  hideThinking();
  const label = (TOOL_LABEL[e.name] || (() => e.name))(e.input || {});
  const row = h(`<div class="ai-tool ${READS.has(e.name) ? 'read' : ''}"><span class="mini-spin"></span><span>${escapeHtml(label)}</span></div>`);
  tools.set(e.id, row);
  body.appendChild(row);
  scrollEnd();
}

function toolDone(e) {
  const row = tools.get(e.id);
  if (!row) return;
  row.querySelector('.mini-spin')?.replaceWith(h(`<span class="ai-tool-ico ${e.error ? 'err' : ''}">${icon(e.error ? 'close' : 'check', 12)}</span>`));
  if (e.error) row.classList.add('failed');
  if (busy) showThinking();
}

function addApproval(e) {
  cur = null;
  hideThinking();
  const shown = e.items.slice(0, 6);
  const card = h(`<div class="ai-approve" data-id="${e.requestId}">
    <div class="ai-approve-title">${icon(e.danger ? 'warning' : 'info', 16)}<span>${escapeHtml(e.title)}</span></div>
    ${e.reason ? `<div class="ai-approve-reason">${escapeHtml(e.reason)}</div>` : ''}
    <div class="ai-approve-list">${shown
      .map((it) => `<div class="ai-approve-item">${it.link ? `<a href="${escapeHtml(it.link)}">${escapeHtml(it.title)}</a>` : `<span>${escapeHtml(it.title)}</span>`}${it.sub ? `<span class="muted">${escapeHtml(it.sub)}</span>` : ''}</div>`)
      .join('')}${e.items.length > shown.length ? `<div class="ai-approve-more muted">还有 ${e.items.length - shown.length} 项</div>` : ''}</div>
    <div class="ai-approve-actions">
      <button class="btn btn-sm" data-ok="0">取消</button>
      <button class="btn btn-sm ${e.danger ? 'btn-danger-fill' : 'btn-primary'}" data-ok="1">${escapeHtml(e.okText)}</button>
    </div>
  </div>`);
  card.querySelectorAll('[data-ok]').forEach((b) => {
    b.onclick = () => {
      card.querySelectorAll('button').forEach((x) => (x.disabled = true));
      api.ai.approve({ requestId: e.requestId, ok: b.dataset.ok === '1' });
    };
  });
  body.appendChild(card);
  scrollEnd();
  if (!open) toggleAi(true);
}

function approvalDone(e) {
  const card = body.querySelector(`.ai-approve[data-id="${e.requestId}"]`);
  if (!card) return;
  card.classList.add('answered');
  card.querySelector('.ai-approve-actions').innerHTML = `<span class="ai-approve-state ${e.ok ? 'ok' : ''}">${icon(e.ok ? 'check' : 'close', 13)}${e.ok ? '已确认' : '已取消'}</span>`;
  if (busy) showThinking();
}

function onEvent(e) {
  switch (e.type) {
    case 'text':
      appendText(e.delta);
      break;
    case 'text_start':
      if (cur && cur.text) cur = null;
      break;
    case 'tool':
      addTool(e);
      break;
    case 'tool_done':
      toolDone(e);
      break;
    case 'approval':
      addApproval(e);
      break;
    case 'approval_done':
      approvalDone(e);
      break;
    case 'error':
      addError(e.message);
      setBusy(false);
      break;
    case 'done':
      if (e.error) addError(e.error);
      cur = null;
      setBusy(false);
      break;
  }
}

// mail://mN 打开邮件；其他链接用系统浏览器
async function onLinkClick(e) {
  const a = e.target.closest('a');
  if (!a) return;
  e.preventDefault();
  const href = a.getAttribute('href') || '';
  if (href.startsWith('mail://')) {
    const r = await api.ai.resolve(href).catch(() => null);
    if (!r) return toast('找不到这封邮件，可能已被移动或删除', 'error');
    await setView({ type: 'folder', accountId: r.accountId, path: r.path });
    select(`${r.accountId}|${r.path}|${r.uid}`);
  } else if (/^https?:/i.test(href)) {
    api.app.openExternal(href);
  }
}

// ---------- 简易 Markdown（先转义，再处理粗体、行内代码、链接、标题、列表） ----------
function inline(s) {
  return s
    .replace(/`([^`]+)`/g, '<code>$1</code>')
    .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
    .replace(/\[((?:[^\[\]]|\[[^\]]*\])+)\]\(((?:mail|https?):\/\/[^)\s]+)\)/g, (_, t, u) => `<a href="${u}"${u.startsWith('mail://') ? ' class="mail-link"' : ''}>${t}</a>`);
}

function markdown(src) {
  const lines = escapeHtml(src).split('\n');
  const out = [];
  let list = null; // 'ul' | 'ol'
  const close = () => {
    if (list) out.push(`</${list}>`);
    list = null;
  };
  for (const raw of lines) {
    const line = raw.trimEnd();
    let m;
    if ((m = line.match(/^\s*[-*•]\s+(.*)$/))) {
      if (list !== 'ul') {
        close();
        out.push('<ul>');
        list = 'ul';
      }
      out.push(`<li>${inline(m[1])}</li>`);
    } else if ((m = line.match(/^\s*\d+[.)]\s+(.*)$/))) {
      if (list !== 'ol') {
        close();
        out.push('<ol>');
        list = 'ol';
      }
      out.push(`<li>${inline(m[1])}</li>`);
    } else if ((m = line.match(/^#{1,4}\s+(.*)$/))) {
      close();
      out.push(`<div class="md-h">${inline(m[1])}</div>`);
    } else if (!line.trim()) {
      close();
    } else {
      close();
      out.push(`<p>${inline(line)}</p>`);
    }
  }
  close();
  return out.join('');
}
