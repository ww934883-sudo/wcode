// 沙箱 preload：只暴露白名单动词 + 三条订阅通道，渲染层零 Node/Electron 能力
const { contextBridge, ipcRenderer } = require("electron");

const sub = (channel, cb) => {
  const l = (_e, payload) => cb(payload);
  ipcRenderer.on(channel, l);
  return () => ipcRenderer.removeListener(channel, l);
};

contextBridge.exposeInMainWorld("wcode", {
  info: () => ipcRenderer.invoke("wcode:info"),
  newSession: (cwd) => ipcRenderer.invoke("wcode:newSession", cwd),
  openSession: (cwd, sessionId) => ipcRenderer.invoke("wcode:openSession", cwd, sessionId),
  forkSession: (cwd, sessionId, keep) =>
    ipcRenderer.invoke("wcode:forkSession", cwd, sessionId, keep),
  rollbackSession: (cwd, sessionId, userTurn) =>
    ipcRenderer.invoke("wcode:rollbackSession", cwd, sessionId, userTurn),
  deleteSession: (cwd, sessionId) =>
    ipcRenderer.invoke("wcode:deleteSession", cwd, sessionId),
  setSessionPinned: (sessionId, pinned) =>
    ipcRenderer.invoke("wcode:setSessionPinned", sessionId, pinned),
  searchSessions: (keyword) => ipcRenderer.invoke("wcode:search", keyword),
  send: (sessionId, text) => ipcRenderer.invoke("wcode:send", sessionId, text),
  abort: (sessionId) => ipcRenderer.invoke("wcode:abort", sessionId),
  decide: (sessionId, askId, decision) =>
    ipcRenderer.invoke("wcode:decide", sessionId, askId, decision),
  listModels: () => ipcRenderer.invoke("wcode:listModels"),
  listModelCatalog: () => ipcRenderer.invoke("wcode:listModelCatalog"),
  addCatalogModel: (provider, model, contextLabel) =>
    ipcRenderer.invoke("wcode:addCatalogModel", provider, model, contextLabel),
  removeCatalogModel: (provider, model) =>
    ipcRenderer.invoke("wcode:removeCatalogModel", provider, model),
  updateCatalogModel: (provider, model, patch) =>
    ipcRenderer.invoke("wcode:updateCatalogModel", provider, model, patch),
  selectModel: (provider, model) =>
    ipcRenderer.invoke("wcode:selectModel", provider, model),
  addProvider: (name, opts) => ipcRenderer.invoke("wcode:addProvider", name, opts),
  removeProvider: (name) => ipcRenderer.invoke("wcode:removeProvider", name),
  updateProvider: (name, patch) => ipcRenderer.invoke("wcode:updateProvider", name, patch),
  renameProvider: (oldName, newName) =>
    ipcRenderer.invoke("wcode:renameProvider", oldName, newName),
  setProviderEnabled: (name, enabled) =>
    ipcRenderer.invoke("wcode:setProviderEnabled", name, enabled),
  testModel: (provider, model) => ipcRenderer.invoke("wcode:testModel", provider, model),
  setModel: (model) => ipcRenderer.invoke("wcode:setModel", model),
  setContextTokens: (tokens) => ipcRenderer.invoke("wcode:setContextTokens", tokens),
  setPermissionMode: (mode) => ipcRenderer.invoke("wcode:setPermissionMode", mode),
  setThinkingLevel: (level) => ipcRenderer.invoke("wcode:setThinkingLevel", level),
  setPersona: (name) => ipcRenderer.invoke("wcode:setPersona", name),
  pickFolder: () => ipcRenderer.invoke("wcode:pickFolder"),
  saveProviderKey: (name, key) => ipcRenderer.invoke("wcode:saveProviderKey", name, key),
  setActiveProvider: (name) => ipcRenderer.invoke("wcode:setActiveProvider", name),
  setMcpEnabled: (name, enabled) => ipcRenderer.invoke("wcode:setMcpEnabled", name, enabled),
  addMcpServer: (name, command, args, env) =>
    ipcRenderer.invoke("wcode:addMcpServer", name, command, args, env),
  removeMcpServer: (name) => ipcRenderer.invoke("wcode:removeMcpServer", name),
  listAutomations: () => ipcRenderer.invoke("wcode:listAutomations"),
  addAutomation: (spec) => ipcRenderer.invoke("wcode:addAutomation", spec),
  removeAutomation: (id) => ipcRenderer.invoke("wcode:removeAutomation", id),
  setAutomationEnabled: (id, enabled) =>
    ipcRenderer.invoke("wcode:setAutomationEnabled", id, enabled),
  runAutomation: (id) => ipcRenderer.invoke("wcode:runAutomation", id),
  listAutomationRuns: (id) => ipcRenderer.invoke("wcode:listAutomationRuns", id),
  onEvent: (cb) => sub("wcode:event", (p) => cb(p.sessionId, p.event)),
  onPermission: (cb) => sub("wcode:permission", cb),
  onInfo: (cb) => sub("wcode:info", cb),
});
