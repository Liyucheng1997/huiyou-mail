// 弹层组件：toast、对话框、确认框、右键菜单、开关
import { h, escapeHtml } from './util.js';
import { icon } from './icons.js';

export const topOverlay = () => {
  const all = document.querySelectorAll('.modal-overlay:not(.closing)');
  return all[all.length - 1] || null;
};

let toastHost = null;
export function toast(message, type = 'info', ms = 2400) {
  if (!toastHost) {
    toastHost = h('<div class="toast-host"></div>');
    document.body.appendChild(toastHost);
  }
  const el = h(`<div class="toast toast-${type}">${escapeHtml(message)}</div>`);
  toastHost.appendChild(el);
  requestAnimationFrame(() => el.classList.add('show'));
  setTimeout(() => {
    el.classList.remove('show');
    setTimeout(() => el.remove(), 300);
  }, ms);
}

// 通用对话框：content 是元素；返回 { el, close }
// onRequestClose：用户按 Esc / 点遮罩 / 点 × 时调用它，而不是直接关闭（用于“要不要保存”这类确认）
export function openModal({ title, content, width = 440, footer = null, onClose = null, onRequestClose = null, className = '' }) {
  const overlay = h(`<div class="modal-overlay"><div class="modal ${className}" style="width:${width}px"></div></div>`);
  const modal = overlay.firstElementChild;
  if (title !== null) {
    modal.appendChild(h(`<div class="modal-header"><span>${escapeHtml(title || '')}</span><button class="modal-x" title="关闭">${icon('close', 14)}</button></div>`));
  }
  const body = h('<div class="modal-body"></div>');
  if (content) body.appendChild(content);
  modal.appendChild(body);
  if (footer) modal.appendChild(footer);
  let closed = false;
  const close = (result) => {
    if (closed) return;
    closed = true;
    overlay.classList.add('closing');
    setTimeout(() => overlay.remove(), 140);
    document.removeEventListener('keydown', onKey, true);
    if (onClose) onClose(result);
  };
  const request = () => (onRequestClose ? onRequestClose() : close());
  const onKey = (e) => {
    if (e.key === 'Escape' && overlay === topOverlay() && !document.querySelector('.popover')) {
      e.stopPropagation();
      e.preventDefault();
      request();
    }
  };
  document.addEventListener('keydown', onKey, true);
  overlay.addEventListener('mousedown', (e) => {
    if (e.target === overlay) request();
  });
  const x = modal.querySelector('.modal-x');
  if (x) x.onclick = () => request();
  document.body.appendChild(overlay);
  return { el: modal, body, close };
}

// 确认框：居中 380px，顶部圆形图标，两个等宽按钮
export function confirmDialog({ title, message = '', okText = '确定', cancelText = '取消', danger = false, iconName = null }) {
  return new Promise((resolve) => {
    const content = h(`<div class="confirm">
      <div class="confirm-ico ${danger ? 'danger' : ''}">${icon(iconName || (danger ? 'trash' : 'info'), 22)}</div>
      <div class="confirm-title">${escapeHtml(title)}</div>
      ${message ? `<div class="confirm-msg">${escapeHtml(message)}</div>` : ''}
      <div class="confirm-actions">
        <button class="btn" data-a="cancel">${escapeHtml(cancelText)}</button>
        <button class="btn ${danger ? 'btn-danger-fill' : 'btn-primary'}" data-a="ok">${escapeHtml(okText)}</button>
      </div>
    </div>`);
    let result = false;
    const onEnter = (e) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        e.stopPropagation();
        result = true;
        m.close();
      }
    };
    const m = openModal({
      title: null,
      content,
      width: 380,
      onClose: () => {
        document.removeEventListener('keydown', onEnter, true);
        resolve(result);
      },
    });
    content.querySelector('[data-a=cancel]').onclick = () => m.close();
    content.querySelector('[data-a=ok]').onclick = () => {
      result = true;
      m.close();
    };
    document.addEventListener('keydown', onEnter, true);
  });
}

// 三选一（例如关闭写信窗口：保存草稿 / 丢弃 / 取消）
export function choiceDialog({ title, message = '', buttons }) {
  return new Promise((resolve) => {
    const content = h(`<div class="confirm">
      <div class="confirm-ico">${icon('info', 22)}</div>
      <div class="confirm-title">${escapeHtml(title)}</div>
      ${message ? `<div class="confirm-msg">${escapeHtml(message)}</div>` : ''}
      <div class="confirm-actions col"></div>
    </div>`);
    let result = null;
    const m = openModal({ title: null, content, width: 380, onClose: () => resolve(result) });
    const box = content.querySelector('.confirm-actions');
    for (const b of buttons) {
      const el = h(`<button class="btn ${b.primary ? 'btn-primary' : ''} ${b.danger ? 'btn-danger' : ''}">${escapeHtml(b.label)}</button>`);
      el.onclick = () => {
        result = b.value;
        m.close();
      };
      box.appendChild(el);
    }
  });
}

export function promptDialog({ title, label = '', value = '', okText = '确定', placeholder = '' }) {
  return new Promise((resolve) => {
    const content = h(`<div class="form">
      ${label ? `<div class="form-label">${escapeHtml(label)}</div>` : ''}
      <input class="input" placeholder="${escapeHtml(placeholder)}" value="${escapeHtml(value)}">
    </div>`);
    const footer = h(`<div class="modal-footer"><button class="btn" data-a="cancel">取消</button><button class="btn btn-primary" data-a="ok">${escapeHtml(okText)}</button></div>`);
    let result = null;
    const m = openModal({ title, content, footer, width: 400, onClose: () => resolve(result) });
    const input = content.querySelector('input');
    const ok = () => {
      result = input.value.trim();
      m.close();
    };
    footer.querySelector('[data-a=cancel]').onclick = () => m.close();
    footer.querySelector('[data-a=ok]').onclick = ok;
    input.onkeydown = (e) => e.key === 'Enter' && ok();
    setTimeout(() => (input.focus(), input.select()), 30);
  });
}

// 菜单：items = [{label, icon, shortcut, onClick, disabled, danger} | 'sep' | {header} | {label, submenu:[...]}]
let openMenuEl = null;
export function closeMenu() {
  if (openMenuEl) {
    openMenuEl.remove();
    openMenuEl = null;
  }
  document.querySelectorAll('.popover.submenu').forEach((el) => el.remove());
}

function buildMenu(items, x, y, isSub = false) {
  const el = h(`<div class="popover menu ${isSub ? 'submenu' : ''}"></div>`);
  for (const it of items) {
    if (it === 'sep') {
      el.appendChild(h('<div class="menu-sep"></div>'));
      continue;
    }
    if (it.header) {
      el.appendChild(h(`<div class="menu-header">${escapeHtml(it.header)}</div>`));
      continue;
    }
    const row = h(`<div class="menu-item ${it.disabled ? 'disabled' : ''} ${it.danger ? 'danger' : ''}">
      <span class="menu-icon">${it.icon ? icon(it.icon, 15) : it.checked ? icon('check', 15) : ''}</span>
      <span class="menu-label">${escapeHtml(it.label)}</span>
      ${it.shortcut ? `<span class="menu-shortcut">${escapeHtml(it.shortcut)}</span>` : ''}
      ${it.submenu ? `<span class="menu-shortcut">${icon('chevron', 13)}</span>` : ''}
    </div>`);
    if (it.submenu) {
      row.onmouseenter = () => {
        document.querySelectorAll('.popover.submenu').forEach((s) => s.remove());
        const r = row.getBoundingClientRect();
        const sub = buildMenu(it.submenu, r.right + 2, r.top - 5, true);
        document.body.appendChild(sub);
        place(sub, r.right + 2, r.top - 5, r.left);
      };
    } else {
      row.onmouseenter = () => {
        if (!isSub) document.querySelectorAll('.popover.submenu').forEach((s) => s.remove());
      };
      row.onclick = (e) => {
        e.stopPropagation();
        if (it.disabled) return;
        closeMenu();
        it.onClick && it.onClick();
      };
    }
    el.appendChild(row);
  }
  return el;
}

function place(el, x, y, flipX = null) {
  const r = el.getBoundingClientRect();
  let left = x;
  let top = y;
  if (left + r.width > innerWidth - 6) left = flipX !== null ? flipX - r.width - 2 : innerWidth - r.width - 6;
  if (top + r.height > innerHeight - 6) top = Math.max(6, innerHeight - r.height - 6);
  el.style.left = Math.max(6, left) + 'px';
  el.style.top = top + 'px';
}

export function showMenu(items, x, y) {
  closeMenu();
  const el = buildMenu(items, x, y);
  document.body.appendChild(el);
  place(el, x, y);
  openMenuEl = el;
}

export function menuAt(button, items) {
  const r = button.getBoundingClientRect();
  showMenu(items, r.left, r.bottom + 6);
}

document.addEventListener('mousedown', (e) => {
  if (openMenuEl && !e.target.closest('.popover')) closeMenu();
});
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && openMenuEl) {
    e.stopPropagation();
    closeMenu();
  }
}, true);
window.addEventListener('blur', closeMenu);
window.addEventListener('resize', closeMenu);

// iOS 风格开关
export function switchEl(checked, onChange) {
  const el = h(`<button class="switch ${checked ? 'on' : ''}" role="switch" aria-checked="${checked}"><span></span></button>`);
  el.onclick = () => {
    const v = !el.classList.contains('on');
    el.classList.toggle('on', v);
    el.setAttribute('aria-checked', v);
    onChange(v);
  };
  return el;
}

// 分段控件
export function segmented(options, value, onChange) {
  const el = h('<div class="seg"></div>');
  for (const o of options) {
    const b = h(`<button class="${o.value === value ? 'active' : ''}">${escapeHtml(o.label)}</button>`);
    b.onclick = () => {
      el.querySelectorAll('button').forEach((x) => x.classList.remove('active'));
      b.classList.add('active');
      onChange(o.value);
    };
    el.appendChild(b);
  }
  return el;
}
