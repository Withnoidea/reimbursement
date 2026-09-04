import { app } from "electron";
import { createRequire } from "node:module";
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

const require = createRequire(import.meta.url);

let depsCache = null;

// 与 mailSync.js 一致：打包后的应用不带 node_modules，优先用预打包的单文件依赖。
function loadDeps() {
  if (!depsCache) {
    try {
      depsCache = require("./vendor/updater-deps.cjs");
    } catch {
      depsCache = { autoUpdater: require("electron-updater").autoUpdater };
    }
  }
  return depsCache;
}

const DEFAULT_SETTINGS = { autoCheck: true };

let state = null;
let getWindow = () => null;

function settingsFilePath() {
  return path.join(app.getPath("userData"), "updater-settings.json");
}

export function loadUpdaterSettings() {
  try {
    const parsed = JSON.parse(readFileSync(settingsFilePath(), "utf8"));
    return { ...DEFAULT_SETTINGS, ...parsed };
  } catch {
    return { ...DEFAULT_SETTINGS };
  }
}

export function saveUpdaterSettings(settings) {
  const merged = { ...loadUpdaterSettings(), ...settings };
  try {
    writeFileSync(settingsFilePath(), JSON.stringify(merged, null, 2), "utf8");
  } catch {
    // 写失败不影响本次会话内的行为
  }
  return merged;
}

function publish(next) {
  state = { ...state, ...next };
  const win = getWindow();
  if (win && !win.isDestroyed()) win.webContents.send("updater-state", state);
}

export function initUpdater(getWindowFn) {
  getWindow = getWindowFn || getWindow;
  if (!app.isPackaged) return;

  const { autoUpdater } = loadDeps();
  autoUpdater.autoDownload = true;
  autoUpdater.autoInstallOnAppQuit = true;

  autoUpdater.on("checking-for-update", () => publish({ status: "checking" }));
  autoUpdater.on("update-available", (info) => publish({ status: "available", version: info?.version || "" }));
  autoUpdater.on("update-not-available", () => publish({ status: "none" }));
  autoUpdater.on("download-progress", (progress) => {
    publish({ status: "downloading", percent: Math.round(progress?.percent || 0) });
  });
  autoUpdater.on("update-downloaded", (info) => publish({ status: "downloaded", version: info?.version || "" }));
  autoUpdater.on("error", (error) => publish({ status: "error", message: String(error?.message || error) }));

  // 启动后延迟检查一次，避开启动期的网络与 CPU 高峰；失败静默。
  setTimeout(() => {
    if (loadUpdaterSettings().autoCheck === false) return;
    checkForUpdates().catch(() => {});
  }, 8000);
}

async function checkForUpdates() {
  const { autoUpdater } = loadDeps();
  publish({ status: "checking" });
  const result = await autoUpdater.checkForUpdates();
  return result?.updateInfo?.version || "";
}

export async function checkForUpdatesManual() {
  const { autoUpdater } = loadDeps();
  if (!app.isPackaged) {
    throw new Error("开发模式下不支持更新检查");
  }
  try {
    const version = await checkForUpdates();
    return { version, status: state?.status || "none" };
  } catch (error) {
    const message = String(error?.message || error);
    // 网络不可达等场景：把状态从 checking 归位，避免 UI 卡在检查中。
    publish({ status: "error", message });
    throw error;
  }
}

export function installUpdate() {
  if (!state || state.status !== "downloaded") return;
  const { autoUpdater } = loadDeps();
  autoUpdater.quitAndInstall();
}

export function getCurrentVersion() {
  return app.getVersion();
}
