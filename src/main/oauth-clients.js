// 内置的 OAuth 客户端。留空时，用户需要在“设置 → 登录方式”里填自己创建的客户端 ID。
// 桌面应用的 client_secret 按 Google 的说明并不保密（会随安装包分发），PKCE 才是真正的保护。
module.exports = {
  google: { clientId: '', clientSecret: '' },
  microsoft: { clientId: '' },
};
