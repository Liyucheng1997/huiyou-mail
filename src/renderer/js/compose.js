// 写信：新邮件 / 回复 / 全部回复 / 转发 / 编辑草稿。收件人输入带联系人补全，正文是简易富文本。
import { h, escapeHtml, displayName, fmtSize, longDate } from './util.js';
import { icon } from './icons.js';
import { state, api, accountById, inboxOf, findMessage } from './state.js';
import { openModal, toast, choiceDialog, promptDialog, topOverlay } from './ui.js';
import { opened } from './reader.js';

let current = null; // 已打开的写信窗口
let contactsCache = null;

async function loadContacts() {
  if (!contactsCache) contactsCache = await api.mail.contacts().catch(() => []);
  return contactsCache;
}

const fmtAddr = (a) => (a.name ? `${a.name} <${a.address}>` : a.address);
const isEmail = (s) => /^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+$/.test(s);

function parseAddr(text) {
  const t = text.trim().replace(/[,;，；]+$/, '');
  if (!t) return null;
  const m = t.match(/^\s*"?([^"<]*?)"?\s*<([^>]+)>\s*$/);
  if (m) return { name: m[1].trim(), address: m[2].trim() };
  return { name: '', address: t };
}

// 收件人输入框：回车 / 逗号 / 失焦变成胶囊，退格删除最后一个
function recipientField(initial = []) {
  const list = [...initial];
  const el = h(`<div class="rcpt"><div class="rcpt-chips"></div><input class="rcpt-input" spellcheck="false"></div>`);
  const chips = el.querySelector('.rcpt-chips');
  const input = el.querySelector('.rcpt-input');
  let pop = null;
  let active = 0;
  let matches = [];

  const draw = () => {
    chips.innerHTML = '';
    list.forEach((a, i) => {
      const c = h(`<span class="chip-addr ${isEmail(a.address) ? '' : 'invalid'}" title="${escapeHtml(a.address)}">${escapeHtml(a.name || a.address)}<button tabindex="-1">${icon('close', 11)}</button></span>`);
      c.querySelector('button').onclick = (e) => {
        e.stopPropagation();
        list.splice(i, 1);
        draw();
      };
      chips.appendChild(c);
    });
  };
  const commit = () => {
    const parts = input.value.split(/[,;，；\n]/);
    for (const p of parts) {
      const a = parseAddr(p);
      if (a && !list.some((x) => x.address.toLowerCase() === a.address.toLowerCase())) list.push(a);
    }
    input.value = '';
    draw();
    closePop();
  };
  const closePop = () => {
    if (pop) pop.remove();
    pop = null;
  };
  const pick = (c) => {
    if (!list.some((x) => x.address.toLowerCase() === c.address.toLowerCase())) list.push({ name: c.name, address: c.address });
    input.value = '';
    draw();
    closePop();
    input.focus();
  };
  const suggest = async () => {
    const q = input.value.trim().toLowerCase();
    if (!q) return closePop();
    const all = await loadContacts();
    matches = all.filter((c) => c.address.toLowerCase().includes(q) || (c.name || '').toLowerCase().includes(q)).slice(0, 6);
    if (!matches.length) return closePop();
    active = 0;
    if (!pop) {
      pop = h('<div class="popover menu rcpt-pop"></div>');
      document.body.appendChild(pop);
    }
    const r = el.getBoundingClientRect();
    pop.style.left = r.left + 'px';
    pop.style.top = r.bottom + 4 + 'px';
    pop.style.width = Math.min(r.width, 420) + 'px';
    pop.innerHTML = '';
    matches.forEach((c, i) => {
      const row = h(`<div class="menu-item ${i === active ? 'kb' : ''}"><span class="menu-label">${escapeHtml(c.name || c.address)}</span><span class="menu-shortcut">${escapeHtml(c.name ? c.address : '')}</span></div>`);
      row.onmousedown = (e) => {
        e.preventDefault();
        pick(c);
      };
      pop.appendChild(row);
    });
  };
  input.addEventListener('input', () => {
    if (/[,;，；]$/.test(input.value)) commit();
    else suggest();
  });
  input.addEventListener('keydown', (e) => {
    if (pop && (e.key === 'ArrowDown' || e.key === 'ArrowUp')) {
      e.preventDefault();
      active = (active + (e.key === 'ArrowDown' ? 1 : -1) + matches.length) % matches.length;
      pop.querySelectorAll('.menu-item').forEach((x, i) => x.classList.toggle('kb', i === active));
      return;
    }
    if (e.key === 'Enter' || e.key === 'Tab') {
      if (pop && matches[active]) {
        e.preventDefault();
        pick(matches[active]);
        return;
      }
      if (input.value.trim()) {
        if (e.key === 'Enter') e.preventDefault();
        commit();
      }
    }
    if (e.key === 'Escape' && pop) {
      e.stopPropagation();
      closePop();
    }
    if (e.key === 'Backspace' && !input.value && list.length) {
      list.pop();
      draw();
    }
  });
  input.addEventListener('blur', () => setTimeout(() => input.value.trim() && commit(), 120));
  input.addEventListener('paste', () => setTimeout(commit, 0));
  el.addEventListener('mousedown', (e) => {
    if (e.target === el || e.target === chips) {
      e.preventDefault();
      input.focus();
    }
  });
  draw();
  return {
    el,
    input,
    get value() {
      if (input.value.trim()) commit();
      return list;
    },
    close: closePop,
  };
}

function quoteHeader(msg) {
  return `在 ${longDate(msg.date)}，${escapeHtml(displayName(msg.from))} &lt;${escapeHtml(msg.from.address)}&gt; 写道：`;
}

function originalHtml(msg) {
  if (msg.html) {
    const doc = new DOMParser().parseFromString(msg.html, 'text/html');
    doc.querySelectorAll('script,style,meta,link,title').forEach((x) => x.remove());
    return doc.body ? doc.body.innerHTML : '';
  }
  return `<div style="white-space:pre-wrap">${escapeHtml(msg.text || '')}</div>`;
}

function signatureHtml(acc) {
  if (!acc || !acc.signature) return '';
  return `<div class="sig">-- <br>${escapeHtml(acc.signature).replace(/\n/g, '<br>')}</div>`;
}

const ownAddresses = () => new Set(state.accounts.map((a) => a.email.toLowerCase()));
const prefix = (p, s) => (new RegExp('^' + p + '\\s*[:：]', 'i').test(s || '') ? s : `${p}: ${s || ''}`);

// 根据模式准备初始内容
// AI 助手起草的内容：收件人 / 主题 / 正文（纯文本）填进写信窗口，签名和引用保留
function applyPrefill(init, pf) {
  if (pf.to && pf.to.length) init.to = pf.to.map(parseAddr).filter(Boolean);
  if (pf.cc && pf.cc.length) init.cc = pf.cc.map(parseAddr).filter(Boolean);
  if (pf.subject) init.subject = pf.subject;
  if (pf.body) {
    const html = String(pf.body)
      .split(/\r?\n/)
      .map((line) => (line.trim() ? `<div>${escapeHtml(line)}</div>` : '<div><br></div>'))
      .join('');
    init.body = html + init.body;
  }
}

async function prepare(opts) {
  const { mode, source } = opts;
  let accountId = opts.accountId || (source && source.accountId) || (state.view.accountId && accountById(state.view.accountId) ? state.view.accountId : state.accounts[0]?.id);
  const init = { accountId, to: [], cc: [], bcc: [], subject: '', body: '', attachments: [], carry: null, inReplyTo: '', references: [], replyTo: null, draftOf: null };
  if (opts.to) init.to = [parseAddr(opts.to)].filter(Boolean);
  if (mode === 'new' || !source) {
    init.body = `<div><br></div>${signatureHtml(accountById(accountId))}`;
    return init;
  }
  let msg = opened.message && opened.message.uid === source.uid && opened.message.path === source.path && opened.message.accountId === source.accountId ? opened.message : null;
  if (!msg) msg = await api.mail.read({ accountId: source.accountId, path: source.path, uid: source.uid });
  const acc = accountById(accountId);
  const own = ownAddresses();

  if (mode === 'draft') {
    Object.assign(init, {
      to: msg.to,
      cc: msg.cc,
      bcc: msg.bcc,
      subject: msg.subject,
      body: originalHtml(msg),
      draftOf: { accountId: source.accountId, path: source.path, uid: source.uid },
      inReplyTo: msg.inReplyTo,
      references: msg.references,
    });
    if (msg.attachments.length) init.carry = { accountId: source.accountId, path: source.path, uid: source.uid, list: msg.attachments };
    return init;
  }

  if (mode === 'reply' || mode === 'replyAll') {
    const replyTo = msg.replyTo && msg.replyTo.length ? msg.replyTo : [msg.from];
    // 回复自己发出的邮件时，收件人用原来的收件人
    init.to = own.has((msg.from.address || '').toLowerCase()) ? msg.to : replyTo;
    if (mode === 'replyAll') {
      const seen = new Set(init.to.map((a) => a.address.toLowerCase()));
      const add = (a) => {
        const k = a.address.toLowerCase();
        if (!seen.has(k) && !own.has(k)) {
          seen.add(k);
          init.cc.push(a);
        }
      };
      msg.to.forEach(add);
      msg.cc.forEach(add);
    }
    init.subject = prefix('Re', msg.subject);
    init.inReplyTo = msg.messageId;
    init.references = [...(msg.references || []), msg.messageId].filter(Boolean);
    init.replyTo = { accountId: source.accountId, path: source.path, uid: source.uid };
    init.body = `<div><br></div>${signatureHtml(acc)}<div class="quote-head">${quoteHeader(msg)}</div><blockquote>${originalHtml(msg)}</blockquote>`;
  } else if (mode === 'forward') {
    init.subject = prefix('Fwd', msg.subject);
    const meta = [
      `发件人：${escapeHtml(fmtAddr(msg.from))}`,
      `时间：${escapeHtml(longDate(msg.date))}`,
      `收件人：${escapeHtml(msg.to.map(fmtAddr).join('、'))}`,
      msg.cc.length ? `抄送：${escapeHtml(msg.cc.map(fmtAddr).join('、'))}` : '',
      `主题：${escapeHtml(msg.subject)}`,
    ].filter(Boolean).join('<br>');
    init.body = `<div><br></div>${signatureHtml(acc)}<div class="quote-head">---------- 转发的邮件 ----------<br>${meta}</div><br>${originalHtml(msg)}`;
    if (msg.attachments.length) init.carry = { accountId: source.accountId, path: source.path, uid: source.uid, list: msg.attachments };
  }
  return init;
}

export async function openCompose(opts = { mode: 'new' }) {
  if (!state.accounts.length) return toast('请先添加一个邮箱', 'error');
  if (current) {
    current.focus();
    return toast('已经有一封正在编辑的邮件');
  }
  let init;
  try {
    init = await prepare(opts);
  } catch (err) {
    return toast('无法载入原邮件：' + err.message, 'error', 4000);
  }
  if (opts.prefill) applyPrefill(init, opts.prefill);

  const files = []; // 新加的本地附件
  let carry = init.carry ? init.carry.list.map((a) => ({ ...a, keep: true })) : [];
  let dirty = false;
  let busy = false;

  const content = h(`<div class="compose">
    <div class="cf-row"><span class="cf-label">发件人</span><select class="cf-from"></select></div>
    <div class="cf-row"><span class="cf-label">收件人</span><div class="cf-slot" data-f="to"></div>
      <button class="cf-toggle" data-a="cc">抄送</button><button class="cf-toggle" data-a="bcc">密送</button></div>
    <div class="cf-row ${init.cc.length ? '' : 'hidden'}" data-row="cc"><span class="cf-label">抄送</span><div class="cf-slot" data-f="cc"></div></div>
    <div class="cf-row ${init.bcc.length ? '' : 'hidden'}" data-row="bcc"><span class="cf-label">密送</span><div class="cf-slot" data-f="bcc"></div></div>
    <div class="cf-row"><span class="cf-label">主题</span><input class="cf-subject" spellcheck="false"></div>
    <div class="cf-tools">
      <button data-cmd="bold" title="加粗 (Ctrl+B)">${icon('bold', 16)}</button>
      <button data-cmd="italic" title="斜体 (Ctrl+I)">${icon('italic', 16)}</button>
      <button data-cmd="underline" title="下划线 (Ctrl+U)">${icon('underline', 16)}</button>
      <span class="tb-sep"></span>
      <button data-cmd="insertUnorderedList" title="项目符号">${icon('list', 16)}</button>
      <button data-cmd="insertOrderedList" title="编号">${icon('listOrdered', 16)}</button>
      <button data-cmd="formatBlock" data-arg="blockquote" title="引用">${icon('quote', 16)}</button>
      <button data-cmd="link" title="插入链接">${icon('link', 16)}</button>
      <button data-cmd="removeFormat" title="清除格式">${icon('eraser', 16)}</button>
    </div>
    <div class="cf-body" contenteditable="true" spellcheck="false"></div>
    <div class="cf-atts"></div>
    <div class="cf-drop">松开即可添加为附件</div>
  </div>`);
  const footer = h(`<div class="modal-footer compose-footer">
    <button class="icon-btn" data-a="attach" title="添加附件">${icon('clip')}</button>
    <span class="cf-hint muted">Ctrl + Enter 发送</span>
    <span class="flex"></span>
    <button class="btn btn-danger" data-a="discard">丢弃</button>
    <button class="btn" data-a="draft">存草稿</button>
    <button class="btn btn-primary" data-a="send">${icon('send', 15)}发送</button>
  </div>`);

  const titles = { new: '写邮件', reply: '回复', replyAll: '全部回复', forward: '转发', draft: '编辑草稿' };
  const fields = { to: recipientField(init.to), cc: recipientField(init.cc), bcc: recipientField(init.bcc) };
  for (const [k, f] of Object.entries(fields)) content.querySelector(`[data-f=${k}]`).appendChild(f.el);

  const fromSel = content.querySelector('.cf-from');
  for (const a of state.accounts) fromSel.appendChild(h(`<option value="${a.id}">${escapeHtml(a.name ? `${a.name} <${a.email}>` : a.email)}</option>`));
  fromSel.value = init.accountId;
  const subject = content.querySelector('.cf-subject');
  subject.value = init.subject;
  const body = content.querySelector('.cf-body');
  body.innerHTML = init.body;

  const attsEl = content.querySelector('.cf-atts');
  const drawAtts = () => {
    attsEl.innerHTML = '';
    const all = [...carry.filter((a) => a.keep).map((a) => ({ name: a.filename, size: a.size, carry: a })), ...files.map((f) => ({ ...f, file: f }))];
    for (const a of all) {
      const chip = h(`<span class="att-chip">${icon('clip', 13)}<span class="att-chip-name">${escapeHtml(a.name)}</span><span class="muted tabular">${fmtSize(a.size || 0)}</span><button title="移除">${icon('close', 11)}</button></span>`);
      chip.querySelector('button').onclick = () => {
        if (a.carry) a.carry.keep = false;
        else files.splice(files.indexOf(a.file), 1);
        dirty = true;
        drawAtts();
      };
      attsEl.appendChild(chip);
    }
    const total = all.reduce((s, a) => s + (a.size || 0), 0);
    if (total > 20 * 1024 * 1024) attsEl.appendChild(h(`<span class="att-warn"><span class="state-dot warning"></span>附件共 ${fmtSize(total)}，很多邮箱限制在 20–25 MB 以内</span>`));
  };
  drawAtts();
  const addFiles = (list) => {
    for (const f of list) if (!files.some((x) => x.path === f.path)) files.push(f);
    dirty = true;
    drawAtts();
  };

  const modal = openModal({ title: titles[opts.mode] || '写邮件', content, footer, width: 780, className: 'compose-modal', onRequestClose: () => tryClose() });
  const overlay = modal.el.parentElement;
  const tryClose = async () => {
    if (busy) return;
    if (!dirty) return finish();
    const r = await choiceDialog({
      title: '保存这封邮件的草稿？',
      message: '不保存的话，内容会丢失。',
      buttons: [
        { label: '存草稿', value: 'save', primary: true },
        { label: '不保存', value: 'discard', danger: true },
        { label: '继续编辑', value: null },
      ],
    });
    if (r === 'save') saveDraft();
    else if (r === 'discard') finish();
  };
  const finish = () => {
    Object.values(fields).forEach((f) => f.close());
    current = null;
    document.removeEventListener('keydown', onKey, true);
    modal.close();
  };
  const onKey = (e) => {
    if (topOverlay() !== overlay) return;
    if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
      e.preventDefault();
      doSend();
    }
  };
  document.addEventListener('keydown', onKey, true);

  content.addEventListener('input', () => (dirty = true));
  content.querySelectorAll('.cf-toggle').forEach((b) => {
    b.onclick = () => {
      const row = content.querySelector(`[data-row=${b.dataset.a}]`);
      row.classList.remove('hidden');
      fields[b.dataset.a].input.focus();
      b.classList.add('hidden');
    };
    if (init[b.dataset.a].length) b.classList.add('hidden');
  });
  fromSel.onchange = () => {
    // 换发件账户时，把签名换成新账户的
    const sig = body.querySelector('.sig');
    const html = signatureHtml(accountById(fromSel.value));
    if (sig) sig.outerHTML = html || '';
    dirty = true;
  };
  content.querySelector('.cf-tools').addEventListener('mousedown', (e) => e.preventDefault());
  content.querySelector('.cf-tools').addEventListener('click', async (e) => {
    const b = e.target.closest('[data-cmd]');
    if (!b) return;
    body.focus();
    if (b.dataset.cmd === 'link') {
      const sel = window.getSelection();
      const range = sel.rangeCount ? sel.getRangeAt(0).cloneRange() : null;
      const url = await promptDialog({ title: '插入链接', placeholder: 'https://', value: 'https://', okText: '插入' });
      if (!url) return;
      body.focus();
      if (range) {
        sel.removeAllRanges();
        sel.addRange(range);
      }
      if (range && !range.collapsed) document.execCommand('createLink', false, url);
      else document.execCommand('insertHTML', false, `<a href="${escapeHtml(url)}">${escapeHtml(url)}</a>`);
    } else document.execCommand(b.dataset.cmd, false, b.dataset.arg || null);
    dirty = true;
  });
  // 粘贴：保留简单格式，去掉脚本和样式表
  body.addEventListener('paste', (e) => {
    const html = e.clipboardData.getData('text/html');
    if (!html) return;
    e.preventDefault();
    const doc = new DOMParser().parseFromString(html, 'text/html');
    doc.querySelectorAll('script,style,meta,link,iframe,object').forEach((x) => x.remove());
    document.execCommand('insertHTML', false, doc.body.innerHTML);
  });
  // 拖入文件作为附件
  const drop = content.querySelector('.cf-drop');
  content.addEventListener('dragover', (e) => {
    if (e.dataTransfer.types.includes('Files')) {
      e.preventDefault();
      drop.classList.add('show');
    }
  });
  content.addEventListener('dragleave', (e) => {
    if (!content.contains(e.relatedTarget)) drop.classList.remove('show');
  });
  content.addEventListener('drop', async (e) => {
    drop.classList.remove('show');
    if (!e.dataTransfer.files.length) return;
    e.preventDefault();
    const paths = [...e.dataTransfer.files].map((f) => api.pathForFile(f)).filter(Boolean);
    addFiles(await api.mail.fileInfo(paths));
  });

  const collect = () => ({
    accountId: fromSel.value,
    to: fields.to.value,
    cc: fields.cc.value,
    bcc: fields.bcc.value,
    subject: subject.value.trim(),
    html: `<div style="font-family:-apple-system,'PingFang SC','Microsoft YaHei',sans-serif;font-size:14px;line-height:1.6">${body.innerHTML}</div>`,
    text: body.innerText,
    attachments: files.map((f) => ({ path: f.path, name: f.name })),
    carry: init.carry ? { accountId: init.carry.accountId, path: init.carry.path, uid: init.carry.uid, indexes: carry.filter((a) => a.keep).map((a) => a.index) } : null,
    inReplyTo: init.inReplyTo,
    references: init.references,
    replyTo: init.replyTo,
    draftOf: init.draftOf,
  });

  const setBusy = (v, label) => {
    busy = v;
    footer.querySelectorAll('button').forEach((b) => (b.disabled = v));
    const send = footer.querySelector('[data-a=send]');
    send.innerHTML = v && label ? `<span class="mini-spin light"></span>${label}` : `${icon('send', 15)}发送`;
  };

  async function doSend() {
    if (busy) return;
    const d = collect();
    const all = [...d.to, ...d.cc, ...d.bcc];
    if (!all.length) return toast('请填写收件人', 'error') || fields.to.input.focus();
    const bad = all.find((a) => !isEmail(a.address));
    if (bad) return toast(`收件人地址不正确：${bad.address}`, 'error', 3500);
    if (!d.subject) {
      const r = await choiceDialog({ title: '这封邮件没有主题', message: '确定不写主题直接发送吗？', buttons: [{ label: '仍然发送', value: true, primary: true }, { label: '返回填写', value: false }] });
      if (!r) return subject.focus();
    }
    if (/附件|attach/i.test(d.text + d.subject) && !d.attachments.length && !(d.carry && d.carry.indexes.length)) {
      const r = await choiceDialog({ title: '忘记添加附件了吗？', message: '邮件里提到了“附件”，但还没有添加任何文件。', buttons: [{ label: '仍然发送', value: true, primary: true }, { label: '返回添加', value: false }] });
      if (!r) return;
    }
    setBusy(true, '正在发送');
    try {
      await api.mail.send(d);
      contactsCache = null;
      toast('已发送', 'success');
      finish();
    } catch (err) {
      setBusy(false);
      toast(err.message, 'error', 5000);
    }
  }

  async function saveDraft() {
    if (busy) return;
    setBusy(true);
    try {
      await api.mail.saveDraft(collect());
      toast('草稿已保存', 'success');
      finish();
    } catch (err) {
      setBusy(false);
      toast('保存草稿失败：' + err.message, 'error', 4000);
    }
  }

  footer.querySelector('[data-a=send]').onclick = doSend;
  footer.querySelector('[data-a=draft]').onclick = saveDraft;
  footer.querySelector('[data-a=discard]').onclick = () => finish();
  footer.querySelector('[data-a=attach]').onclick = async () => addFiles(await api.mail.pickFiles());

  current = { focus: () => (init.to.length ? body : fields.to.input).focus() };
  setTimeout(() => {
    if (opts.mode === 'new' || opts.mode === 'forward') (init.to.length ? subject : fields.to.input).focus();
    else {
      body.focus();
      const r = document.createRange();
      r.setStart(body, 0);
      r.collapse(true);
      const sel = window.getSelection();
      sel.removeAllRanges();
      sel.addRange(r);
    }
  }, 60);
}

export function isComposing() {
  return !!current;
}

export { inboxOf, findMessage };
