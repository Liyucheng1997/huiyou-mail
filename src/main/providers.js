// 常见邮箱服务商的 IMAP / SMTP 预设，以及如何拿到“授权码 / 应用专用密码”的说明。
const PROVIDERS = {
  gmail: {
    name: 'Gmail',
    domains: ['gmail.com', 'googlemail.com'],
    imap: { host: 'imap.gmail.com', port: 993, secure: true },
    smtp: { host: 'smtp.gmail.com', port: 465, secure: true },
    saveSent: false, // Gmail 发信后会自动存进“已发送”
    oauth: 'google',
    passwordLabel: '应用专用密码',
    help: '先在 Google 账号里开启“两步验证”，再到“应用专用密码”页面生成一个 16 位密码，粘贴到这里（不是你的 Google 登录密码）。',
    helpUrl: 'https://myaccount.google.com/apppasswords',
  },
  qq: {
    name: 'QQ 邮箱',
    domains: ['qq.com', 'vip.qq.com', 'foxmail.com'],
    imap: { host: 'imap.qq.com', port: 993, secure: true },
    smtp: { host: 'smtp.qq.com', port: 465, secure: true },
    saveSent: true,
    passwordLabel: '授权码',
    help: '网页版 QQ 邮箱 → 设置 → 账号与安全 → 开启 IMAP/SMTP 服务，按提示生成授权码。',
    helpUrl: 'https://wx.mail.qq.com/',
  },
  exmail: {
    name: '腾讯企业邮',
    domains: [],
    imap: { host: 'imap.exmail.qq.com', port: 993, secure: true },
    smtp: { host: 'smtp.exmail.qq.com', port: 465, secure: true },
    saveSent: true,
    passwordLabel: '客户端专用密码',
    help: '企业邮 → 设置 → 账户 → 开启安全登录后生成客户端专用密码；未开启安全登录时直接填登录密码。',
    helpUrl: 'https://exmail.qq.com/',
  },
  netease163: {
    name: '网易 163 邮箱',
    domains: ['163.com'],
    imap: { host: 'imap.163.com', port: 993, secure: true },
    smtp: { host: 'smtp.163.com', port: 465, secure: true },
    saveSent: true,
    passwordLabel: '授权码',
    help: '网页版 163 邮箱 → 设置 → POP3/SMTP/IMAP → 开启 IMAP/SMTP 服务，生成授权码。',
    helpUrl: 'https://mail.163.com/',
  },
  netease126: {
    name: '网易 126 邮箱',
    domains: ['126.com'],
    imap: { host: 'imap.126.com', port: 993, secure: true },
    smtp: { host: 'smtp.126.com', port: 465, secure: true },
    saveSent: true,
    passwordLabel: '授权码',
    help: '网页版 126 邮箱 → 设置 → POP3/SMTP/IMAP → 开启 IMAP/SMTP 服务，生成授权码。',
    helpUrl: 'https://mail.126.com/',
  },
  yeah: {
    name: '网易 Yeah 邮箱',
    domains: ['yeah.net'],
    imap: { host: 'imap.yeah.net', port: 993, secure: true },
    smtp: { host: 'smtp.yeah.net', port: 465, secure: true },
    saveSent: true,
    passwordLabel: '授权码',
    help: '网页版邮箱 → 设置 → POP3/SMTP/IMAP → 开启 IMAP/SMTP 服务，生成授权码。',
    helpUrl: 'https://mail.yeah.net/',
  },
  sina: {
    name: '新浪邮箱',
    domains: ['sina.com', 'sina.cn', 'vip.sina.com'],
    imap: { host: 'imap.sina.com', port: 993, secure: true },
    smtp: { host: 'smtp.sina.com', port: 465, secure: true },
    saveSent: true,
    passwordLabel: '授权码',
    help: '新浪邮箱 → 设置 → 客户端 POP/IMAP/SMTP → 开启 IMAP4 服务，生成授权码。',
    helpUrl: 'https://mail.sina.com.cn/',
  },
  aliyun: {
    name: '阿里邮箱',
    domains: ['aliyun.com'],
    imap: { host: 'imap.aliyun.com', port: 993, secure: true },
    smtp: { host: 'smtp.aliyun.com', port: 465, secure: true },
    saveSent: true,
    passwordLabel: '密码',
    help: '阿里邮箱 → 设置 → 账户与安全 → 开启 IMAP/SMTP 服务。',
    helpUrl: 'https://mail.aliyun.com/',
  },
  icloud: {
    name: 'iCloud 邮箱',
    domains: ['icloud.com', 'me.com', 'mac.com'],
    imap: { host: 'imap.mail.me.com', port: 993, secure: true },
    smtp: { host: 'smtp.mail.me.com', port: 587, secure: false },
    saveSent: true,
    passwordLabel: 'App 专用密码',
    help: '登录 account.apple.com → 登录与安全 → App 专用密码，生成一个密码填在这里。',
    helpUrl: 'https://account.apple.com/',
  },
  yahoo: {
    name: 'Yahoo 邮箱',
    domains: ['yahoo.com', 'yahoo.co.jp', 'ymail.com'],
    imap: { host: 'imap.mail.yahoo.com', port: 993, secure: true },
    smtp: { host: 'smtp.mail.yahoo.com', port: 465, secure: true },
    saveSent: true,
    passwordLabel: '应用密码',
    help: 'Yahoo 账户安全 → 生成应用密码，填在这里。',
    helpUrl: 'https://login.yahoo.com/account/security',
  },
  outlook: {
    name: 'Outlook / Hotmail',
    domains: ['outlook.com', 'hotmail.com', 'live.com', 'msn.com'],
    imap: { host: 'outlook.office365.com', port: 993, secure: true },
    smtp: { host: 'smtp-mail.outlook.com', port: 587, secure: false },
    saveSent: false,
    oauth: 'microsoft',
    passwordLabel: '密码',
    help: '微软已关闭 Outlook / Hotmail 个人账户的密码登录，请用上面的“使用 Microsoft 账号登录”。工作或学校账户如果管理员仍允许密码登录，也可以填密码。',
    helpUrl: 'https://outlook.live.com/',
  },
  custom: {
    name: '其他邮箱（IMAP）',
    domains: [],
    imap: { host: '', port: 993, secure: true },
    smtp: { host: '', port: 465, secure: true },
    saveSent: true,
    passwordLabel: '密码 / 授权码',
    help: '填写你的邮箱服务商提供的 IMAP 和 SMTP 服务器地址。大多数国内邮箱需要先在网页版开启 IMAP 并使用授权码。',
    helpUrl: '',
  },
};

function detect(email) {
  const domain = String(email || '').split('@')[1]?.toLowerCase().trim() || '';
  for (const [id, p] of Object.entries(PROVIDERS)) if (p.domains.includes(domain)) return id;
  return domain ? 'custom' : null;
}

// 自定义域名的猜测：imap.<domain> / smtp.<domain>
function guess(email) {
  const domain = String(email || '').split('@')[1]?.toLowerCase().trim() || '';
  return {
    imap: { host: domain ? `imap.${domain}` : '', port: 993, secure: true },
    smtp: { host: domain ? `smtp.${domain}` : '', port: 465, secure: true },
  };
}

module.exports = { PROVIDERS, detect, guess };
