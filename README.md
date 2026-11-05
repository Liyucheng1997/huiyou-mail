# 汇邮 Huiyou Mail

把 Gmail、QQ 邮箱、网易 163/126、iCloud、Yahoo 以及任何支持 IMAP 的邮箱汇到一个窗口里。不用再每天挨个登录网页版。

## 功能

- **全部收件箱**：所有邮箱的新邮件按时间汇总，左下角小方块标明来自哪个邮箱；另有“未读”“星标”智能邮箱
- **每个邮箱的完整文件夹**：收件箱、草稿箱、已发送、归档、垃圾邮件、已删除，以及自建文件夹；可以把邮件拖到文件夹里
- **读信**：HTML 邮件在沙箱里显示，默认拦截远程图片（防追踪），一键显示；附件可直接打开或另存
- **写信**：新邮件 / 回复 / 全部回复 / 转发 / 编辑草稿；联系人自动补全、简易排版、拖入附件、每个账户单独签名；提到“附件”却没加文件时会提醒
- **整理**：标为已读/未读、星标、归档、删除、移动、标为垃圾邮件，支持 Ctrl / Shift 多选
- **搜索**：输入即在本地过滤，回车在服务器上搜索（Gmail 支持 Gmail 搜索语法）
- **后台收信**：服务器推送（IDLE）+ 定时检查；新邮件系统通知，任务栏图标显示未读数，关闭窗口后留在托盘
- **离线可读**：邮件列表和打开过的邮件缓存在本机
- 浅色 / 深色 / 跟随系统；密码用 Windows 系统加密（safeStorage）保存在本机，不上传任何地方

## 下载

到 [Releases](https://github.com/Liyucheng1997/huiyou-mail/releases) 下载：

- `Huiyou-Mail-Setup-x.y.z.exe`：**安装版（推荐）**，会在后台自动下载新版本，点“立即重启”即完成更新
- `Huiyou-Mail-x.y.z-portable.exe`：便携版，免安装；有新版本时只提示，需要手动下载

`latest.yml` 和 `.blockmap` 是自动更新用的文件，不需要下载。

安装包没有代码签名，Windows SmartScreen 可能拦截：点“更多信息 → 仍要运行”。

## 添加邮箱：要用“授权码”，不是登录密码

| 邮箱 | 需要填写 | 在哪里获取 |
| --- | --- | --- |
| Gmail | 应用专用密码（16 位） | 先开启两步验证，再到 <https://myaccount.google.com/apppasswords> 生成 |
| QQ 邮箱 | 授权码 | 网页版 → 设置 → 账号与安全 → 开启 IMAP/SMTP 服务 |
| 网易 163 / 126 | 授权码 | 网页版 → 设置 → POP3/SMTP/IMAP → 开启 IMAP/SMTP 服务 |
| iCloud | App 专用密码 | account.apple.com → 登录与安全 → App 专用密码 |
| Yahoo | 应用密码 | 账户安全 → 生成应用密码 |
| 企业邮 / 自建邮箱 | 密码或客户端专用密码 | 选“其他邮箱”，在“服务器设置”里填写 IMAP / SMTP 地址 |

> Outlook / Hotmail 个人账户：微软已不允许用密码登录第三方客户端（只允许 OAuth），目前可能连不上。可以在 Outlook 网页版设置里把邮件自动转发到你的其他邮箱。

## 快捷键

| 按键 | 作用 | 按键 | 作用 |
| --- | --- | --- | --- |
| `C` / `Ctrl+N` | 写邮件 | `R` / `A` / `F` | 回复 / 全部回复 / 转发 |
| `↑` `↓` / `J` `K` | 上一封 / 下一封 | `E` | 归档 |
| `Delete` | 删除 | `U` | 标为已读 / 未读 |
| `S` | 星标 | `/` | 搜索 |
| `F5` | 立即收信 | `Ctrl+Enter` | 发送 |

## 开发

```bash
npm install
npm start          # 运行
npm run dist       # 打包安装版 + 便携版到 dist/
```

技术栈：Electron、[imapflow](https://github.com/postalsys/imapflow)（IMAP）、[nodemailer](https://nodemailer.com/)（SMTP）、[mailparser](https://github.com/nodemailer/mailparser)（解析邮件）。界面是原生 HTML/CSS/JS，没有前端框架。

### 发布新版本

1. 改 `package.json` 的 `version`
2. `npm run dist`
3. 提交、推送，然后把四个文件一起上传：

```bash
gh release create v1.0.1 dist/Huiyou-Mail-Setup-1.0.1.exe dist/Huiyou-Mail-Setup-1.0.1.exe.blockmap dist/Huiyou-Mail-1.0.1-portable.exe dist/latest.yml --title "汇邮 1.0.1" --notes-file notes.md
```

少了 `latest.yml`，已安装的客户端就检测不到更新。

## 许可

MIT
