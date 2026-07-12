import { spawn } from "node:child_process";
import path from "node:path";

const isWindows = process.platform === "win32";
const viteBin = path.join(process.cwd(), "node_modules", "vite", "bin", "vite.js");
const electronCli = path.join(process.cwd(), "node_modules", "electron", "cli.js");

function run(command, args, options = {}) {
  return spawn(command, args, {
    stdio: options.stdio || "inherit",
    shell: false,
    ...options,
  });
}

async function isServerReady(url) {
  try {
    const response = await fetch(url);
    return response.ok;
  } catch {
    return false;
  }
}

function waitForServer(url, timeoutMs = 30000) {
  const started = Date.now();
  return new Promise((resolve, reject) => {
    async function check() {
      if (await isServerReady(url)) {
        resolve();
        return;
      }

      if (Date.now() - started > timeoutMs) {
        reject(new Error("Vite dev server startup timed out."));
        return;
      }
      setTimeout(check, 350);
    }
    check();
  });
}

const url = "http://127.0.0.1:5173";
const hasExistingServer = await isServerReady(url);
const vite = hasExistingServer ? null : run(process.execPath, [viteBin, "--host", "127.0.0.1"]);

try {
  await waitForServer(url);
  const electron = run(process.execPath, [electronCli, "."], { env: { ...process.env, NODE_ENV: "development" } });
  electron.on("exit", (code) => {
    if (vite) vite.kill();
    process.exit(code ?? 0);
  });
} catch (error) {
  if (vite) vite.kill();
  console.error(error.message);
  process.exit(1);
}
