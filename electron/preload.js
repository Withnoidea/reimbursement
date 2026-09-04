import { contextBridge, ipcRenderer, webUtils } from "electron";

contextBridge.exposeInMainWorld("desktopApi", {
  getPathForFile(file) {
    return webUtils.getPathForFile(file);
  },
  parsePdf(filePath) {
    return ipcRenderer.invoke("parse-pdf-native", filePath);
  },
  parsePdfData(data, fileName) {
    return ipcRenderer.invoke("parse-pdf-data", data, fileName);
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
  updaterVersion() {
    return ipcRenderer.invoke("updater-version");
  },
  updaterCheck() {
    return ipcRenderer.invoke("updater-check");
  },
  updaterInstall() {
    return ipcRenderer.invoke("updater-install");
  },
  updaterSettingsLoad() {
    return ipcRenderer.invoke("updater-settings-load");
  },
  updaterSettingsSave(settings) {
    return ipcRenderer.invoke("updater-settings-save", settings);
  },
  onUpdaterState(callback) {
    const listener = (_event, state) => callback(state);
    ipcRenderer.on("updater-state", listener);
    return () => ipcRenderer.removeListener("updater-state", listener);
  },
});
