// 添加 / 编辑邮箱账户：输入邮箱自动识别服务商，给出“授权码”获取说明；高级设置可改服务器。
// Gmail / Outlook 默认用浏览器登录（OAuth），也可以改用应用专用密码。
import { h, escapeHtml } from './util.js';
import { icon } from './icons.js';
import { api, state, loadAccounts, refreshUnread } from './state.js';
import { openModal, toast } from './ui.js';

let providers = null;
const SHORT = { gmail: 'G', qq: 'Q', netease163: '163', netease126: '126', icloud: 'i', outlook: 'O', yahoo: 'Y', custom: '@' };
const SPIN = '<span class="mini-spin light"></span>';

export async function openAccountDialog(existing = null) {
  if (!providers) providers = await api.providers.list();
  const isEdit = !!existing;
  const acc = existing
    ? JSON.parse(JSON.stringify(existing))
    : { email: '', name: '', provider: null, imap: { host: '', port: 993, secure: true }, smtp: { host: '', port: 465, secure: true }, saveSent: true, signature: '' };
  // 登录方式：oauth（浏览器登录）或 password（密码 / 授权码）
  let mode = isEdit ? (acc.auth === 'oauth2' ? 'oauth' : 'password') : 'password';
  let waiting = false;

  const quick = ['gmail', 'qq', 'netease163', 'netease126', 'icloud', 'outlook', 'yahoo', 'custom'];
  const content = h(`<div class="acc-dialog">
    ${isEdit ? '' : `<div class="prov-grid">${quick
      .map((id) => `<button class="prov" data-p="${id}"><span class="prov-ico ${SHORT[id].length > 1 ? 'small' : ''}">${SHORT[id]}</span><span>${escapeHtml(providers[id].name)}</span></button>`)
      .join('')}</div>`}
    <div class="form">
      <div class="form-row"><span class="form-label">邮箱地址</span><input class="input" data-f="email" placeholder="name@example.com" spellcheck="false" ${isEdit ? 'disabled' : ''}></div>
      <div class="oauth-box hidden">
        <div class="oauth-state"></div>
        <div class="oauth-actions">
          <button class="btn oauth-btn"></button>
          <button class="btn btn-ghost btn-sm hidden" data-a="oauth-cancel">取消</button>
        </div>
        <div class="oauth-note"></div>
        <div class="oauth-warn hidden"><span class="state-dot warning"></span><span class="oauth-warn-text"></span><button class="btn btn-ghost btn-sm" data-a="oauth-setup">去设置</button></div>
      </div>
      <div class="form-row pass-row"><span class="form-label" data-l="pass">密码</span><input class="input" data-f="password" type="password" placeholder="${isEdit ? '不修改请留空' : ''}" spellcheck="false"></div>
      <div class="help-box hidden"><div class="help-title"></div><div class="help-text"></div><button class="btn btn-ghost btn-sm help-link">${icon('external', 14)}打开设置页面</button></div>
      <button class="link-btn auth-switch hidden"></button>
      <div class="form-row"><span class="form-label">发件人名称</span><input class="input" data-f="name" placeholder="收件人看到的名字，可留空"></div>
      <div class="form-row"><span class="form-label">在侧栏显示为</span><input class="input" data-f="label" placeholder="默认显示邮箱地址，例如“工作”"></div>
      <details class="adv">
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
  const m = openModal({
    title: isEdit ? '账户设置' : '添加邮箱',
    content,
    footer,
    width: 540,
    onClose: () => waiting && api.oauth.cancel(),
  });

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

  const errBox = footer.querySelector('.form-error');
  const showError = (msg) => {
    errBox.classList.toggle('hidden', !msg);
    errBox.querySelector('span:last-child').textContent = msg || '';
  };

  // ---------- 登录方式 ----------
  const oauthBox = content.querySelector('.oauth-box');
  const oauthBtn = content.querySelector('.oauth-btn');
  const cancelBtn = content.querySelector('[data-a=oauth-cancel]');
  const switchBtn = content.querySelector('.auth-switch');
  const helpBox = content.querySelector('.help-box');
  const ok = footer.querySelector('[data-a=ok]');
  const oauthOf = () => (providers[acc.provider] || {}).oauth || null;
  const oauthName = () => ({ google: 'Google', microsoft: 'Microsoft' })[oauthOf()] || '';

  const renderMode = () => {
    const prov = providers[acc.provider];
    const can = !!oauthOf();
    if (!can) mode = 'password';
    const oauthMode = mode === 'oauth';
    oauthBox.classList.toggle('hidden', !oauthMode);
    content.querySelector('.pass-row').classList.toggle('hidden', oauthMode);
    helpBox.classList.toggle('hidden', oauthMode || !prov);
    // 新账户用浏览器登录时，主按钮就是“登录”，底部不再放第二个蓝色按钮
    ok.classList.toggle('hidden', oauthMode && !isEdit);
    f('email').placeholder = oauthMode && !isEdit ? '可留空，登录后自动填写' : 'name@example.com';
    switchBtn.classList.toggle('hidden', !can);
    if (can) {
      switchBtn.textContent = oauthMode
        ? `改用${prov.passwordLabel}`
        : acc.provider === 'outlook' ? `使用 ${oauthName()} 账号登录（推荐）` : `改用 ${oauthName()} 账号登录（推荐）`;
    }
    if (!oauthMode) return;
    const signedIn = isEdit && existing.auth === 'oauth2';
    const valid = signedIn && existing.hasToken && !(state.status[existing.id] || {}).reauth;
    content.querySelector('.oauth-state').innerHTML = signedIn
      ? `<span class="state-dot ${valid ? 'success' : 'danger'}"></span><span>${valid ? `已通过 ${oauthName()} 授权` : '授权已失效，请重新登录'}</span>`
      : '';
    oauthBtn.className = `btn oauth-btn ${isEdit ? '' : 'btn-primary'}`;
    if (!waiting) oauthBtn.innerHTML = `${icon('shield', 15)}${signedIn ? `重新登录 ${oauthName()}` : `使用 ${oauthName()} 账号登录`}`;
    content.querySelector('.oauth-note').textContent = `会在浏览器里打开 ${oauthName()} 的登录页，授权后自动回到汇邮。不需要应用专用密码，密码也不会经过汇邮。`;
    checkConfigured();
  };

  const checkConfigured = async () => {
    const st = await api.oauth.status();
    const s = st[oauthOf()];
    const warn = content.querySelector('.oauth-warn');
    warn.classList.toggle('hidden', !s || s.configured);
    content.querySelector('.oauth-warn-text').textContent = `还没有配置 ${oauthName()} OAuth 客户端（一次性设置，约 5 分钟）`;
    return s && s.configured;
  };

  switchBtn.onclick = () => {
    mode = mode === 'oauth' ? 'password' : 'oauth';
    showError('');
    renderMode();
  };
  content.querySelector('[data-a=oauth-setup]').onclick = async () => {
    const { openSettings } = await import('./settings.js');
    openSettings('signin');
  };
  cancelBtn.onclick = () => api.oauth.cancel();

  const setWaiting = (text) => {
    waiting = !!text;
    oauthBtn.disabled = waiting;
    cancelBtn.classList.toggle('hidden', !waiting);
    if (waiting) oauthBtn.innerHTML = `${oauthBtn.classList.contains('btn-primary') ? SPIN : '<span class="mini-spin"></span>'}${text}`;
    else renderMode();
  };

  oauthBtn.onclick = async () => {
    showError('');
    if (!(await checkConfigured())) return showError(`请先点“去设置”填写 ${oauthName()} 的 OAuth 客户端 ID`);
    read();
    setWaiting('请在浏览器中完成登录…');
    try {
      const t = await api.oauth.start({ provider: oauthOf(), loginHint: acc.email || undefined });
      const email = t.email.toLowerCase();
      if (isEdit && email !== existing.email.toLowerCase()) throw new Error(`你登录的是 ${t.email}，和这个账户（${existing.email}）不是同一个`);
      if (!isEdit && state.accounts.some((a) => a.email.toLowerCase() === email)) throw new Error(`${t.email} 已经添加过了`);
      acc.email = t.email;
      f('email').value = t.email;
      if (!acc.name && t.name) f('name').value = acc.name = t.name;
      setWaiting('正在连接邮箱…');
      await api.accounts.test({ account: acc, oauthTicket: t.ticket });
      const { hasPassword, hasToken, ...clean } = acc;
      await api.accounts.save({ account: clean, oauthTicket: t.ticket });
      waiting = false;
      await finish();
    } catch (err) {
      setWaiting('');
      if (!/已取消登录/.test(err.message)) showError(err.message);
    }
  };

  const finish = async () => {
    await loadAccounts();
    refreshUnread();
    toast(isEdit ? '已保存' : `已添加 ${acc.email}，正在收信…`, 'success', 3000);
    m.close();
  };

  // ---------- 服务商 ----------
  const applyProvider = (id, guess) => {
    acc.provider = id;
    const p = providers[id];
    if (!p) return renderMode();
    content.querySelectorAll('.prov').forEach((b) => b.classList.toggle('active', b.dataset.p === id));
    if (!isEdit) {
      const servers = id === 'custom' && guess ? guess : p;
      acc.imap = { ...servers.imap };
      acc.smtp = { ...servers.smtp };
      acc.saveSent = p.saveSent;
      if (id === 'custom') content.querySelector('.adv').open = true;
      mode = p.oauth ? 'oauth' : 'password';
    }
    content.querySelector('[data-l=pass]').textContent = p.passwordLabel;
    f('password').placeholder = isEdit ? '不修改请留空' : `${p.name}的${p.passwordLabel}`;
    helpBox.querySelector('.help-title').innerHTML = `${icon('info', 15)}<span>${escapeHtml(p.name)}需要“${escapeHtml(p.passwordLabel)}”</span>`;
    helpBox.querySelector('.help-text').textContent = p.help;
    const link = helpBox.querySelector('.help-link');
    link.classList.toggle('hidden', !p.helpUrl);
    link.onclick = () => api.app.openExternal(p.helpUrl);
    const keep = { email: f('email').value, password: f('password').value, name: f('name').value, label: f('label').value };
    fill();
    Object.entries(keep).forEach(([k, v]) => f(k) && (f(k).value = v));
    renderMode();
  };

  fill();
  if (acc.provider) applyProvider(acc.provider);
  else renderMode();
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

  footer.querySelector('[data-a=cancel]').onclick = () => m.close();
  ok.onclick = async () => {
    read();
    const password = mode === 'password' ? f('password').value : '';
    // 编辑时从 OAuth 改成密码，必须填新密码
    const needPassword = mode === 'password' && (!isEdit || existing.auth === 'oauth2');
    if (!/^[^\s@]+@[^\s@]+$/.test(acc.email)) return showError('请填写正确的邮箱地址');
    if (needPassword && !password) return showError('请填写密码或授权码');
    if (!acc.imap.host || !acc.smtp.host) {
      content.querySelector('.adv').open = true;
      return showError('请填写收信和发信服务器');
    }
    if (!isEdit && state.accounts.some((a) => a.email.toLowerCase() === acc.email.toLowerCase())) return showError('这个邮箱已经添加过了');
    showError('');
    ok.disabled = true;
    ok.innerHTML = `${SPIN}正在连接…`;
    const serverChanged = !isEdit || password || ['imap', 'smtp', 'username', 'allowInsecure'].some((k) => JSON.stringify(acc[k]) !== JSON.stringify(existing[k]));
    try {
      if (serverChanged) await api.accounts.test({ account: acc, password });
      const { hasPassword, hasToken, ...clean } = acc;
      await api.accounts.save({ account: clean, password });
      await finish();
    } catch (err) {
      showError(err.message);
      ok.disabled = false;
      ok.textContent = isEdit ? '保存' : '连接并添加';
    }
  };
  content.addEventListener('keydown', (e) => {
    if (e.key !== 'Enter' || e.target.tagName !== 'INPUT') return;
    if (mode === 'oauth' && !isEdit) oauthBtn.click();
    else ok.click();
  });
  setTimeout(() => (isEdit ? f('name') : f('email')).focus(), 50);
}
