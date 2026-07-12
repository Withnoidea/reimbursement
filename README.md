# 报销单据管理

Windows 桌面版，当前技术栈是 React + Vite + Electron。界面和业务逻辑以 Web 技术实现，后续可以复用到网页端；移动端可以继续基于 React 层接 Capacitor 或重做壳层。

## 启动

在源码目录调试时，运行：

```powershell
npm install
npm run start
```

如果是第一次运行，还需要创建 Python 虚拟环境（用于本地 PDF 识别）：

```powershell
python -m venv .venv
.venv\Scripts\python.exe -m pip install -r requirements.txt
```

## 生成 Windows exe

当前已支持文件夹版 Windows 应用，运行：

```powershell
npm run package:win-folder
```

生成后双击：

```text
packaged\报销单据管理-win32-x64\报销单据管理.exe
```

这个版本不是单文件安装包，而是一个完整应用目录。请保留整个 `报销单据管理-win32-x64` 文件夹，不要只单独拷贝 exe，因为 Electron 运行时和 PDF 解析器都在同级目录里。

`npm run package:win` 是 electron-builder 的单文件便携版打包命令，但当前这台 Windows 环境在解压 Electron 时会出现目录重命名权限错误。文件夹版 exe 已可用。

## 当前功能

- 新建、重命名、删除报销，例如 `阜阳五院出差`
- 一个报销下上传多个 PDF 单据
- PDF 文件和记录保存到本机 IndexedDB，桌面端可离线使用
- 自动识别金额、发票号码、开票日期
- 预览已上传 PDF
- 金额识别不准时可手动修改
- 导出所选单据，或导出当前报销下全部单据为 ZIP
- ZIP 内包含原 PDF 和 `单据汇总.csv`

## 金额识别规则

优先识别普通发票里的 `（小写）¥xx.xx`。如果没有这个字段，则读取 PDF 中所有带 `¥` 或 `￥` 的金额，取最大值作为票据金额。当前项目里的铁路电子客票样例会走这个兜底规则。

## 后续 WebDAV 预留

当前本地存储逻辑在 `src/storage.js`。未来接 WebDAV 时，可以在这一层增加同步或远程存储适配，React 界面和 PDF 识别逻辑不需要大改。
