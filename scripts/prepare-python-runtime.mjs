import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { copyFile, mkdir, mkdtemp, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import JSZip from "jszip";

// 构建一个自包含的 Python 运行时，随应用分发。
//
// 为什么需要：主进程调用 Python 做发票识别（见 electron/main.js 的 parsePdfWithPython）。
// 开发机的 .venv 依赖本机 Anaconda 的绝对路径，拷到别的电脑无法运行，打包产物里也没有它，
// 所以此前只有开发机能识别。这里改为下载官方 embeddable Python，用 pip --target 把依赖
// 装进去，再把 OCR 模型一并落盘，形成一个可以整体拷走的目录。
//
// 识别引擎：RapidOCR（onnxruntime，纯 CPU）。PDF 由 pypdfium2 负责抽文字层和渲染位图，
// 不使用 PyMuPDF（AGPL 协议，且 rapidocr_pdf 反向依赖它）。

const PYTHON_VERSION = "3.13.5";
const PYTHON_ZIP_URL = `https://www.python.org/ftp/python/${PYTHON_VERSION}/python-${PYTHON_VERSION}-embed-amd64.zip`;

// onnxruntime / opencv / numpy 是真正的 C 扩展，wheel 的 ABI 标签必须与内嵌解释器一致，
// 所以下面的 hostPython 版本校验不能省。
//
// omegaconf 必须显式约束下限：rapidocr 只写了 omegaconf!=2.2.1，而 omegaconf>=2.1 依赖
// antlr4-python3-runtime==4.9.*，后者在 PyPI 上只有源码包没有 wheel。一旦全局强制二进制安装，
// pip 会一路回退到 omegaconf 2.0.0，而 2.0.0 不支持 Path 类型，RapidOCR 初始化时会直接崩。
const PACKAGES = [
  "rapidocr==3.9.2",
  "onnxruntime",
  "pypdfium2",
  "opencv-python-headless",
  "omegaconf>=2.3.0",
];

// 只对含 C 扩展的包强制二进制安装。纯 Python 的包（antlr4、omegaconf 等）允许走源码，
// 否则依赖会被 pip 静默降级到不可用的旧版本。
const BINARY_ONLY = [
  "numpy",
  "onnxruntime",
  "opencv-python",
  "opencv-python-headless",
  "pypdfium2",
  "pyclipper",
  "shapely",
  "pillow",
];

// onnxruntime 和 opencv 依赖 MSVC 运行库。embeddable zip 只自带 vcruntime140.dll，
// 干净的 Windows 上缺 vcruntime140_1.dll 会直接 ImportError，所以随包携带。
// 应用本地部署这几个 DLL 属于微软 redistributable 许可允许的方式。
const VC_RUNTIME_DLLS = ["vcruntime140.dll", "vcruntime140_1.dll", "msvcp140.dll"];

const root = process.cwd();
const runtimeDir = path.join(root, "tools", "runtime");
const pythonDir = path.join(runtimeDir, "python");
const sitePackages = path.join(pythonDir, "Lib", "site-packages");
const markerFile = path.join(runtimeDir, ".runtime-ready.json");
const pythonExe = path.join(pythonDir, "python.exe");

const fingerprint = createHash("sha256")
  .update(JSON.stringify({ PYTHON_VERSION, PACKAGES, VC_RUNTIME_DLLS }))
  .digest("hex")
  .slice(0, 16);

if (process.platform !== "win32") {
  console.error("此脚本目前只支持 Windows（应用本身也只打 Windows 包）。");
  process.exit(1);
}

if (await isUpToDate()) {
  console.log(`Python 运行时已是最新（${PYTHON_VERSION}, ${fingerprint}），跳过构建。`);
  process.exit(0);
}

console.log("开始构建自包含 Python 运行时…");
await rm(runtimeDir, { recursive: true, force: true });
await mkdir(sitePackages, { recursive: true });

await downloadEmbeddablePython();
await enableSitePackages();
const hostPython = resolveHostPython();
installPackages(hostPython);
await copyVcRuntime();
downloadOcrModels();
const models = await selfTest();
await writeMarker(models);

console.log(`Python 运行时构建完成：${path.relative(root, runtimeDir)}（${await formatDirSize(runtimeDir)}）`);

async function isUpToDate() {
  if (!existsSync(markerFile) || !existsSync(pythonExe)) return false;
  try {
    const marker = JSON.parse(await readFile(markerFile, "utf8"));
    return marker.fingerprint === fingerprint;
  } catch {
    return false;
  }
}

async function downloadEmbeddablePython() {
  console.log(`  下载 ${PYTHON_ZIP_URL}`);
  const response = await fetch(PYTHON_ZIP_URL);
  if (!response.ok) throw new Error(`下载内嵌 Python 失败：HTTP ${response.status}`);

  const zip = await JSZip.loadAsync(Buffer.from(await response.arrayBuffer()));
  for (const entry of Object.values(zip.files)) {
    if (entry.dir) continue;
    const target = path.join(pythonDir, entry.name);
    await mkdir(path.dirname(target), { recursive: true });
    await writeFile(target, await entry.async("nodebuffer"));
  }
  if (!existsSync(pythonExe)) throw new Error("解压后没有找到 python.exe");
}

// embeddable 版默认不启用 site 机制，pip --target 装的包不会被搜索到。
// cv2 的 __init__.py 还依赖 site 来加载自身的 DLL 目录，所以必须放开 import site。
async function enableSitePackages() {
  const names = await readdir(pythonDir);
  const pthName = names.find((name) => /^python\d+\._pth$/i.test(name));
  if (!pthName) throw new Error("没有找到 python*._pth，无法配置模块搜索路径");

  const pthPath = path.join(pythonDir, pthName);
  const lines = (await readFile(pthPath, "utf8")).split(/\r?\n/);
  const kept = lines.filter((line) => {
    const value = line.trim();
    return value && value !== "." && value !== "import site" && value !== "#import site" && value !== "# import site"
      && !/^Lib[\\/]site-packages$/i.test(value);
  });

  await writeFile(pthPath, [...kept, ".", "Lib\\site-packages", "import site", ""].join("\n"), "utf8");
  console.log(`  已配置 ${pthName}（启用 site-packages）`);
}

function resolveHostPython() {
  const candidates = [
    path.join(root, ".venv", "Scripts", "python.exe"),
    "python",
    "py",
  ].filter((candidate) => candidate === "python" || candidate === "py" || existsSync(candidate));

  for (const candidate of candidates) {
    const probe = spawnSync(candidate, ["-c", "import sys;print('%d.%d' % sys.version_info[:2])"], {
      encoding: "utf8",
    });
    if (probe.status !== 0) continue;
    const version = String(probe.stdout).trim();
    if (version === expectedMinor()) {
      console.log(`  使用构建机 Python：${candidate}（${version}）`);
      return candidate;
    }
    console.log(`  跳过 ${candidate}：版本 ${version}，需要 ${expectedMinor()}`);
  }

  throw new Error(
    `找不到 ${expectedMinor()} 版本的 Python。onnxruntime/opencv/numpy 是 C 扩展，`
    + `wheel 的 ABI 标签必须与内嵌解释器 ${PYTHON_VERSION} 一致，请安装对应版本后重试。`,
  );
}

function expectedMinor() {
  const [major, minor] = PYTHON_VERSION.split(".");
  return `${major}.${minor}`;
}

function installPackages(hostPython) {
  console.log(`  安装依赖：${PACKAGES.join(", ")}`);
  const result = spawnSync(
    hostPython,
    ["-m", "pip", "install", "--target", sitePackages, `--only-binary=${BINARY_ONLY.join(",")}`, "--upgrade", ...PACKAGES],
    { stdio: "inherit" },
  );
  if (result.status !== 0) throw new Error("pip install 失败");

  // rapidocr 依赖的是完整版 opencv-python，它和 headless 版共用 cv2 目录，
  // 谁后安装谁生效。这里显式覆盖一次，保证最终装的是体积更小、依赖更少的 headless 版。
  const headless = spawnSync(
    hostPython,
    ["-m", "pip", "install", "--target", sitePackages, "--only-binary=:all:", "--upgrade", "--force-reinstall", "--no-deps", "opencv-python-headless"],
    { stdio: "inherit" },
  );
  if (headless.status !== 0) throw new Error("安装 opencv-python-headless 失败");
}

async function copyVcRuntime() {
  const system32 = path.join(process.env.SystemRoot || "C:\\Windows", "System32");
  const missing = [];

  for (const dll of VC_RUNTIME_DLLS) {
    const source = path.join(system32, dll);
    if (!existsSync(source)) {
      missing.push(dll);
      continue;
    }
    await copyFile(source, path.join(pythonDir, dll));
  }

  if (missing.length > 0) {
    throw new Error(
      `构建机缺少 MSVC 运行库：${missing.join(", ")}。请先安装 Microsoft Visual C++ Redistributable (x64) 后重试，`
      + "否则打出来的包在别的电脑上会因缺少 DLL 无法启动 OCR。",
    );
  }
  console.log(`  已携带 MSVC 运行库：${VC_RUNTIME_DLLS.join(", ")}`);
}

// 用内嵌解释器实例化一次，让模型落到运行时自己的 site-packages/rapidocr/models 里。
// pip --target 不生成 entry-point 脚本，所以不能用官方的 `rapidocr download_models` 命令。
function downloadOcrModels() {
  console.log("  拉取 OCR 模型（仅构建机需要联网）");
  const result = spawnSync(pythonExe, ["-c", "from rapidocr import RapidOCR; RapidOCR()"], {
    stdio: "inherit",
    env: pythonEnv(),
  });
  if (result.status !== 0) throw new Error("拉取 OCR 模型失败");
}

async function selfTest() {
  console.log("  自检（导入、真实 OCR、模型落盘）");
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "reimb-runtime-"));
  const scriptPath = path.join(tempDir, "selftest.py");
  await writeFile(scriptPath, selfTestScript(), "utf8");

  try {
    const result = spawnSync(pythonExe, [scriptPath, sitePackages], {
      encoding: "utf8",
      env: pythonEnv(),
    });
    if (result.stderr) process.stderr.write(result.stderr);
    if (result.status !== 0) throw new Error("运行时自检失败，这个包在别的电脑上大概率也跑不起来");

    const report = JSON.parse(String(result.stdout).trim().split(/\r?\n/).pop());
    console.log(`    pypdfium2 ${report.pypdfium2} · onnxruntime ${report.onnxruntime} · 模型 ${report.models.length} 个`);
    if (!report.ocrText) {
      console.warn("    警告：合成图片没有识别出文字，请在真实发票上确认识别效果");
    }
    return report.models;
  } finally {
    await rm(tempDir, { recursive: true, force: true }).catch(() => {});
  }
}

function pythonEnv() {
  // ._pth 已经接管模块搜索路径，设置 PYTHONHOME/PYTHONPATH 反而会破坏内嵌解释器。
  const env = { ...process.env, PYTHONIOENCODING: "utf-8", PYTHONUTF8: "1" };
  delete env.PYTHONHOME;
  delete env.PYTHONPATH;
  return env;
}

async function writeMarker(models) {
  await writeFile(
    markerFile,
    `${JSON.stringify({ fingerprint, pythonVersion: PYTHON_VERSION, packages: PACKAGES, models, builtAt: new Date().toISOString() }, null, 2)}\n`,
    "utf8",
  );
}

async function formatDirSize(dir) {
  let total = 0;
  const walk = async (current) => {
    for (const entry of await readdir(current, { withFileTypes: true })) {
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) await walk(full);
      else total += (await stat(full)).size;
    }
  };
  await walk(dir);
  return `${(total / 1024 / 1024).toFixed(0)} MB`;
}

// 用函数声明而不是 const，避免顶层 await 先执行时撞上暂时性死区。
function selfTestScript() {
  return `# -*- coding: utf-8 -*-
"""内嵌运行时自检：任何一步抛异常都说明这个包换台电脑跑不起来。"""
import glob
import json
import os
import sys

site_packages = sys.argv[1]

import numpy as np
import cv2
import omegaconf
import onnxruntime
import pypdfium2
from rapidocr import RapidOCR

# omegaconf 2.0 不支持 Path 类型，RapidOCR 初始化会直接崩，这里挡住静默降级。
if tuple(int(part) for part in omegaconf.__version__.split(".")[:2]) < (2, 3):
    raise SystemExit(f"omegaconf 版本过低（{omegaconf.__version__}），RapidOCR 无法初始化")

models = sorted(os.path.basename(p) for p in glob.glob(os.path.join(site_packages, "rapidocr", "models", "*.onnx")))
if not models:
    raise SystemExit("rapidocr/models 下没有 .onnx 模型，离线环境将无法识别")

# 合成一张带数字的图片跑真实推理。缺 DLL 之类的问题会在这里抛异常。
image = np.full((160, 640, 3), 255, dtype=np.uint8)
cv2.putText(image, "12345.67", (30, 105), cv2.FONT_HERSHEY_SIMPLEX, 2.4, (0, 0, 0), 5)

engine = RapidOCR()
result = engine(image)  # 注意：不要调用 result.vis()，官方文档说明它会联网下载字体
texts = list(getattr(result, "txts", None) or [])

print(json.dumps({
    "pypdfium2": getattr(pypdfium2, "__version__", "?"),
    "onnxruntime": onnxruntime.__version__,
    "numpy": np.__version__,
    "models": models,
    "ocrText": " ".join(texts),
}))
`;
}
