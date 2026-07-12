import { build } from "esbuild";
import { mkdir } from "node:fs/promises";
import path from "node:path";

const root = process.cwd();
const outFile = path.join(root, "electron", "vendor", "mail-deps.cjs");

await mkdir(path.dirname(outFile), { recursive: true });

// 打包后的应用不带 node_modules（见 scripts/package-win-folder.mjs 的 ignore），
// 因此把主进程用到的邮件依赖预打包成单文件，随 electron/ 目录一起分发。
await build({
  stdin: {
    contents: `
      const { ImapFlow } = require("imapflow");
      const { simpleParser } = require("mailparser");
      const JSZip = require("jszip");
      module.exports = { ImapFlow, simpleParser, JSZip };
    `,
    resolveDir: root,
    loader: "js",
    sourcefile: "mail-deps-entry.js",
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

console.log("Mail sync deps bundled to electron/vendor/mail-deps.cjs");
