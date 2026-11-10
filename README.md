# 汇邮 Huiyou Mail

把 Gmail、QQ 邮箱、网易 163/126、iCloud、Yahoo 以及任何支持 IMAP 的邮箱汇到一个窗口里。不用再每天挨个登录网页版。

## 功能

- **全部收件箱**：所有邮箱的新邮件按时间汇总，左下角小方块标明来自哪个邮箱；另有“未读”“星标”智能邮箱
- **每个邮箱的完整文件夹**：收件箱、草稿箱、已发送、归档、垃圾邮件、已删除，以及自建文件夹；可以把邮件拖到文件夹里
- **会话视图**：打开一封邮件，下面按时间列出同一个对话里的往来邮件，包括你自己的回复（Gmail 按对话编号，其他邮箱按回复关系）；已发送文件夹在后台自动同步
- **读信**：HTML 邮件在沙箱里显示，默认拦截远程图片（防追踪），一键显示；附件可直接打开或另存。带大附件的邮件先显示正文，附件点了才下载；新邮件的正文在后台提前下好，点开不用等
- **写信**：新邮件 / 回复 / 全部回复 / 转发 / 编辑草稿；联系人自动补全、简易排版、拖入附件、每个账户单独签名；提到“附件”却没加文件时会提醒
- **别名发信**：在账户设置里登记别名（例如学校的另一个地址），写信时可以选它；回复时原邮件发到哪个别名就自动用哪个，别名也不会被当成别人加进抄送
- **整理**：标为已读/未读、星标、归档、删除、移动、标为垃圾邮件，支持 Ctrl / Shift 多选
- **搜索**：输入即在本地过滤，回车在服务器上搜索（Gmail 支持 Gmail 搜索语法）
- **后台收信**：服务器推送（IDLE）+ 定时检查；新邮件系统通知，任务栏图标显示你离开期间新到的邮件数（切回汇邮就清零），关闭窗口后留在托盘
- **离线可读**：邮件列表和打开过的邮件缓存在本机
- **AI 助手**（Ctrl+J）：读邮件、总结未读、找出需要回复的邮件、清理广告、拉黑发件人、起草回复。由你电脑上的 Claude Code 驱动，用你自己的 Claude 订阅，模型 Claude Opus 5.5
- **AI 翻译**：打开英语、意大利语等外语邮件时，正文上方提示“翻译成中文”，一键翻译（工具栏翻译按钮或按 `T`）；译文缓存在本机，可在设置里开启自动翻译
- **黑名单**：右键邮件“拉黑”，或让 AI 帮你拉黑；之后这些发件人的新邮件自动进“已删除”
- **Gmail / Outlook 账号登录（OAuth）**：在浏览器里登录授权，不用应用专用密码；Outlook / Hotmail 个人账户只能这样登录
- 浅色 / 深色 / 跟随系统；密码和授权令牌用 Windows 系统加密（safeStorage）保存在本机，不上传任何地方

## 下载

到 [Releases](https://github.com/Liyucheng1997/huiyou-mail/releases) 下载：

- `Huiyou-Mail-Setup-x.y.z.exe`：**安装版（推荐）**，会在后台自动下载新版本，点“立即重启”即完成更新
- `Huiyou-Mail-x.y.z-portable.exe`：便携版，免安装；有新版本时只提示，需要手动下载

`latest.yml` 和 `.blockmap` 是自动更新用的文件，不需要下载。

安装包没有代码签名，Windows SmartScreen 可能拦截：点“更多信息 → 仍要运行”。

## 添加邮箱

### Gmail / Outlook：用账号登录（推荐）

选 Gmail 或 Outlook 后点“使用 Google / Microsoft 账号登录”，在浏览器里登录并授权，完成后自动回到汇邮。

这需要一个**你自己的 OAuth 客户端**（免费，创建一次即可）。在汇邮的“设置 → 登录方式”里有逐步说明，填好就能用：

**Google（Gmail）**

1. 打开 [Google Cloud 控制台](https://console.cloud.google.com/auth/clients)，新建一个项目（名字随意）
2. 进入“Google Auth Platform”，填写应用名称和邮箱，用户类型选“外部”
3. 在“目标对象”里点“发布应用”改成正式版，否则每 7 天要重新登录一次。登录时会看到“Google 尚未验证此应用”，点“高级 → 继续”即可（这是你自己的应用）
4. 在“客户端”里新建客户端，类型选“桌面应用”，把客户端 ID 和客户端密钥填到汇邮里

**Microsoft（Outlook / Hotmail / Microsoft 365）**

1. 打开 [Microsoft Entra 应用注册](https://entra.microsoft.com/#view/Microsoft_AAD_RegisteredApps/ApplicationsListBlade) → 新注册（需要一个免费的 Azure 账号）
2. “受支持的帐户类型”选“任何组织目录中的帐户和个人 Microsoft 帐户”
3. “重定向 URI”平台选“公共客户端/本机(移动和桌面)”，填 `http://localhost`
4. 把“应用程序(客户端) ID”填到汇邮里

登录用 PKCE + 本机回环地址（`127.0.0.1` / `localhost` 随机端口）接收授权，账号密码只在浏览器里输入，汇邮只保存加密后的 refresh token。

### 其他邮箱：要用“授权码”，不是登录密码

| 邮箱 | 需要填写 | 在哪里获取 |
| --- | --- | --- |
| Gmail（不用账号登录时） | 应用专用密码（16 位） | 先开启两步验证，再到 <https://myaccount.google.com/apppasswords> 生成 |
| QQ 邮箱 | 授权码 | 网页版 → 设置 → 账号与安全 → 开启 IMAP/SMTP 服务 |
| 网易 163 / 126 | 授权码 | 网页版 → 设置 → POP3/SMTP/IMAP → 开启 IMAP/SMTP 服务 |
| iCloud | App 专用密码 | account.apple.com → 登录与安全 → App 专用密码 |
| Yahoo | 应用密码 | 账户安全 → 生成应用密码 |
| 企业邮 / 自建邮箱 | 密码或客户端专用密码 | 选“其他邮箱”，在“服务器设置”里填写 IMAP / SMTP 地址 |

## AI 助手

点顶栏的“AI 助手”或按 `Ctrl+J` 打开，可以直接说：

- “总结一下今天的未读邮件”
- “找出广告和推广邮件，帮我清理掉”
- “最近有哪些邮件需要我回复？”
- “帮我回复张伟那封邮件，说我能参加”

**前提**：电脑上装了 [Claude Code](https://claude.com/claude-code)，并在终端运行过 `claude` 登录。汇邮会自动找到它（默认 `%USERPROFILE%\.local\bin\claude.exe`），找不到时可在“设置 → AI 助手”里指定路径。用量计入你的 Claude 订阅。

**安全**：
- 删除、归档、移动、标垃圾、拉黑之前，面板里会弹出确认卡片，列出涉及的邮件，你点确认才执行
- AI 只能起草邮件，由你检查后自己点发送
- AI 只有邮件相关的工具，不能读写电脑上的文件或运行命令；不会读取你 Claude Code 的 CLAUDE.md、插件和 MCP 配置
- 邮件内容被当作不可信数据：邮件里写给 AI 的“指令”不会被执行

## 快捷键

| 按键 | 作用 | 按键 | 作用 |
| --- | --- | --- | --- |
| `C` / `Ctrl+N` | 写邮件 | `R` / `A` / `F` | 回复 / 全部回复 / 转发 |
| `↑` `↓` / `J` `K` | 上一封 / 下一封 | `E` | 归档 |
| `Delete` | 删除 | `U` | 标为已读 / 未读 |
| `S` | 星标 | `/` | 搜索 |
| `F5` | 立即收信 | `Ctrl+Enter` | 发送 |
| `Ctrl+J` | 打开 / 关闭 AI 助手 | `T` | 翻译成中文 |

## 开发

```bash
npm install
npm start          # 运行
npm run dist       # 打包安装版 + 便携版到 dist/
```

想让打包出来的版本自带 OAuth 客户端（用户不用自己创建），把客户端 ID 填进 `src/main/oauth-clients.js`。开发时也可以用环境变量 `HUIYOU_GOOGLE_CLIENT_ID`、`HUIYOU_GOOGLE_CLIENT_SECRET`、`HUIYOU_MICROSOFT_CLIENT_ID`。

技术栈：Electron、[Claude Agent SDK](https://code.claude.com/docs/en/agent-sdk)（AI 助手）、[imapflow](https://github.com/postalsys/imapflow)（IMAP）、[nodemailer](https://nodemailer.com/)（SMTP）、[mailparser](https://github.com/nodemailer/mailparser)（解析邮件）。界面是原生 HTML/CSS/JS，没有前端框架。

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
