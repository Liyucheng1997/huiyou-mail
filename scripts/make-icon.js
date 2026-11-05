// 生成应用图标：用 Electron 把 SVG 渲染成 PNG，再打包成多尺寸 ICO。
// 运行：npx electron scripts/make-icon.js
const { app, BrowserWindow } = require('electron');
const fs = require('fs');
const path = require('path');

const svg = (size) => `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 512 512">
  <rect x="16" y="16" width="480" height="480" rx="108" fill="#0071e3"/>
  <g fill="none" stroke="#fff" stroke-width="30" stroke-linecap="round" stroke-linejoin="round">
    <rect x="104" y="148" width="304" height="216" rx="40"/>
    <path d="M118 176 L230 262 a40 40 0 0 0 52 0 L394 176"/>
  </g>
</svg>`;

app.whenReady().then(async () => {
  // 透明窗口 + 透明背景，圆角外面才是透明的（否则截图会带白底）
  const win = new BrowserWindow({ show: false, width: 600, height: 600, frame: false, transparent: true, backgroundColor: '#00000000', webPreferences: { offscreen: true } });
  const out = path.join(__dirname, '..', 'build');
  fs.mkdirSync(out, { recursive: true });
  const sizes = [16, 24, 32, 48, 64, 128, 256, 512];
  const pngs = {};
  for (const s of sizes) {
    const html = `<html><body style="margin:0;background:transparent">${svg(s)}</body></html>`;
    await win.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(html));
    await new Promise((r) => setTimeout(r, 150));
    const img = await win.webContents.capturePage({ x: 0, y: 0, width: s, height: s });
    pngs[s] = img.resize({ width: s, height: s, quality: 'best' }).toPNG();
  }
  fs.writeFileSync(path.join(out, 'icon.png'), pngs[512]);
  // ICO：头 + 目录 + PNG 数据（Vista 起支持内嵌 PNG）
  const list = [16, 24, 32, 48, 64, 128, 256];
  const header = Buffer.alloc(6);
  header.writeUInt16LE(0, 0);
  header.writeUInt16LE(1, 2);
  header.writeUInt16LE(list.length, 4);
  const dir = Buffer.alloc(16 * list.length);
  let offset = 6 + dir.length;
  list.forEach((s, i) => {
    const d = pngs[s];
    dir.writeUInt8(s >= 256 ? 0 : s, i * 16);
    dir.writeUInt8(s >= 256 ? 0 : s, i * 16 + 1);
    dir.writeUInt8(0, i * 16 + 2);
    dir.writeUInt8(0, i * 16 + 3);
    dir.writeUInt16LE(1, i * 16 + 4);
    dir.writeUInt16LE(32, i * 16 + 6);
    dir.writeUInt32LE(d.length, i * 16 + 8);
    dir.writeUInt32LE(offset, i * 16 + 12);
    offset += d.length;
  });
  fs.writeFileSync(path.join(out, 'icon.ico'), Buffer.concat([header, dir, ...list.map((s) => pngs[s])]));
  console.log('icon written');
  app.quit();
});
