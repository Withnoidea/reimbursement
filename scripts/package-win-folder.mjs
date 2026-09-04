import { rm } from "node:fs/promises";
import { packager } from "@electron/packager";

const outputDir = process.env.PACKAGE_OUT || "packaged";

await rm(outputDir, { recursive: true, force: true });

await packager({
  dir: ".",
  name: "报销单据管理",
  platform: "win32",
  arch: "x64",
  out: outputDir,
  overwrite: true,
  asar: true,
  // exe 和任务栏图标。多尺寸 .ico 由 scripts/make-icon.py 从 icon.png 生成。
  icon: "icon.ico",
  // tools/ 里有内嵌 Python 解释器和一堆 DLL，它们无法从 asar 内部执行，必须是真实文件。
  // extraResource 是确定性复制，比依赖 asar unpackDir 的通配行为更可靠；
  // 复制后落在 resources/tools，正好是 electron/main.js getAppRoot() 的第一个候选目录。
  extraResource: ["tools"],
  prune: false,
  ignore: [
    /^\/\.git($|\/)/,
    /^\/\.claude($|\/)/,
    /^\/\.gitignore$/,
    /^\/\.venv($|\/)/,
    /^\/tools($|\/)/,
    /^\/HunyuanOCR-main($|\/)/,
    /^\/src($|\/)/,
    /^\/public($|\/)/,
    /^\/scripts($|\/)/,
    /^\/data($|\/)/,
    /^\/release($|\/)/,
    /^\/packaged($|\/)/,
    /^\/dist-electron($|\/)/,
    /^\/node_modules($|\/)/,
    /^\/pdf($|\/)/,
    /^\/.*\.pdf$/,
    /^\/[^/]+\.md$/,
    /^\/thoughts\.txt$/,
    /__pycache__($|\/)/,
    /\.pyc$/,
    /\.log$/,
    /^\/app\.py$/,
    /^\/start\.bat$/,
    /^\/requirements\.txt$/,
    /^\/package-lock\.json$/,
    // 图标源文件，只在构建时用来生成 icon.ico，不需要进包
    /^\/icon\.png$/,
  ],
});

console.log(`Wrote Windows app to ${outputDir}/报销单据管理-win32-x64`);
