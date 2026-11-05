// 主题：跟随系统 / 浅色 / 深色。只切换 <html data-theme>，并同步窗口按钮颜色。
import { state, api } from './state.js';
import { bus } from './util.js';

let systemDark = false;

export async function initTheme() {
  systemDark = await api.app.systemDark();
  api.app.onSystemTheme((dark) => {
    systemDark = dark;
    applyTheme();
  });
  applyTheme();
}

export function isDark() {
  const t = state.settings.theme;
  return t === 'dark' || (t !== 'light' && systemDark);
}

export function applyTheme() {
  const dark = isDark();
  document.documentElement.dataset.theme = dark ? 'dark' : 'light';
  api.app.setTitleColors(dark);
  bus.emit('theme', dark);
}

export async function toggleTheme() {
  state.settings = await api.settings.set({ theme: isDark() ? 'light' : 'dark' });
  applyTheme();
}
