import { contextBridge, ipcRenderer, webUtils } from "electron";

contextBridge.exposeInMainWorld("desktopApi", {
  getPathForFile(file) {
    return webUtils.getPathForFile(file);
  },
  parsePdf(filePath) {
    return ipcRenderer.invoke("parse-pdf-native", filePath);
  },
  loadMailConfig() {
    return ipcRenderer.invoke("mail-config-load");
  },
  saveMailConfig(config) {
    return ipcRenderer.invoke("mail-config-save", config);
  },
  testMailConnection(overrides) {
    return ipcRenderer.invoke("mail-test", overrides);
  },
  syncMailbox(payload) {
    return ipcRenderer.invoke("mail-sync", payload);
  },
  onMailSyncProgress(callback) {
    const listener = (_event, text) => callback(text);
    ipcRenderer.on("mail-sync-progress", listener);
    return () => ipcRenderer.removeListener("mail-sync-progress", listener);
  },
  onMenuAction(callback) {
    const listener = (_event, action) => callback(action);
    ipcRenderer.on("menu-action", listener);
    return () => ipcRenderer.removeListener("menu-action", listener);
  },
});
