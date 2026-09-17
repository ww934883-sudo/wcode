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
  searchSessions: (keyword) => ipcRenderer.invoke("wcode:search", keyword),
  send: (sessionId, text) => ipcRenderer.invoke("wcode:send", sessionId, text),
  abort: (sessionId) => ipcRenderer.invoke("wcode:abort", sessionId),
  decide: (sessionId, askId, decision) =>
    ipcRenderer.invoke("wcode:decide", sessionId, askId, decision),
  listModels: () => ipcRenderer.invoke("wcode:listModels"),
  setModel: (model) => ipcRenderer.invoke("wcode:setModel", model),
  setContextTokens: (tokens) => ipcRenderer.invoke("wcode:setContextTokens", tokens),
  setPermissionMode: (mode) => ipcRenderer.invoke("wcode:setPermissionMode", mode),
  setThinkingLevel: (level) => ipcRenderer.invoke("wcode:setThinkingLevel", level),
  setPersona: (name) => ipcRenderer.invoke("wcode:setPersona", name),
  pickFolder: () => ipcRenderer.invoke("wcode:pickFolder"),
  saveProviderKey: (name, key) => ipcRenderer.invoke("wcode:saveProviderKey", name, key),
  setActiveProvider: (name) => ipcRenderer.invoke("wcode:setActiveProvider", name),
  setMcpEnabled: (name, enabled) => ipcRenderer.invoke("wcode:setMcpEnabled", name, enabled),
  onEvent: (cb) => sub("wcode:event", (p) => cb(p.sessionId, p.event)),
  onPermission: (cb) => sub("wcode:permission", cb),
  onInfo: (cb) => sub("wcode:info", cb),
});
