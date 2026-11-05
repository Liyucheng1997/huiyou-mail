// 添加 / 编辑邮箱账户：输入邮箱自动识别服务商，给出“授权码”获取说明；高级设置可改服务器
import { h, escapeHtml } from './util.js';
import { icon } from './icons.js';
import { api, state, loadAccounts, refreshUnread } from './state.js';
import { openModal, toast } from './ui.js';

let providers = null;
const SHORT = { gmail: 'G', qq: 'Q', netease163: '163', netease126: '126', icloud: 'i', outlook: 'O', yahoo: 'Y', custom: '@' };

export async function openAccountDialog(existing = null) {
  if (!providers) providers = await api.providers.list();
  const isEdit = !!existing;
  const acc = existing
    ? JSON.parse(JSON.stringify(existing))
    : { email: '', name: '', provider: null, imap: { host: '', port: 993, secure: true }, smtp: { host: '', port: 465, secure: true }, saveSent: true, signature: '' };

  const quick = ['gmail', 'qq', 'netease163', 'netease126', 'icloud', 'outlook', 'yahoo', 'custom'];
  const content = h(`<div class="acc-dialog">
    ${isEdit ? '' : `<div class="prov-grid">${quick
      .map((id) => `<button class="prov" data-p="${id}"><span class="prov-ico ${SHORT[id].length > 1 ? 'small' : ''}">${SHORT[id]}</span><span>${escapeHtml(providers[id].name)}</span></button>`)
      .join('')}</div>`}
    <div class="form">
      <div class="form-row"><span class="form-label">邮箱地址</span><input class="input" data-f="email" placeholder="name@example.com" spellcheck="false" ${isEdit ? 'disabled' : ''}></div>
      <div class="form-row"><span class="form-label" data-l="pass">密码</span><input class="input" data-f="password" type="password" placeholder="${isEdit ? '不修改请留空' : ''}" spellcheck="false"></div>
      <div class="help-box hidden"><div class="help-title"></div><div class="help-text"></div><button class="btn btn-ghost btn-sm help-link">${icon('external', 14)}打开设置页面</button></div>
      <div class="form-row"><span class="form-label">发件人名称</span><input class="input" data-f="name" placeholder="收件人看到的名字，可留空"></div>
      <div class="form-row"><span class="form-label">在侧栏显示为</span><input class="input" data-f="label" placeholder="默认显示邮箱地址，例如“工作”"></div>
      <details class="adv" ${isEdit ? '' : ''}>
        <summary>${icon('chevron', 14)}服务器设置</summary>
        <div class="form adv-body">
          <div class="adv-title">收信（IMAP）</div>
          <div class="form-row"><span class="form-label">服务器</span><input class="input" data-f="imap.host" spellcheck="false"><input class="input port" data-f="imap.port" type="number"><label class="form-check"><input type="checkbox" data-f="imap.secure">SSL</label></div>
          <div class="adv-title">发信（SMTP）</div>
          <div class="form-row"><span class="form-label">服务器</span><input class="input" data-f="smtp.host" spellcheck="false"><input class="input port" data-f="smtp.port" type="number"><label class="form-check"><input type="checkbox" data-f="smtp.secure">SSL</label></div>
          <div class="form-row"><span class="form-label">登录用户名</span><input class="input" data-f="username" placeholder="默认与邮箱地址相同" spellcheck="false"></div>
          <label class="form-check"><input type="checkbox" data-f="saveSent">发出的邮件存一份到“已发送”（Gmail、Outlook 会自动保存，不用勾）</label>
          <label class="form-check"><input type="checkbox" data-f="allowInsecure">允许无效的服务器证书（仅限自建邮箱）</label>
        </div>
      </details>
      ${isEdit ? `<div class="form-label">签名</div><textarea class="input" data-f="signature" rows="3" placeholder="会自动加在新邮件和回复的末尾"></textarea>` : ''}
    </div>
  </div>`);
  const footer = h(`<div class="modal-footer">
    <div class="form-error hidden"><span class="state-dot danger"></span><span></span></div>
    <button class="btn" data-a="cancel">取消</button>
    <button class="btn btn-primary" data-a="ok">${isEdit ? '保存' : '连接并添加'}</button>
  </div>`);
  const m = openModal({ title: isEdit ? '账户设置' : '添加邮箱', content, footer, width: 540 });

  const f = (name) => content.querySelector(`[data-f="${name}"]`);
  const get = (obj, p) => p.split('.').reduce((o, k) => (o ? o[k] : undefined), obj);
  const set = (obj, p, v) => {
    const ks = p.split('.');
    const last = ks.pop();
    ks.reduce((o, k) => (o[k] = o[k] || {}), obj)[last] = v;
  };
  const fieldNames = ['email', 'name', 'label', 'imap.host', 'imap.port', 'imap.secure', 'smtp.host', 'smtp.port', 'smtp.secure', 'username', 'saveSent', 'allowInsecure', 'signature'];
  const fill = () => {
    for (const n of fieldNames) {
      const el = f(n);
      if (!el) continue;
      if (el.type === 'checkbox') el.checked = !!get(acc, n);
      else el.value = get(acc, n) ?? '';
    }
  };
  const read = () => {
    for (const n of fieldNames) {
      const el = f(n);
      if (!el) continue;
      set(acc, n, el.type === 'checkbox' ? el.checked : el.type === 'number' ? Number(el.value) : el.value.trim());
    }
  };

  const helpBox = content.querySelector('.help-box');
  const applyProvider = (id, guess) => {
    acc.provider = id;
    const p = providers[id];
    if (!p) return helpBox.classList.add('hidden');
    content.querySelectorAll('.prov').forEach((b) => b.classList.toggle('active', b.dataset.p === id));
    if (!isEdit) {
      const servers = id === 'custom' && guess ? guess : p;
      acc.imap = { ...servers.imap };
      acc.smtp = { ...servers.smtp };
      acc.saveSent = p.saveSent;
      if (id === 'custom') content.querySelector('.adv').open = true;
    }
    content.querySelector('[data-l=pass]').textContent = p.passwordLabel;
    f('password').placeholder = isEdit ? '不修改请留空' : `${p.name}的${p.passwordLabel}`;
    helpBox.classList.remove('hidden');
    helpBox.querySelector('.help-title').innerHTML = `${icon('info', 15)}<span>${escapeHtml(p.name)}需要“${escapeHtml(p.passwordLabel)}”</span>`;
    helpBox.querySelector('.help-text').textContent = p.help;
    const link = helpBox.querySelector('.help-link');
    link.classList.toggle('hidden', !p.helpUrl);
    link.onclick = () => api.app.openExternal(p.helpUrl);
    const keep = { email: f('email').value, password: f('password').value, name: f('name').value, label: f('label').value };
    fill();
    Object.entries(keep).forEach(([k, v]) => f(k) && (f(k).value = v));
  };

  fill();
  if (acc.provider) applyProvider(acc.provider);
  content.querySelectorAll('.prov').forEach((b) => {
    b.onclick = () => {
      applyProvider(b.dataset.p, b.dataset.p === 'custom' ? null : undefined);
      f('email').focus();
    };
  });
  f('email').addEventListener('change', async () => {
    const email = f('email').value.trim();
    if (!email.includes('@')) return;
    const { id, guess } = await api.providers.detect(email);
    // 用户已经手动选了“其他”或者识别结果相同，就只补全服务器猜测
    if (id === 'custom' && acc.provider && acc.provider !== 'custom') {
      if (providers[acc.provider].domains.length) applyProvider('custom', guess);
      return;
    }
    if (id && id !== acc.provider) applyProvider(id, guess);
    else if (id === 'custom' && !f('imap.host').value) applyProvider('custom', guess);
  });

  const errBox = footer.querySelector('.form-error');
  const showError = (msg) => {
    errBox.classList.toggle('hidden', !msg);
    errBox.querySelector('span:last-child').textContent = msg || '';
  };

  footer.querySelector('[data-a=cancel]').onclick = () => m.close();
  const ok = footer.querySelector('[data-a=ok]');
  ok.onclick = async () => {
    read();
    const password = f('password').value;
    if (!/^[^\s@]+@[^\s@]+$/.test(acc.email)) return showError('请填写正确的邮箱地址');
    if (!isEdit && !password) return showError('请填写密码或授权码');
    if (!acc.imap.host || !acc.smtp.host) {
      content.querySelector('.adv').open = true;
      return showError('请填写收信和发信服务器');
    }
    if (!isEdit && state.accounts.some((a) => a.email.toLowerCase() === acc.email.toLowerCase())) return showError('这个邮箱已经添加过了');
    showError('');
    ok.disabled = true;
    ok.innerHTML = '<span class="mini-spin light"></span>正在连接…';
    const serverChanged = !isEdit || password || ['imap', 'smtp', 'username', 'allowInsecure'].some((k) => JSON.stringify(acc[k]) !== JSON.stringify(existing[k]));
    try {
      if (serverChanged) await api.accounts.test({ account: acc, password });
      const { hasPassword, ...clean } = acc;
      await api.accounts.save({ account: clean, password });
      await loadAccounts();
      refreshUnread();
      toast(isEdit ? '已保存' : `已添加 ${acc.email}，正在收信…`, 'success', 3000);
      m.close();
    } catch (err) {
      showError(err.message);
      ok.disabled = false;
      ok.textContent = isEdit ? '保存' : '连接并添加';
    }
  };
  content.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && e.target.tagName === 'INPUT') ok.click();
  });
  setTimeout(() => (isEdit ? f('name') : f('email')).focus(), 50);
}
