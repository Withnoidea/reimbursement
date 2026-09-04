import { build } from "esbuild";
import { mkdir } from "node:fs/promises";
import path from "node:path";

const root = process.cwd();
const outFile = path.join(root, "electron", "vendor", "updater-deps.cjs");

await mkdir(path.dirname(outFile), { recursive: true });

// 打包后的应用不带 node_modules（package.json build.files 的 "!node_modules/**"），
// 主进程用到的 electron-updater 预打包成单文件，随 electron/ 目录一起分发。
await build({
  stdin: {
    contents: `
      const { autoUpdater } = require("electron-updater");
      module.exports = { autoUpdater };
    `,
    resolveDir: root,
    loader: "js",
    sourcefile: "updater-deps-entry.js",
  },
  bundle: true,
  platform: "node",
  target: "node20",
  format: "cjs",
  outfile: outFile,
  external: ["electron"],
  minify: true,
  logLevel: "warning",
});

console.log("Updater deps bundled to electron/vendor/updater-deps.cjs");
