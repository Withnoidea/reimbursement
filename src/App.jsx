import { useEffect, useMemo, useRef, useState } from "react";
import {
  Archive,
  Download,
  Eye,
  FileText,
  FolderInput,
  FolderOpen,
  Mail,
  MoreHorizontal,
  Pencil,
  Plus,
  ReceiptText,
  RefreshCw,
  Search,
  Settings,
  Trash2,
  Ungroup,
  Upload,
  WalletCards,
  X,
} from "lucide-react";
import {
  addDocument,
  createReimbursement,
  deleteDocuments,
  deleteReimbursement,
  listAllDocuments,
  listDocuments,
  listReimbursements,
  makeId,
  updateDocument,
  updateReimbursement,
} from "./storage.js";
import { parsePdf } from "./pdfParser.js";
import { exportDocumentsZip, formatBytes, formatDateTime, formatInvoiceDate, money } from "./exporter.js";

const documentFieldLabels = {
  amount: "金额",
  invoiceNo: "发票号码",
  invoiceDate: "开票日期",
  note: "备注",
};

const documentFieldInputTypes = {
  amount: "number",
  invoiceNo: "text",
  invoiceDate: "date",
  note: "text",
};

const themeOptions = [
  { value: "mint", label: "薄荷办公", description: "松石绿侧栏配薄荷强调色，清爽耐看", colors: ["#0e3b32", "#14907f", "#e7f3ef"] },
  { value: "porcelain", label: "瓷白蓝灰", description: "蓝灰侧栏配冷蓝强调色，安静克制", colors: ["#3a4a63", "#3b6ea5", "#e9f0f8"] },
  { value: "lake", label: "湖光青蓝", description: "深海蓝侧栏配湖蓝高亮，通透明快", colors: ["#10394e", "#0e8aa8", "#e3f3f7"] },
  { value: "ember", label: "暖棕票据", description: "暖棕侧栏配琥珀强调色，适合财务归档感", colors: ["#45301f", "#c05621", "#faeee3"] },
  { value: "sakura", label: "樱粉映白", description: "深酒红侧栏配樱粉高亮，柔和有辨识度", colors: ["#542a3d", "#d4547a", "#fbeaf0"] },
  { value: "violet", label: "紫藤专业", description: "深紫侧栏配紫罗兰强调色，沉稳专业", colors: ["#33265a", "#7451c2", "#efeafa"] },
  { value: "graphite", label: "鎏金石墨", description: "石墨黑侧栏配鎏金强调色，低调轻奢", colors: ["#1b1c1e", "#a0762e", "#f5eedf"] },
  { value: "aurora", label: "极光深色", description: "深夜蓝背景配极光青高亮，适合夜间处理单据", colors: ["#060b16", "#23c3a4", "#0b1220"] },
  { value: "midnight", label: "午夜靛蓝", description: "墨蓝深色背景配靛蓝紫高亮，夜间更护眼", colors: ["#080a1a", "#8b93f8", "#0e1126"] },
];

function getInitialTheme() {
  const saved = localStorage.getItem("reimbursement-theme");
  return themeOptions.some((option) => option.value === saved) ? saved : "mint";
}

export default function App() {
  const fileInputRef = useRef(null);
  const mailSyncingRef = useRef(false);
  const [reimbursements, setReimbursements] = useState([]);
  const [documents, setDocuments] = useState([]);
  const [activeId, setActiveId] = useState("");
  const [selectedIds, setSelectedIds] = useState(new Set());
  const [query, setQuery] = useState("");
  const [busy, setBusy] = useState("");
  const [toast, setToast] = useState("");
  const [dialog, setDialog] = useState(null);
  const [preview, setPreview] = useState(null);
  const [dragging, setDragging] = useState(false);
  const [sortConfig, setSortConfig] = useState({ field: "uploadedAt", direction: "desc" });
  const [theme, setTheme] = useState(getInitialTheme);

  const active = reimbursements.find((item) => item.id === activeId) || null;
  const canMailSync = Boolean(window.desktopApi?.syncMailbox);
  const selectedDocs = documents.filter((doc) => selectedIds.has(doc.id));
  const selectedTotal = selectedDocs.reduce((sum, doc) => sum + Number(doc.amount || 0), 0);
  const visibleDocuments = useMemo(() => {
    const keyword = query.trim().toLowerCase();
    const filtered = keyword ? documents.filter((doc) =>
      [doc.name, doc.invoiceNo, doc.note, formatInvoiceDate(doc.invoiceDate), money(doc.amount), mergedSearchText(doc)]
        .join(" ")
        .toLowerCase()
        .includes(keyword)
    ) : documents;
    return sortDocuments(filtered, sortConfig);
  }, [documents, query, sortConfig]);

  useEffect(() => {
    refreshReimbursements();
  }, []);

  useEffect(() => {
    document.documentElement.dataset.theme = theme;
    localStorage.setItem("reimbursement-theme", theme);
  }, [theme]);

  useEffect(() => {
    if (!window.desktopApi?.onMenuAction) return undefined;
    return window.desktopApi.onMenuAction((action) => {
      if (action === "open-preferences") openPreferences();
      if (action === "new-reimbursement") {
        setDialog({ type: "reimbursement", mode: "create", value: "" });
      }
    });
  }, []);

  useEffect(() => {
    if (!window.desktopApi?.onMailSyncProgress) return undefined;
    return window.desktopApi.onMailSyncProgress((text) => {
      if (mailSyncingRef.current) setBusy(text || "正在同步邮箱…");
    });
  }, []);

  useEffect(() => {
    if (activeId) refreshDocuments(activeId);
    else setDocuments([]);
  }, [activeId]);

  function openPreferences() {
    setDialog({ type: "preferences" });
  }

  async function refreshReimbursements(preferredId) {
    const items = await listReimbursements();
    setReimbursements(items);
    const nextId = preferredId || activeId || items[0]?.id || "";
    setActiveId(items.some((item) => item.id === nextId) ? nextId : items[0]?.id || "");
  }

  async function refreshDocuments(id = activeId) {
    if (!id) return;
    setDocuments(await listDocuments(id));
    setSelectedIds(new Set());
  }

  async function handleSaveReimbursement(name, mode) {
    if (!name.trim()) return;
    if (mode === "rename" && active) {
      await updateReimbursement(active.id, { name: name.trim() });
      await refreshReimbursements(active.id);
    } else {
      const item = await createReimbursement(name);
      await refreshReimbursements(item.id);
    }
    setDialog(null);
  }

  async function handleDeleteReimbursement(target = active) {
    if (!target) return;
    setDialog({
      type: "confirm",
      title: "删除报销",
      message: `确定删除“${target.name}”和其中的单据记录吗？`,
      actionLabel: "删除",
      onConfirm: async () => {
        await deleteReimbursement(target.id);
        await refreshReimbursements("");
        setDialog(null);
        setToast("已删除报销");
      },
    });
  }

  async function handleFiles(files) {
    if (!active) {
      setToast("请先创建或选择一个报销");
      return;
    }

    const pdfs = [...files].filter((file) => file.type === "application/pdf" || file.name.toLowerCase().endsWith(".pdf"));
    if (pdfs.length === 0) {
      setToast("请选择 PDF 文件");
      return;
    }

    setBusy(`正在识别 ${pdfs.length} 个 PDF`);
    const failures = [];
    for (const file of pdfs) {
      try {
        const parsed = await parseWithBestAvailableParser(file);
        await addDocument({
          id: makeId("d"),
          reimbursementId: active.id,
          name: file.name,
          amount: parsed.amount,
          invoiceNo: parsed.invoiceNo,
          invoiceDate: parsed.invoiceDate,
          note: "",
          pageCount: parsed.pageCount,
          size: file.size,
          uploadedAt: new Date().toISOString(),
          fileBlob: file,
          fileHash: await hashBlob(file),
        });
      } catch (error) {
        failures.push(`${file.name}: ${error.message}`);
      }
    }
    setBusy("");
    await refreshDocuments(active.id);
    await refreshReimbursements(active.id);
    setToast(failures.length > 0 ? `部分文件失败：${failures.join("；")}` : `已导入 ${pdfs.length} 个 PDF`);
  }

  async function handleEditField(doc, field) {
    setDialog({ type: "documentField", field, doc, value: getDocumentFieldEditValue(doc, field) });
  }

  async function handleMailSync() {
    if (!canMailSync) return;
    if (!active) {
      setToast("请先创建或选择一个报销");
      return;
    }
    if (busy) return;

    const config = await window.desktopApi.loadMailConfig();
    if (!config?.user || !config?.hasAuth) {
      setDialog({ type: "mailSettings" });
      setToast("请先配置邮箱账号和授权码");
      return;
    }

    const stateKey = `mail-sync-state:${config.user}@${config.host}/${config.folder}`;
    let syncState = null;
    try {
      syncState = JSON.parse(localStorage.getItem(stateKey) || "null");
    } catch {
      syncState = null;
    }

    mailSyncingRef.current = true;
    setBusy("正在连接邮箱…");
    try {
      const result = await window.desktopApi.syncMailbox({ state: syncState });
      if (!result?.ok) {
        if (result?.needsConfig) setDialog({ type: "mailSettings" });
        setToast(`同步失败：${result?.error || "未知错误"}`);
        return;
      }

      const allDocs = await listAllDocuments();
      const known = collectKnownInvoiceNos(allDocs);
      const knownHashes = await collectKnownFileHashes(allDocs);
      let added = 0;
      let duplicated = 0;
      for (const item of result.items) {
        const invoiceNo = String(item.invoiceNo || "").trim();
        const fileHash = item.fileHash || "";
        if ((invoiceNo && known.has(invoiceNo)) || (fileHash && knownHashes.has(fileHash))) {
          duplicated += 1;
          continue;
        }
        if (invoiceNo) known.add(invoiceNo);
        if (fileHash) knownHashes.add(fileHash);
        await addDocument({
          id: makeId("d"),
          reimbursementId: active.id,
          name: item.fileName,
          amount: item.amount,
          invoiceNo,
          invoiceDate: item.invoiceDate || "",
          note: "",
          pageCount: item.pageCount || 1,
          size: item.size || 0,
          uploadedAt: new Date().toISOString(),
          fileBlob: new Blob([item.data], { type: "application/pdf" }),
          fileHash: fileHash || null,
        });
        added += 1;
      }

      localStorage.setItem(stateKey, JSON.stringify(result.newState));
      await refreshDocuments(active.id);
      await refreshReimbursements(active.id);

      const parts = [`扫描 ${result.stats.scanned} 封新邮件`];
      if (added > 0) parts.push(`导入 ${added} 张发票`);
      if (duplicated > 0) parts.push(`跳过重复 ${duplicated} 张`);
      if (result.stats.skippedOfd > 0) parts.push(`${result.stats.skippedOfd} 个 OFD 文件暂不支持`);
      if (result.stats.parseFailures > 0) parts.push(`${result.stats.parseFailures} 张未识别出信息`);
      if (added === 0 && duplicated === 0) parts.push("没有发现新发票");
      setToast(`同步完成：${parts.join("，")}`);
    } catch (error) {
      setToast(`同步失败：${error.message}`);
    } finally {
      mailSyncingRef.current = false;
      setBusy("");
    }
  }

  async function saveDocumentField(value, doc, field) {
    const changes = getDocumentFieldChange(field, value);
    if (!changes) return;
    await updateDocument(doc.id, changes);
    await refreshDocuments();
    await refreshReimbursements(activeId);
    setDialog(null);
  }

  async function handleMergeDocuments() {
    if (!active || selectedDocs.length < 2) return;
    const firstName = selectedDocs[0]?.name?.replace(/\.pdf$/i, "") || "合并单据";
    setDialog({
      type: "merge",
      docs: selectedDocs,
      value: `${firstName}等${selectedDocs.length}张`,
    });
  }

  async function saveMergedDocuments(name, docs) {
    const title = name.trim();
    if (!active || !title || docs.length < 2) return;
    const mergedItems = docs.flatMap((doc) => flattenMergedItems(doc));
    const totalAmount = docs.reduce((sum, doc) => sum + Number(doc.amount || 0), 0);
    const invoiceNos = uniqueValues(mergedItems.map((item) => item.invoiceNo));
    const invoiceDates = uniqueValues(mergedItems.map((item) => formatInvoiceDate(item.invoiceDate)));
    const notes = uniqueValues(mergedItems.map((item) => item.note));

    await addDocument({
      id: makeId("d"),
      reimbursementId: active.id,
      name: title,
      amount: Math.round(totalAmount * 100) / 100,
      invoiceNo: invoiceNos.join(" / "),
      invoiceDate: invoiceDates.length === 1 ? invoiceDates[0] : "",
      note: notes.length === 1 ? notes[0] : notes.join(" / "),
      pageCount: mergedItems.reduce((sum, item) => sum + Number(item.pageCount || 1), 0),
      size: mergedItems.reduce((sum, item) => sum + Number(item.size || 0), 0),
      uploadedAt: new Date().toISOString(),
      fileBlob: null,
      mergedItems,
    });
    await deleteDocuments(docs.map((doc) => doc.id));
    await refreshDocuments();
    await refreshReimbursements(activeId);
    setDialog(null);
    setToast(`已合并 ${docs.length} 张单据，合计 ¥${money(totalAmount)}`);
  }

  async function handleUnmergeDocument(doc) {
    if (!active || !doc.mergedItems?.length) return;
    setDialog({
      type: "confirm",
      title: "解除合并",
      message: `确定将“${doc.name}”拆回 ${doc.mergedItems.length} 张单据吗？`,
      actionLabel: "解除合并",
      onConfirm: async () => {
        for (const item of doc.mergedItems) {
          await addDocument({
            id: makeId("d"),
            reimbursementId: active.id,
            name: item.name || "单据.pdf",
            amount: item.amount,
            invoiceNo: item.invoiceNo || "",
            invoiceDate: item.invoiceDate || "",
            note: item.note || "",
            pageCount: item.pageCount || 1,
            size: item.size || 0,
            uploadedAt: item.uploadedAt || new Date().toISOString(),
            fileBlob: item.fileBlob || null,
            fileHash: item.fileHash || null,
          });
        }
        await deleteDocuments([doc.id]);
        await refreshDocuments();
        await refreshReimbursements(activeId);
        setDialog(null);
        setToast(`已解除合并 ${doc.mergedItems.length} 张单据`);
      },
    });
  }

  async function handleDeleteDocuments() {
    if (selectedIds.size === 0) return;
    setDialog({
      type: "confirm",
      title: "删除单据",
      message: `确定删除选中的 ${selectedIds.size} 条单据记录吗？`,
      actionLabel: "删除",
      onConfirm: async () => {
        await deleteDocuments([...selectedIds]);
        await refreshDocuments();
        await refreshReimbursements(activeId);
        setDialog(null);
        setToast("已删除单据记录");
      },
    });
  }

  async function handleExport(scope) {
    const docs = scope === "selected" ? selectedDocs : documents;
    if (!active || docs.length === 0) {
      setToast("没有可导出的单据");
      return;
    }
    await exportDocumentsZip(active, docs);
    setToast(`已生成 ${docs.length} 张单据的压缩包`);
  }

  function openPreview(doc) {
    setPreview({ doc });
  }

  function closePreview() {
    setPreview(null);
  }

  function toggleSelect(id) {
    const next = new Set(selectedIds);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    setSelectedIds(next);
  }

  function toggleSelectAllVisible() {
    const next = new Set(selectedIds);
    const allSelected = visibleDocuments.length > 0 && visibleDocuments.every((doc) => next.has(doc.id));
    if (allSelected) visibleDocuments.forEach((doc) => next.delete(doc.id));
    else visibleDocuments.forEach((doc) => next.add(doc.id));
    setSelectedIds(next);
  }

  function handleMoveDocuments() {
    if (!active || selectedDocs.length === 0) return;
    setDialog({ type: "moveDocuments", docs: selectedDocs });
  }

  async function moveDocumentsTo(docs, target) {
    let targetId = target.id || "";
    let targetName = target.name || "";
    if (!targetId && target.createName) {
      const item = await createReimbursement(target.createName);
      targetId = item.id;
      targetName = item.name;
    }
    if (!targetId) return;
    for (const doc of docs) {
      await updateDocument(doc.id, { reimbursementId: targetId });
    }
    await refreshDocuments(activeId);
    await refreshReimbursements(activeId);
    setDialog(null);
    setToast(`已移动 ${docs.length} 张单据到「${targetName}」`);
  }

  function handleSort(field) {
    setSortConfig((current) => ({
      field,
      direction: current.field === field && current.direction === "asc" ? "desc" : "asc",
    }));
  }

  const total = documents.reduce((sum, doc) => sum + Number(doc.amount || 0), 0);

  return (
    <div className="appShell">
      <aside className="sidebar">
        <div className="brand">
          <div className="brandIcon">
            <WalletCards size={22} />
          </div>
          <div>
            <div className="brandTitle">报销单据</div>
            <div className="brandSub">本地桌面工作台</div>
          </div>
        </div>

        <button className="primaryButton full" onClick={() => setDialog({ type: "reimbursement", mode: "create", value: "" })}>
          <Plus size={17} />
          新建报销
        </button>

        <div className="navList">
          {reimbursements.map((item) => (
            <div
              key={item.id}
              className={`navItem ${item.id === activeId ? "active" : ""}`}
            >
              <button className="navSelect" onClick={() => setActiveId(item.id)}>
                <span className="navIcon">
                  <ReceiptText size={18} />
                </span>
                <span className="navText">
                  <strong>{item.name}</strong>
                  <em>{item.documentCount} 张 / {money(item.totalAmount)} 元</em>
                </span>
              </button>
              <button
                className="navDelete"
                title="删除报销"
                onClick={(event) => {
                  event.stopPropagation();
                  handleDeleteReimbursement(item);
                }}
              >
                <Trash2 size={16} />
              </button>
            </div>
          ))}
        </div>
      </aside>

      <main className="workspace">
        <header className="topbar">
          <div>
            <h1>{active?.name || "创建一个报销"}</h1>
            <p>{active ? `${documents.length} 张单据，合计 ${money(total)} 元` : "先创建报销，再上传 PDF 单据"}</p>
          </div>
          <div className="topActions">
            <button className="ghostButton" disabled={!active} onClick={() => setDialog({ type: "reimbursement", mode: "rename", value: active?.name || "" })}>
              <Pencil size={17} />
              重命名
            </button>
            <button className="dangerButton" disabled={!active} onClick={() => handleDeleteReimbursement()}>
              <Trash2 size={17} />
              删除
            </button>
          </div>
        </header>

        <section
          className={`uploadBand ${dragging ? "dragging" : ""}`}
          onDragEnter={(event) => {
            event.preventDefault();
            setDragging(true);
          }}
          onDragOver={(event) => event.preventDefault()}
          onDragLeave={() => setDragging(false)}
          onDrop={(event) => {
            event.preventDefault();
            setDragging(false);
            handleFiles(event.dataTransfer.files);
          }}
        >
          <div className="uploadCopy">
            <Upload size={22} />
            <div>
              <strong>上传 PDF 单据</strong>
              <span>自动识别金额、发票号码和开票日期</span>
            </div>
          </div>
          <div className="uploadActions">
            {canMailSync && (
              <>
                <button className="ghostButton" disabled={!active || Boolean(busy)} onClick={handleMailSync}>
                  <RefreshCw size={17} />
                  同步邮箱
                </button>
                <button
                  className="ghostButton iconOnlyButton"
                  title="邮箱同步设置"
                  disabled={Boolean(busy)}
                  onClick={() => setDialog({ type: "mailSettings" })}
                >
                  <Settings size={17} />
                </button>
              </>
            )}
            <button className="primaryButton" disabled={!active || Boolean(busy)} onClick={() => fileInputRef.current?.click()}>
              <FolderOpen size={17} />
              选择文件
            </button>
          </div>
          <input
            ref={fileInputRef}
            type="file"
            accept="application/pdf,.pdf"
            multiple
            hidden
            onChange={(event) => {
              handleFiles(event.target.files);
              event.target.value = "";
            }}
          />
        </section>

        <div className="contentGrid">
          <section className="panel documentPanel">
            <div className="panelToolbar">
              <div className="searchBox">
                <Search size={17} />
                <input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="搜索文件名、金额或发票号码" />
              </div>
              <div className="tableActions">
                <button className="ghostButton" disabled={selectedIds.size === 0} onClick={() => handleExport("selected")}>
                  <Archive size={17} />
                  导出所选
                </button>
                <button className="ghostButton" disabled={selectedIds.size === 0} onClick={handleMoveDocuments}>
                  <FolderInput size={17} />
                  移动
                </button>
                <button className="ghostButton" disabled={selectedIds.size < 2} onClick={handleMergeDocuments}>
                  <Archive size={17} />
                  合并
                </button>
                <button className="ghostButton" disabled={documents.length === 0} onClick={() => handleExport("all")}>
                  <Download size={17} />
                  导出全部
                </button>
                <button className="dangerButton" disabled={selectedIds.size === 0} onClick={handleDeleteDocuments}>
                  <Trash2 size={17} />
                </button>
              </div>
            </div>

            <div className="tableWrap">
              <table>
                <thead>
                  <tr>
                    <th className="checkCol">
                      <input
                        type="checkbox"
                        title="全选当前列表"
                        disabled={visibleDocuments.length === 0}
                        checked={visibleDocuments.length > 0 && visibleDocuments.every((doc) => selectedIds.has(doc.id))}
                        ref={(el) => {
                          if (!el) return;
                          const selectedCount = visibleDocuments.filter((doc) => selectedIds.has(doc.id)).length;
                          el.indeterminate = selectedCount > 0 && selectedCount < visibleDocuments.length;
                        }}
                        onChange={toggleSelectAllVisible}
                      />
                    </th>
                    <SortableTh field="name" sortConfig={sortConfig} onSort={handleSort}>单据</SortableTh>
                    <SortableTh field="amount" sortConfig={sortConfig} onSort={handleSort}>金额</SortableTh>
                    <SortableTh field="invoiceNo" sortConfig={sortConfig} onSort={handleSort}>发票号码</SortableTh>
                    <SortableTh field="invoiceDate" sortConfig={sortConfig} onSort={handleSort}>开票日期</SortableTh>
                    <SortableTh field="note" className="noteCol" sortConfig={sortConfig} onSort={handleSort}>备注</SortableTh>
                    <SortableTh field="uploadedAt" sortConfig={sortConfig} onSort={handleSort}>上传时间</SortableTh>
                    <th className="actionCol"></th>
                  </tr>
                </thead>
                <tbody>
                  {visibleDocuments.map((doc) => (
                    <tr key={doc.id} className={selectedIds.has(doc.id) ? "selectedRow" : ""}>
                      <td>
                        <input type="checkbox" checked={selectedIds.has(doc.id)} onChange={() => toggleSelect(doc.id)} />
                      </td>
                      <td>
                        <div className="fileCell">
                          <FileText size={19} />
                          <div>
                            <strong>
                              <EllipsisText value={doc.name} />
                            </strong>
                            <span>
                              {doc.mergedItems?.length ? `${doc.mergedItems.length} 张合并` : formatBytes(doc.size)} · {doc.pageCount || 1} 页
                            </span>
                          </div>
                        </div>
                      </td>
                      <td className="amountCell">
                        <EditableValue
                          value={displayAmount(doc)}
                          missing={!hasAmount(doc)}
                          onEdit={() => handleEditField(doc, "amount")}
                        />
                      </td>
                      <td>
                        <EditableValue
                          value={doc.invoiceNo}
                          emptyText="未识别"
                          missing={!doc.invoiceNo}
                          onEdit={() => handleEditField(doc, "invoiceNo")}
                        />
                      </td>
                      <td>
                        <EditableValue
                          value={formatInvoiceDate(doc.invoiceDate)}
                          emptyText="未识别"
                          missing={!doc.invoiceDate}
                          onEdit={() => handleEditField(doc, "invoiceDate")}
                        />
                      </td>
                      <td>
                        <EditableValue
                          value={doc.note}
                          emptyText="未备注"
                          missing={!doc.note}
                          onEdit={() => handleEditField(doc, "note")}
                        />
                      </td>
                      <td>
                        <EllipsisText value={formatDateTime(doc.uploadedAt)} />
                      </td>
                      <td>
                        <div className="rowActions">
                          <button title="预览" onClick={() => openPreview(doc)}><Eye size={16} /></button>
                          {doc.mergedItems?.length > 0 && (
                            <button title="解除合并" onClick={() => handleUnmergeDocument(doc)}><Ungroup size={16} /></button>
                          )}
                          <button title="修改" onClick={() => handleEditField(doc, "amount")}><Pencil size={16} /></button>
                        </div>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>

              {visibleDocuments.length === 0 && (
                <div className="emptyState">
                  <FileText size={32} />
                  <strong>{documents.length === 0 ? "还没有单据" : "没有匹配的单据"}</strong>
                  <span>{documents.length === 0 ? "上传 PDF 后会出现在这里" : "换一个关键词试试"}</span>
                </div>
              )}
            </div>
          </section>

          <aside className="panel summaryPanel">
            <div className="summaryHeader">
              <span>当前报销</span>
              <MoreHorizontal size={18} />
            </div>
            <div className="metric big">
              <label>合计金额</label>
              <strong>¥{money(total)}</strong>
            </div>
            <div className="metricGrid">
              <div className="metric">
                <label>单据数</label>
                <strong>{documents.length}</strong>
              </div>
              <div className="metric">
                <label>已选择</label>
                <strong>{selectedIds.size}</strong>
              </div>
              <div className="metric">
                <label>已选金额</label>
                <strong>¥{money(selectedTotal)}</strong>
              </div>
            </div>
            {selectedDocs.length > 0 && (
              <div className="selectedList">
                <label>已选单据</label>
                {selectedDocs.map((doc) => (
                  <div key={doc.id} title={`${doc.name}：${displayAmount(doc)}`}>
                    <span><EllipsisText value={doc.name} /></span>
                    <em>{displayAmount(doc)}</em>
                  </div>
                ))}
              </div>
            )}
            <div className="recentList">
              <label>最近上传</label>
              {documents.slice(0, 5).map((doc) => (
                <button key={doc.id} onClick={() => openPreview(doc)}>
                  <span><EllipsisText value={doc.name} /></span>
                  <em title={displayAmount(doc)}>{displayAmount(doc)}</em>
                </button>
              ))}
              {documents.length === 0 && <p>暂无记录</p>}
            </div>
          </aside>
        </div>
      </main>

      {busy && <div className="busyToast">{busy}</div>}
      {toast && <Toast value={toast} onClose={() => setToast("")} />}
      {dialog?.type === "preferences" && (
        <PreferencesDialog
          theme={theme}
          onThemeChange={setTheme}
          canMailSync={canMailSync}
          onOpenMailSettings={() => setDialog({ type: "mailSettings" })}
          onClose={() => setDialog(null)}
        />
      )}
      {dialog?.type === "mailSettings" && (
        <MailSettingsDialog
          onClose={() => setDialog(null)}
          onSaved={() => setToast("邮箱设置已保存")}
        />
      )}
      {dialog?.type === "moveDocuments" && (
        <MoveDialog
          docs={dialog.docs}
          reimbursements={reimbursements}
          activeId={activeId}
          onClose={() => setDialog(null)}
          onMove={(target) => moveDocumentsTo(dialog.docs, target)}
        />
      )}
      {dialog && dialog.type !== "preferences" && dialog.type !== "mailSettings" && dialog.type !== "moveDocuments" && (
        <EditDialog
          dialog={dialog}
          onClose={() => setDialog(null)}
          onSave={(value) => {
            if (dialog.type === "documentField") saveDocumentField(value, dialog.doc, dialog.field);
            else if (dialog.type === "merge") saveMergedDocuments(value, dialog.docs);
            else handleSaveReimbursement(value, dialog.mode);
          }}
        />
      )}
      {preview && <PreviewModal preview={preview} onClose={closePreview} />}
    </div>
  );
}

async function parseWithBestAvailableParser(file) {
  if (window.desktopApi) {
    try {
      const filePath = window.desktopApi.getPathForFile(file);
      if (filePath) return await window.desktopApi.parsePdf(filePath);
    } catch (error) {
      console.warn("Native PDF parser failed, falling back to PDF.js.", error);
    }
  }
  return parsePdf(file);
}

function SortableTh({ field, sortConfig, onSort, className = "", children }) {
  const active = sortConfig.field === field;
  return (
    <th className={className}>
      <button type="button" className={`sortHeader ${active ? "active" : ""}`} onClick={() => onSort(field)}>
        <span>{children}</span>
        <em>{active ? (sortConfig.direction === "asc" ? "↑" : "↓") : "↕"}</em>
      </button>
    </th>
  );
}

function EditableValue({ value, emptyText = "修改", missing = false, onEdit }) {
  const text = String(value || "").trim();
  const display = text || emptyText;
  return (
    <button
      type="button"
      className={`cellEditButton ${missing ? "missingValue" : ""}`}
      onClick={onEdit}
    >
      <EllipsisText value={display} forceTitle={isLongText(text)} />
    </button>
  );
}

function EllipsisText({ value, emptyText = "-", forceTitle = false }) {
  const text = String(value || "").trim();
  const display = text || emptyText;
  const title = forceTitle || isLongText(display) ? display : undefined;
  return <span className="ellipsisText" title={title}>{display}</span>;
}

function sortDocuments(items, sortConfig) {
  const direction = sortConfig.direction === "asc" ? 1 : -1;
  return [...items].sort((a, b) => compareDocumentField(a, b, sortConfig.field) * direction);
}

function compareDocumentField(a, b, field) {
  if (field === "amount") return Number(a.amount || 0) - Number(b.amount || 0);
  if (field === "invoiceDate") return compareText(formatInvoiceDate(a.invoiceDate), formatInvoiceDate(b.invoiceDate));
  if (field === "uploadedAt") return compareText(a.uploadedAt, b.uploadedAt);
  return compareText(a[field], b[field]);
}

function compareText(a, b) {
  return String(a || "").localeCompare(String(b || ""), "zh-CN", { numeric: true, sensitivity: "base" });
}

function isLongText(value) {
  const text = String(value || "");
  return text.length > 14 || /[^\x00-\xff]/.test(text) && text.length > 8;
}

function hasAmount(doc) {
  return doc.amount !== null && doc.amount !== undefined && !Number.isNaN(Number(doc.amount));
}

function displayAmount(doc) {
  return hasAmount(doc) ? `¥${money(doc.amount)}` : "未识别";
}

function flattenMergedItems(doc) {
  if (doc.mergedItems?.length) return doc.mergedItems;
  return [
    {
      id: doc.id,
      name: doc.name,
      amount: doc.amount,
      invoiceNo: doc.invoiceNo,
      invoiceDate: doc.invoiceDate,
      note: doc.note,
      pageCount: doc.pageCount,
      size: doc.size,
      uploadedAt: doc.uploadedAt,
      fileBlob: doc.fileBlob,
      fileHash: doc.fileHash || null,
    },
  ];
}

function uniqueValues(values) {
  return [...new Set(values.map((value) => String(value || "").trim()).filter(Boolean))];
}

function collectKnownInvoiceNos(docs) {
  const known = new Set();
  const push = (value) => {
    // 合并单据的发票号是 " / " 连接的，拆开逐个记录
    String(value || "")
      .split("/")
      .map((part) => part.trim())
      .filter(Boolean)
      .forEach((no) => known.add(no));
  };
  for (const doc of docs) {
    push(doc.invoiceNo);
    for (const item of doc.mergedItems || []) push(item.invoiceNo);
  }
  return known;
}

async function hashBlob(blob) {
  const digest = await crypto.subtle.digest("SHA-256", await blob.arrayBuffer());
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

// 收集库内全部文件哈希；旧数据没存过哈希的现算并回填，之后同步就不用重复计算
async function collectKnownFileHashes(docs) {
  const hashes = new Set();
  for (const doc of docs) {
    const changes = {};
    if (doc.fileBlob) {
      if (!doc.fileHash) {
        doc.fileHash = await hashBlob(doc.fileBlob);
        changes.fileHash = doc.fileHash;
      }
      hashes.add(doc.fileHash);
    }
    if (doc.mergedItems?.length) {
      let itemsChanged = false;
      for (const item of doc.mergedItems) {
        if (!item.fileBlob) continue;
        if (!item.fileHash) {
          item.fileHash = await hashBlob(item.fileBlob);
          itemsChanged = true;
        }
        hashes.add(item.fileHash);
      }
      if (itemsChanged) changes.mergedItems = doc.mergedItems;
    }
    if (Object.keys(changes).length > 0) await updateDocument(doc.id, changes);
  }
  return hashes;
}

function mergedSearchText(doc) {
  if (!doc.mergedItems?.length) return "";
  return doc.mergedItems
    .map((item) => [item.name, item.invoiceNo, item.note, formatInvoiceDate(item.invoiceDate), money(item.amount)].join(" "))
    .join(" ");
}

function getPreviewItemKey(item, index) {
  return item.id || `${item.name || "item"}_${index}`;
}

function getDocumentFieldEditValue(doc, field) {
  if (field === "amount") return money(doc.amount);
  if (field === "invoiceDate") return formatInvoiceDate(doc.invoiceDate);
  if (field === "note") return doc.note || "";
  return doc.invoiceNo || "";
}

function getDocumentFieldChange(field, value) {
  const next = String(value ?? "").trim();
  if (field === "amount") {
    if (!next) return { amount: null };
    const amount = Number(next);
    if (Number.isNaN(amount)) return null;
    return { amount: Math.round(amount * 100) / 100 };
  }
  if (field === "invoiceDate") {
    return { invoiceDate: formatInvoiceDate(next) || next };
  }
  if (field === "invoiceNo") {
    return { invoiceNo: next };
  }
  if (field === "note") {
    return { note: next };
  }
  return null;
}

function PreferencesDialog({ theme, onThemeChange, canMailSync, onOpenMailSettings, onClose }) {
  return (
    <div className="modalBackdrop">
      <div className="dialog preferencesDialog">
        <div className="dialogHeader">
          <strong>偏好设置</strong>
          <button type="button" onClick={onClose}><X size={18} /></button>
        </div>
        <div className="preferenceSection">
          <div>
            <strong>外观主题</strong>
            <span>选择应用界面的颜色风格</span>
          </div>
          <div className="themeOptions">
            {themeOptions.map((option) => (
              <button
                type="button"
                key={option.value}
                className={`themeOption ${theme === option.value ? "active" : ""}`}
                onClick={() => onThemeChange(option.value)}
              >
                <span
                  className="themeSwatch"
                  style={{ background: `linear-gradient(135deg, ${option.colors[0]} 0 34%, ${option.colors[1]} 34% 67%, ${option.colors[2]} 67%)` }}
                />
                <span>
                  <strong>{option.label}</strong>
                  <em>{option.description}</em>
                </span>
              </button>
            ))}
          </div>
        </div>
        {canMailSync && (
          <div className="preferenceSection">
            <div>
              <strong>邮箱同步</strong>
              <span>配置 IMAP 邮箱，一键拉取并解析发票附件</span>
            </div>
            <button type="button" className="ghostButton" onClick={onOpenMailSettings}>
              <Mail size={17} />
              配置邮箱
            </button>
          </div>
        )}
        <div className="dialogActions">
          <button type="button" className="primaryButton" onClick={onClose}>完成</button>
        </div>
      </div>
    </div>
  );
}

function MailSettingsDialog({ onClose, onSaved }) {
  const [form, setForm] = useState(null);
  const [authCode, setAuthCode] = useState("");
  const [hasAuth, setHasAuth] = useState(false);
  const [encryptionAvailable, setEncryptionAvailable] = useState(true);
  const [feedback, setFeedback] = useState(null);
  const [pending, setPending] = useState("");

  useEffect(() => {
    window.desktopApi.loadMailConfig().then((config) => {
      setForm({
        host: config?.host || "imap.qq.com",
        port: String(config?.port || 993),
        user: config?.user || "",
        folder: config?.folder || "INBOX",
        days: String(config?.days || 30),
        subjectKeyword: config?.subjectKeyword || "",
      });
      setHasAuth(Boolean(config?.hasAuth));
      setEncryptionAvailable(config?.encryptionAvailable !== false);
    });
  }, []);

  if (!form) return null;

  const update = (field) => (event) => setForm({ ...form, [field]: event.target.value });

  function normalizedForm() {
    return {
      host: form.host.trim() || "imap.qq.com",
      port: Number(form.port) || 993,
      user: form.user.trim(),
      folder: form.folder.trim() || "INBOX",
      days: Number(form.days) || 30,
      subjectKeyword: form.subjectKeyword.trim(),
    };
  }

  async function handleTest() {
    if (!form.user.trim()) {
      setFeedback({ kind: "error", text: "请填写邮箱账号" });
      return;
    }
    setPending("test");
    setFeedback({ kind: "info", text: "正在连接…" });
    try {
      const result = await window.desktopApi.testMailConnection({
        ...normalizedForm(),
        authCode: authCode.trim() || undefined,
      });
      setFeedback(
        result.ok
          ? { kind: "ok", text: `连接成功，「${form.folder.trim() || "INBOX"}」共 ${result.exists} 封邮件` }
          : { kind: "error", text: `连接失败：${result.error}` }
      );
    } catch (error) {
      setFeedback({ kind: "error", text: `连接失败：${error.message}` });
    } finally {
      setPending("");
    }
  }

  async function handleSubmit(event) {
    event.preventDefault();
    if (!form.user.trim()) {
      setFeedback({ kind: "error", text: "请填写邮箱账号" });
      return;
    }
    if (!hasAuth && !authCode.trim()) {
      setFeedback({ kind: "error", text: "请填写授权码" });
      return;
    }
    setPending("save");
    try {
      await window.desktopApi.saveMailConfig({
        ...normalizedForm(),
        authCode: authCode.trim() || undefined,
      });
      onSaved?.();
      onClose();
    } catch (error) {
      setFeedback({ kind: "error", text: `保存失败：${error.message}` });
      setPending("");
    }
  }

  return (
    <div className="modalBackdrop">
      <form className="dialog mailSettingsDialog" onSubmit={handleSubmit}>
        <div className="dialogHeader">
          <strong>邮箱同步设置</strong>
          <button type="button" onClick={onClose}><X size={18} /></button>
        </div>
        <div className="mailForm">
          <div className="mailFormRow">
            <label className="mailField">
              <span>IMAP 服务器</span>
              <input value={form.host} onChange={update("host")} placeholder="imap.qq.com" />
            </label>
            <label className="mailField">
              <span>端口（SSL）</span>
              <input value={form.port} onChange={update("port")} inputMode="numeric" placeholder="993" />
            </label>
          </div>
          <label className="mailField">
            <span>邮箱账号</span>
            <input value={form.user} onChange={update("user")} placeholder="example@qq.com" autoFocus />
          </label>
          <label className="mailField">
            <span>授权码</span>
            <input
              type="password"
              value={authCode}
              onChange={(event) => setAuthCode(event.target.value)}
              placeholder={hasAuth ? "已保存（留空则不修改）" : "在邮箱设置中生成的授权码"}
            />
          </label>
          <div className="mailFormRow">
            <label className="mailField">
              <span>同步文件夹</span>
              <input value={form.folder} onChange={update("folder")} placeholder="INBOX" />
            </label>
            <label className="mailField">
              <span>首次同步范围（天）</span>
              <input value={form.days} onChange={update("days")} inputMode="numeric" placeholder="30" />
            </label>
          </div>
          <label className="mailField">
            <span>仅同步主题包含（可选）</span>
            <input value={form.subjectKeyword} onChange={update("subjectKeyword")} placeholder="例如：发票；留空则同步全部附件邮件" />
          </label>
          <p className="mailHint">
            QQ 邮箱：网页版「设置 → 账号」开启 IMAP/SMTP 服务并生成授权码（不是登录密码）。
            {!encryptionAvailable && " 注意：当前系统不支持凭据加密，授权码将以明文保存在本机。"}
          </p>
          {feedback && <p className={`mailFeedback ${feedback.kind}`}>{feedback.text}</p>}
        </div>
        <div className="dialogActions">
          <button type="button" className="ghostButton" disabled={Boolean(pending)} onClick={handleTest}>
            {pending === "test" ? "连接中…" : "测试连接"}
          </button>
          <button type="submit" className="primaryButton" disabled={Boolean(pending)}>
            {pending === "save" ? "保存中…" : "保存"}
          </button>
        </div>
      </form>
    </div>
  );
}

function EditDialog({ dialog, onClose, onSave }) {
  const [value, setValue] = useState(dialog.value || "");
  if (dialog.type === "confirm") {
    return (
      <div className="modalBackdrop">
        <div className="dialog">
          <div className="dialogHeader">
            <strong>{dialog.title}</strong>
            <button type="button" onClick={onClose}><X size={18} /></button>
          </div>
          <p className="dialogMessage">{dialog.message}</p>
          <div className="dialogActions">
            <button type="button" className="ghostButton" onClick={onClose}>取消</button>
            <button type="button" className="dangerButton" onClick={dialog.onConfirm}>{dialog.actionLabel || "确认"}</button>
          </div>
        </div>
      </div>
    );
  }

  const title = dialog.type === "documentField" ? `修改${documentFieldLabels[dialog.field]}` : dialog.type === "merge" ? "合并单据" : dialog.mode === "rename" ? "重命名报销" : "新建报销";
  const inputType = dialog.type === "documentField" ? documentFieldInputTypes[dialog.field] : "text";

  return (
    <div className="modalBackdrop">
      <form className="dialog" onSubmit={(event) => { event.preventDefault(); onSave(value); }}>
        <div className="dialogHeader">
          <strong>{title}</strong>
          <button type="button" onClick={onClose}><X size={18} /></button>
        </div>
        <input
          autoFocus
          type={inputType}
          step={dialog.field === "amount" ? "0.01" : undefined}
          value={value}
          onChange={(event) => setValue(event.target.value)}
        />
        <div className="dialogActions">
          <button type="button" className="ghostButton" onClick={onClose}>取消</button>
          <button type="submit" className="primaryButton">保存</button>
        </div>
      </form>
    </div>
  );
}

function PreviewModal({ preview, onClose }) {
  const previewItems = useMemo(() => {
    const items = preview.doc.mergedItems?.length ? preview.doc.mergedItems : [preview.doc];
    return items.map((item, index) => ({
      ...item,
      previewKey: getPreviewItemKey(item, index),
    }));
  }, [preview.doc]);
  const [selectedKey, setSelectedKey] = useState(() => previewItems[0]?.previewKey || "");

  useEffect(() => {
    setSelectedKey(previewItems[0]?.previewKey || "");
  }, [preview.doc.id, previewItems[0]?.previewKey]);

  const currentItem = previewItems.find((item) => item.previewKey === selectedKey) || previewItems[0] || preview.doc;
  const currentIndex = previewItems.findIndex((item) => item.previewKey === currentItem.previewKey);
  const [url, setUrl] = useState("");

  useEffect(() => {
    if (!currentItem?.fileBlob) {
      setUrl("");
      return;
    }

    const nextUrl = URL.createObjectURL(currentItem.fileBlob);
    setUrl(nextUrl);
    return () => URL.revokeObjectURL(nextUrl);
  }, [currentItem?.previewKey, currentItem?.fileBlob]);

  return (
    <div className="modalBackdrop previewBackdrop">
      <div className="previewModal">
        <div className="previewHeader">
          <div>
            <strong><EllipsisText value={preview.doc.name} /></strong>
            <span>
              {previewItems.length > 1
                ? `总计 ${displayAmount(preview.doc)} · 当前 ${displayAmount(currentItem)} · ${currentIndex + 1}/${previewItems.length}`
                : `${displayAmount(currentItem)} · ${formatInvoiceDate(currentItem.invoiceDate) || "未识别日期"}`}
            </span>
          </div>
          <button onClick={onClose}><X size={20} /></button>
        </div>
        <div className={`previewBody ${previewItems.length > 1 ? "" : "singlePreview"}`}>
          {previewItems.length > 1 && (
            <div className="mergedPreviewList">
              {previewItems.map((item, index) => (
                <button
                  type="button"
                  key={item.previewKey}
                  className={`mergedPreviewItem ${item.previewKey === selectedKey ? "active" : ""}`}
                  onClick={() => setSelectedKey(item.previewKey)}
                >
                  <span className="plainPreviewName">{index + 1}. {item.name}</span>
                  <em>{displayAmount(item)}</em>
                </button>
              ))}
            </div>
          )}
          {url ? <iframe title={currentItem.name || preview.doc.name} src={url}></iframe> : <div className="emptyPreview">没有可预览的 PDF</div>}
        </div>
      </div>
    </div>
  );
}

function MoveDialog({ docs, reimbursements, activeId, onClose, onMove }) {
  const [targetId, setTargetId] = useState("");
  const [createName, setCreateName] = useState("");
  const [moving, setMoving] = useState(false);
  const others = reimbursements.filter((item) => item.id !== activeId);
  const targetItem = others.find((item) => item.id === targetId) || null;
  const canSubmit = Boolean(targetItem || createName.trim());

  async function handleSubmit(event) {
    event.preventDefault();
    if (!canSubmit || moving) return;
    setMoving(true);
    try {
      await onMove(targetItem ? { id: targetItem.id, name: targetItem.name } : { createName: createName.trim() });
    } finally {
      setMoving(false);
    }
  }

  return (
    <div className="modalBackdrop">
      <form className="dialog moveDialog" onSubmit={handleSubmit}>
        <div className="dialogHeader">
          <strong>移动 {docs.length} 张单据</strong>
          <button type="button" onClick={onClose}><X size={18} /></button>
        </div>
        {others.length > 0 ? (
          <div className="moveList">
            {others.map((item) => (
              <button
                type="button"
                key={item.id}
                className={`moveOption ${item.id === targetId ? "active" : ""}`}
                onClick={() => {
                  setTargetId(item.id === targetId ? "" : item.id);
                  setCreateName("");
                }}
              >
                <span><EllipsisText value={item.name} /></span>
                <em>{item.documentCount} 张 / {money(item.totalAmount)} 元</em>
              </button>
            ))}
          </div>
        ) : (
          <p className="dialogMessage">还没有其他报销，可以直接新建一个并移入：</p>
        )}
        <div className="moveDivider">或新建报销并移入</div>
        <input
          type="text"
          placeholder="新报销名称"
          value={createName}
          onChange={(event) => {
            setCreateName(event.target.value);
            if (event.target.value.trim()) setTargetId("");
          }}
        />
        <div className="dialogActions">
          <button type="button" className="ghostButton" onClick={onClose}>取消</button>
          <button type="submit" className="primaryButton" disabled={!canSubmit || moving}>
            {moving ? "移动中…" : "移动"}
          </button>
        </div>
      </form>
    </div>
  );
}

function Toast({ value, onClose }) {
  useEffect(() => {
    const timer = setTimeout(onClose, 3200);
    return () => clearTimeout(timer);
  }, [onClose]);

  return <div className="toast">{value}</div>;
}
