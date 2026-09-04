# 报销单据管理

Windows 桌面版，当前技术栈是 React + Vite + Electron。界面和业务逻辑以 Web 技术实现，后续可以复用到网页端；移动端可以继续基于 React 层接 Capacitor 或重做壳层。

## 启动

在源码目录调试时，运行：

```powershell
npm install
npm run start
```

本地识别基于 Python（RapidOCR）。开发调试需要一个 Python 3.13 虚拟环境：

```powershell
python -m venv .venv
.venv\Scripts\python.exe -m pip install -r requirements.txt
```

打包时应用会自动构建一份自包含的 Python 运行时（`npm run prepare:runtime`，构建脚本 `scripts/prepare-python-runtime.mjs`），所以**换任何 Windows 电脑装好依赖后 `npm run start` 即可调试，打包产物不依赖系统 Python**。构建运行时需要联网（下载内嵌 Python、依赖包和 OCR 模型），构建完成后离线可用。

## 打包分发

两种产物，都**自带识别环境，目标机器无需安装 Python、无需联网**。

### 安装包（发给别人用这个）

```powershell
npm run package:installer
```

产物：`dist-electron\Reimbursement-0.2.0-Setup.exe`

双击安装，可以自选安装目录，带桌面和开始菜单快捷方式，以及卸载入口。默认装到当前用户目录（不需要管理员权限）。

### 发布更新（GitHub Releases）

应用内置自动更新（electron-updater + GitHub Releases）：启动后约 8 秒后台检查一次（可在「外观与设置」里关闭），发现新版本自动下载，完成后弹窗提示重启安装，或等下次退出时静默安装。

发布流程：

```powershell
# 1. package.json 里把 version 改成新版本号（如 0.2.1）
# 2. 设置有 repo 权限的 GitHub token
$env:GH_TOKEN = "ghp_xxx"
npm run release
```

`npm run release` = 构建 + 打包 + 自动创建 GitHub **draft release**（tag `v0.2.1`），并上传 `Reimbursement-0.2.1-Setup.exe`、`.blockmap`（差量更新）和 `latest.yml`（版本清单）。到 GitHub Releases 页面填写更新说明后点击 Publish，所有已安装的客户端即可收到更新。

注意：安装包文件名固定为 ASCII（`Reimbursement-x.y.z-Setup.exe`），这是 electron-updater 下载链路的兼容性要求；应用内名称、快捷方式仍是「报销单据管理」。仓库需为 public，私有仓库的更新需要把 token 打进客户端，不可行。

### 文件夹版（本地验证用这个）

```powershell
npm run package:win-folder
```

产物：`packaged\报销单据管理-win32-x64\报销单据管理.exe`

免安装，但要保留整个文件夹再拷走——Electron 运行时和识别环境（内嵌 Python + RapidOCR + 模型）都在同级目录里，单独拷 exe 跑不起来。

### 图标

exe 图标来自根目录 `icon.png`，改图后需要重新生成 `icon.ico`：

```powershell
tools\runtime\python\python.exe scripts\make-icon.py
```

脚本会生成 16/24/32/48/64/128/256 七档尺寸。注意每一档必须是 DIB 格式而不是内嵌 PNG——`.ico` 文件两种都合法，但写进 exe 的 `RT_ICON` 资源后，PNG 压缩条目在资源管理器的图标渲染路径上解码不稳定，表现就是 exe 显示不出图标。

## 当前功能

- 新建、重命名、删除报销，例如 `北京出差`
- 一个报销下上传多个单据：PDF 和图片（jpg/png）
- 邮件自动拉取发票附件（PDF 与图片）
- 单据文件和记录保存到本机 IndexedDB，桌面端可离线使用
- 自动识别金额、发票号码、开票日期
- 预览已上传单据（PDF 与图片）
- 金额识别不准时可手动修改
- 导出所选单据，或导出当前报销下全部单据为 ZIP
- ZIP 内包含原始单据和 `单据汇总.csv`

## 识别引擎

识别链路：电子发票 PDF 先抽文字层直接解析；扫描件 PDF 渲染成位图后、图片发票直接经 **RapidOCR**（onnxruntime，纯 CPU，离线）识别。识别环境是应用自带的内嵌 Python 运行时，不依赖系统 Python，也不使用 PyMuPDF（PDF 抽层与渲染由 pypdfium2 完成）。

## 金额识别规则

优先识别普通发票里的 `（小写）¥xx.xx`。如果没有这个字段，则读取 PDF 中所有带 `¥` 或 `￥` 的金额，取最大值作为票据金额。当前项目里的铁路电子客票样例会走这个兜底规则。

## 后续 WebDAV 预留

当前本地存储逻辑在 `src/storage.js`。未来接 WebDAV 时，可以在这一层增加同步或远程存储适配，React 界面和 PDF 识别逻辑不需要大改。
