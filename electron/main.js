import { app, BrowserWindow, Menu, dialog, ipcMain, shell } from "electron";
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadMailConfigSummary, saveMailConfig, syncMailbox, testMailConnection } from "./mailSync.js";
import {
  checkForUpdatesManual,
  getCurrentVersion,
  initUpdater,
  installUpdate,
  loadUpdaterSettings,
  saveUpdaterSettings,
} from "./updater.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const appRoot = getAppRoot();
const isDev = !app.isPackaged;

async function createWindow() {
  // 打包后 exe 自带图标，窗口会继承；这里显式指定是为了让 npm run start 的开发窗口
  // 也用上应用图标，而不是 Electron 默认图标。
  const iconPath = path.join(__dirname, "..", "icon.ico");

  const win = new BrowserWindow({
    width: 1280,
    height: 800,
    minWidth: 1080,
    minHeight: 680,
    title: "报销单据管理",
    backgroundColor: "#f7f8fb",
    ...(existsSync(iconPath) ? { icon: iconPath } : {}),
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  });

  win.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url);
    return { action: "deny" };
  });

  if (isDev) {
    await win.loadURL("http://127.0.0.1:5173");
    win.webContents.openDevTools({ mode: "detach" });
  } else {
    await win.loadFile(path.join(__dirname, "../dist/index.html"));
  }

  win.setTitle("报销单据管理");
  setupApplicationMenu(win);
}

app.whenReady().then(createWindow);

app.whenReady().then(() => {
  initUpdater(() => BrowserWindow.getAllWindows()[0]);
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});

app.on("activate", () => {
  if (BrowserWindow.getAllWindows().length === 0) createWindow();
});

ipcMain.handle("parse-pdf-native", async (_event, filePath) => {
  return parsePdfWithPython(filePath);
});

ipcMain.handle("parse-pdf-data", async (_event, data, fileName = "document.pdf") => {
  let tempRoot = "";
  try {
    tempRoot = await mkdtemp(path.join(os.tmpdir(), "reimb-reparse-"));
    const safeName = sanitizeFileName(fileName);
    const tempPath = path.join(tempRoot, safeName);
    await writeFile(tempPath, Buffer.from(data));
    return await parsePdfWithPython(tempPath);
  } finally {
    if (tempRoot) await rm(tempRoot, { recursive: true, force: true }).catch(() => {});
  }
});

ipcMain.handle("mail-config-load", () => loadMailConfigSummary());

ipcMain.handle("mail-config-save", (_event, config) => saveMailConfig(config));

ipcMain.handle("mail-test", (_event, overrides) => testMailConnection(overrides || {}));

ipcMain.handle("mail-sync", (event, payload) => {
  return syncMailbox({
    state: payload?.state || null,
    range: payload?.range || null,
    parsePdfFile: parsePdfWithPython,
    onProgress: (text) => {
      if (!event.sender.isDestroyed()) event.sender.send("mail-sync-progress", text);
    },
  });
});

ipcMain.handle("updater-check", () => checkForUpdatesManual());

ipcMain.handle("updater-install", () => installUpdate());

ipcMain.handle("updater-settings-load", () => loadUpdaterSettings());

ipcMain.handle("updater-settings-save", (_event, settings) => saveUpdaterSettings(settings || {}));

ipcMain.handle("updater-version", () => getCurrentVersion());

function parsePdfWithPython(filePath) {
  return new Promise((resolve, reject) => {
    let python;
    try {
      python = resolvePythonExecutable();
    } catch (error) {
      reject(error);
      return;
    }

    const script = path.join(appRoot, "tools", "parse_pdf.py");
    const child = spawn(python, [script, filePath], {
      cwd: appRoot,
      env: pythonEnv(),
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";

    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.on("error", reject);
    child.on("close", (code) => {
      if (code !== 0) {
        reject(new Error(stderr || `Python parser exited with code ${code}`));
        return;
      }
      try {
        resolve(JSON.parse(stdout));
      } catch (error) {
        reject(error);
      }
    });
  });
}

function sanitizeFileName(name) {
  const cleaned = String(name || "")
    .replace(/[\x00-\x1f\\/:*?"<>|]/g, "_")
    .trim();
  return cleaned && /\.(pdf|png|jpe?g)$/i.test(cleaned) ? cleaned : "document.pdf";
}

// 优先使用随应用分发的自包含运行时（由 scripts/prepare-python-runtime.mjs 构建）。
// 打包到别的电脑后只有它可用；.venv 只是开发机上的调试兜底。
function resolvePythonExecutable() {
  const candidates = process.platform === "win32"
    ? [
      path.join(appRoot, "tools", "runtime", "python", "python.exe"),
      path.join(appRoot, ".venv", "Scripts", "python.exe"),
    ]
    : [path.join(appRoot, ".venv", "bin", "python")];

  const found = candidates.find((candidate) => existsSync(candidate));
  if (found) return found;

  throw new Error("找不到内置的识别环境，请重新安装应用（开发环境请运行 npm run prepare:runtime）");
}

function pythonEnv() {
  // 内嵌解释器的模块搜索路径由 python*._pth 接管，
  // 设置 PYTHONHOME/PYTHONPATH 反而会破坏它，这里显式清掉外部环境里可能存在的值。
  const env = { ...process.env, PYTHONIOENCODING: "utf-8", PYTHONUTF8: "1" };
  delete env.PYTHONHOME;
  delete env.PYTHONPATH;
  return env;
}

function getAppRoot() {
  if (!app.isPackaged) return path.join(__dirname, "..");

  const candidates = [
    process.resourcesPath,
    path.join(process.resourcesPath, "app"),
    path.join(process.resourcesPath, "app.asar.unpacked"),
  ];

  return candidates.find((candidate) => existsSync(path.join(candidate, "tools", "parse_pdf.py"))) || process.resourcesPath;
}

function setupApplicationMenu(win) {
  const sendAction = (action) => {
    if (!win.isDestroyed()) win.webContents.send("menu-action", action);
  };

  const template = [
    {
      label: "文件",
      submenu: [
        {
          label: "新建报销",
          accelerator: "CmdOrCtrl+N",
          click: () => sendAction("new-reimbursement"),
        },
        {
          label: "偏好设置",
          accelerator: "CmdOrCtrl+,",
          click: () => sendAction("open-preferences"),
        },
        { type: "separator" },
        {
          label: process.platform === "darwin" ? "关闭窗口" : "退出",
          accelerator: process.platform === "darwin" ? "CmdOrCtrl+W" : "Alt+F4",
          role: process.platform === "darwin" ? "close" : "quit",
        },
      ],
    },
    {
      label: "编辑",
      submenu: [
        { label: "撤销", accelerator: "CmdOrCtrl+Z", role: "undo" },
        { label: "重做", accelerator: "Shift+CmdOrCtrl+Z", role: "redo" },
        { type: "separator" },
        { label: "剪切", accelerator: "CmdOrCtrl+X", role: "cut" },
        { label: "复制", accelerator: "CmdOrCtrl+C", role: "copy" },
        { label: "粘贴", accelerator: "CmdOrCtrl+V", role: "paste" },
        { label: "全选", accelerator: "CmdOrCtrl+A", role: "selectAll" },
      ],
    },
    {
      label: "视图",
      submenu: [
        { label: "重新加载", accelerator: "CmdOrCtrl+R", role: "reload" },
        { label: "强制重新加载", accelerator: "Shift+CmdOrCtrl+R", role: "forceReload" },
        { label: "开发者工具", accelerator: "F12", role: "toggleDevTools" },
        { type: "separator" },
        { label: "实际大小", accelerator: "CmdOrCtrl+0", role: "resetZoom" },
        { label: "放大", accelerator: "CmdOrCtrl+=", role: "zoomIn" },
        { label: "缩小", accelerator: "CmdOrCtrl+-", role: "zoomOut" },
        { type: "separator" },
        { label: "全屏", accelerator: "F11", role: "togglefullscreen" },
      ],
    },
    {
      label: "窗口",
      submenu: [
        { label: "最小化", accelerator: "CmdOrCtrl+M", role: "minimize" },
        { label: "关闭", accelerator: "CmdOrCtrl+W", role: "close" },
      ],
    },
    {
      label: "帮助",
      submenu: [
        {
          label: "检查更新",
          click: () => {
            sendAction("check-updates");
          },
        },
        {
          label: "关于报销单据管理",
          click: () => {
            dialog.showMessageBox(win, {
              type: "info",
              title: "关于报销单据管理",
              message: "报销单据管理",
              detail: `本地桌面工作台，用于整理、预览、合并和导出报销 PDF 单据。\n当前版本 ${app.getVersion()}`,
              buttons: ["确定"],
            });
          },
        },
      ],
    },
  ];

  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}
