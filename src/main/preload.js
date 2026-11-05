// 预加载：通过 contextBridge 暴露受控 API（window.mail）。主进程返回 {ok, data | error}，这里拆开成 Promise。
const { contextBridge, ipcRenderer, webUtils } = require('electron');

const call = (ch) => async (...args) => {
  const res = await ipcRenderer.invoke(ch, ...args);
  if (res && typeof res === 'object' && 'ok' in res) {
    if (res.ok) return res.data;
    throw new Error(res.error);
  }
  return res;
};
const raw = (ch) => (...args) => ipcRenderer.invoke(ch, ...args);
const on = (ch) => (cb) => {
  const fn = (_e, payload) => cb(payload);
  ipcRenderer.on(ch, fn);
  return () => ipcRenderer.removeListener(ch, fn);
};

contextBridge.exposeInMainWorld('api', {
  pathForFile: (file) => {
    try {
      return webUtils.getPathForFile(file);
    } catch {
      return '';
    }
  },
  app: {
    info: call('app:info'),
    openExternal: call('app:open-external'),
    setTitleColors: call('app:set-title-colors'),
    setBadge: call('app:set-badge'),
    systemDark: call('app:system-dark'),
    onCommand: on('app:command'),
    onSystemTheme: on('theme:system-changed'),
  },
  settings: { get: call('settings:get'), set: call('settings:set') },
  state: { get: call('state:get'), set: call('state:set') },
  providers: { list: call('providers:list'), detect: call('providers:detect') },
  accounts: {
    list: call('accounts:list'),
    test: call('accounts:test'),
    save: call('accounts:save'),
    remove: call('accounts:remove'),
    reorder: call('accounts:reorder'),
  },
  oauth: { status: call('oauth:status'), start: call('oauth:start'), cancel: call('oauth:cancel') },
  ai: {
    status: call('ai:status'),
    send: call('ai:send'),
    interrupt: call('ai:interrupt'),
    reset: call('ai:reset'),
    approve: call('ai:approve'),
    resolve: call('ai:resolve'),
    onEvent: on('ai:event'),
    onDraft: on('ai:draft'),
    translate: call('ai:translate'),
    cancelTranslate: call('ai:translate-cancel'),
    translation: call('ai:translation'),
    onTranslate: on('ai:translate'),
  },
  blocklist: { list: call('blocklist:list'), add: call('blocklist:add'), remove: call('blocklist:remove'), onChange: on('ai:blocklist') },
  mail: {
    syncAll: call('mail:sync-all'),
    statusAll: call('mail:status-all'),
    folders: call('mail:folders'),
    refreshFolders: call('mail:refresh-folders'),
    sync: call('mail:sync'),
    loadOlder: call('mail:load-older'),
    messages: call('mail:messages'),
    unread: call('mail:unread'),
    read: call('mail:read'),
    thread: call('mail:thread'),
    flags: call('mail:flags'),
    move: call('mail:move'),
    remove: call('mail:delete'),
    archive: call('mail:archive'),
    spam: call('mail:spam'),
    search: call('mail:search'),
    createFolder: call('mail:create-folder'),
    contacts: call('mail:contacts'),
    send: call('mail:send'),
    saveDraft: call('mail:save-draft'),
    saveAttachment: call('mail:save-attachment'),
    openAttachment: call('mail:open-attachment'),
    pickFiles: call('mail:pick-files'),
    fileInfo: call('mail:file-info'),
    onChanged: on('mail:changed'),
    onStatus: on('mail:status'),
    onFolders: on('mail:folders'),
    onOpen: on('mail:open'),
  },
  cache: { size: call('cache:size'), clear: call('cache:clear') },
  update: {
    status: raw('update:status'),
    check: raw('update:check'),
    install: raw('update:install'),
    onStatus: on('update:status'),
  },
});
