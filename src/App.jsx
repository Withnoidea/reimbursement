import { useEffect, useMemo, useRef, useState } from "react";
import {
  Archive,
  Download,
  Eye,
  FileText,
  FolderInput,
  FolderOpen,
  Home,
  Inbox,
  Mail,
  MoreHorizontal,
  Pencil,
  Plus,
  ReceiptText,
  RefreshCw,
  RotateCcw,
  Search,
  Settings,
  Trash2,
  Ungroup,
  Upload,
  WalletCards,
  Wand2,
  X,
} from "lucide-react";
import {
  addDocument,
  createReimbursement,
  deleteDocuments,
  deleteReimbursement,
  INBOX_ID,
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
  const [view, setView] = useState("home");
  const [inboxDocs, setInboxDocs] = useState([]);
  const [inboxSelectedIds, setInboxSelectedIds] = useState(new Set());
  const [allDocs, setAllDocs] = useState([]);

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
    refreshInbox();
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
        setDialog({ type: "reimbursement", mode: "create" });
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

  useEffect(() => {
    if (view !== "home") return;
    let cancelled = false;
    listAllDocuments().then((docs) => {
      if (!cancelled) setAllDocs(docs);
    });
    return () => {
      cancelled = true;
    };
  }, [view, reimbursements, inboxDocs]);

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

  async function refreshInbox() {
    setInboxDocs(await listDocuments(INBOX_ID));
    setInboxSelectedIds(new Set());
  }

  async function handleSaveReimbursement(values, mode) {
    const name = String(values.name || "").trim();
    if (!name) return;
    let { periodStart = "", periodEnd = "" } = values;
    if (periodStart && periodEnd && periodStart > periodEnd) {
      [periodStart, periodEnd] = [periodEnd, periodStart];
    }
    if (mode === "rename" && active) {
      await updateReimbursement(active.id, { name, periodStart, periodEnd });
      await refreshReimbursements(active.id);
    } else {
      const item = await createReimbursement(name, { periodStart, periodEnd });
      await refreshReimbursements(item.id);
      setView("reimbursement");
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
    let outOfPeriod = 0;
    for (const file of pdfs) {
      try {
        const parsed = await parseWithBestAvailableParser(file);
        if (isOutsidePeriod(active, parsed.invoiceDate)) outOfPeriod += 1;
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
    const periodWarning = outOfPeriod > 0 ? `，注意：${outOfPeriod} 张开票日期不在报销周期内` : "";
    setToast(failures.length > 0 ? `部分文件失败：${failures.join("；")}` : `已导入 ${pdfs.length} 个 PDF${periodWarning}`);
  }

  async function handleEditField(doc, field) {
    setDialog({ type: "documentField", field, doc, value: getDocumentFieldEditValue(doc, field) });
  }

  async function handleMailSync({ full = false } = {}) {
    if (!canMailSync || busy) return;

    const config = await window.desktopApi.loadMailConfig();
    if (!config?.user || !config?.hasAuth) {
      setDialog({ type: "mailSettings" });
      setToast("请先配置邮箱账号和授权码");
      return;
    }

    const stateKey = `mail-sync-state:${config.user}@${config.host}/${config.folder}`;
    let syncState = null;
    if (!full) {
      try {
        syncState = JSON.parse(localStorage.getItem(stateKey) || "null");
      } catch {
        syncState = null;
      }
    }

    mailSyncingRef.current = true;
    setBusy(full ? "正在重新拉取全部邮件…" : "正在连接邮箱…");
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
          reimbursementId: INBOX_ID,
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
          sourceSubject: item.subject || "",
          sourceDate: item.sourceDate || "",
        });
        added += 1;
      }

      localStorage.setItem(stateKey, JSON.stringify(result.newState));
      await refreshInbox();
      setView("inbox");

      const rangeText = result.stats.sinceDate
        ? `扫描 ${result.stats.scanned} 封邮件（${result.stats.sinceDate} 以来）`
        : `扫描 ${result.stats.scanned} 封上次同步后的新邮件`;
      const parts = [rangeText];
      if (added > 0) parts.push(`新收 ${added} 张发票待分配`);
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
    const targetItem = reimbursements.find((item) => item.id === targetId) || null;
    let outOfPeriod = 0;
    for (const doc of docs) {
      if (isOutsidePeriod(targetItem, doc.invoiceDate)) outOfPeriod += 1;
      await updateDocument(doc.id, { reimbursementId: targetId });
    }
    await refreshDocuments(activeId);
    await refreshReimbursements(activeId);
    await refreshInbox();
    setDialog(null);
    const periodWarning = outOfPeriod > 0 ? `，注意：${outOfPeriod} 张开票日期不在其周期内` : "";
    setToast(`已移动 ${docs.length} 张单据到「${targetName}」${periodWarning}`);
  }

  function toggleInboxSelect(id) {
    const next = new Set(inboxSelectedIds);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    setInboxSelectedIds(next);
  }

  function toggleInboxSelectAll() {
    const allSelected = inboxDocs.length > 0 && inboxDocs.every((doc) => inboxSelectedIds.has(doc.id));
    setInboxSelectedIds(allSelected ? new Set() : new Set(inboxDocs.map((doc) => doc.id)));
  }

  function handleMoveInboxDocs(docs) {
    if (docs.length === 0) return;
    setDialog({ type: "moveDocuments", docs });
  }

  async function autoAssignInboxDocs() {
    const docs = inboxSelectedIds.size > 0 ? inboxDocs.filter((doc) => inboxSelectedIds.has(doc.id)) : inboxDocs;
    const withPeriod = reimbursements.filter((item) => item.periodStart || item.periodEnd);
    if (docs.length === 0) return;
    if (withPeriod.length === 0) {
      setToast("没有报销设置了时间周期，先在新建/重命名里填写周期");
      return;
    }
    let assigned = 0;
    let skipped = 0;
    const assignedNames = new Map();
    for (const doc of docs) {
      const matches = matchReimbursementsByDate(withPeriod, doc.invoiceDate);
      if (matches.length !== 1) {
        skipped += 1;
        continue;
      }
      await updateDocument(doc.id, { reimbursementId: matches[0].id });
      assigned += 1;
      assignedNames.set(matches[0].name, (assignedNames.get(matches[0].name) || 0) + 1);
    }
    await refreshDocuments(activeId);
    await refreshReimbursements(activeId);
    await refreshInbox();
    if (assigned === 0) {
      setToast("没有可自动分配的发票（缺少开票日期，或没有唯一匹配周期的报销）");
      return;
    }
    const detail = [...assignedNames.entries()].map(([name, count]) => `「${name}」${count} 张`).join("，");
    setToast(`已自动分配 ${assigned} 张：${detail}${skipped > 0 ? `；${skipped} 张无法判断需手动移动` : ""}`);
  }

  function handleDeleteInboxDocs() {
    const ids = [...inboxSelectedIds];
    if (ids.length === 0) return;
    setDialog({
      type: "confirm",
      title: "删除发票",
      message: `确定删除待分配的 ${ids.length} 张发票吗？删除后可用「全部重新拉取」从邮箱找回。`,
      actionLabel: "删除",
      onConfirm: async () => {
        await deleteDocuments(ids);
        await refreshInbox();
        setDialog(null);
        setToast("已删除");
      },
    });
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

        <button
          className={`syncNavButton ${view === "home" ? "active" : ""}`}
          onClick={() => setView("home")}
        >
          <span className="navIcon">
            <Home size={18} />
          </span>
          <span className="navText">
            <strong>首页</strong>
            <em>数据总览与邮箱同步</em>
          </span>
          {inboxDocs.length > 0 && <span className="syncBadge">{inboxDocs.length}</span>}
        </button>

        <button className="primaryButton full" onClick={() => setDialog({ type: "reimbursement", mode: "create" })}>
          <Plus size={17} />
          新建报销
        </button>

        <div className="navList">
          {reimbursements.map((item) => (
            <div
              key={item.id}
              className={`navItem ${view === "reimbursement" && item.id === activeId ? "active" : ""}`}
            >
              <button
                className="navSelect"
                onClick={() => {
                  setActiveId(item.id);
                  setView("reimbursement");
                }}
              >
                <span className="navIcon">
                  <ReceiptText size={18} />
                </span>
                <span className="navText">
                  <strong>{item.name}</strong>
                  <em>{item.documentCount} 张 / {money(item.totalAmount)} 元</em>
                  {formatPeriod(item) && <em>{formatPeriod(item)}</em>}
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
        {view === "home" ? (
          <DashboardWorkspace
            reimbursements={reimbursements}
            docs={allDocs.filter((doc) => doc.reimbursementId !== INBOX_ID)}
            inboxCount={inboxDocs.length}
            busy={busy}
            canMailSync={canMailSync}
            onSync={() => handleMailSync()}
            onFullSync={() => handleMailSync({ full: true })}
            onOpenSettings={() => setDialog({ type: "mailSettings" })}
            onOpenInbox={() => setView("inbox")}
            onOpenReimbursement={(id) => {
              setActiveId(id);
              setView("reimbursement");
            }}
          />
        ) : view === "inbox" ? (
          <InboxWorkspace
            docs={inboxDocs}
            selectedIds={inboxSelectedIds}
            busy={busy}
            hasPeriods={reimbursements.some((item) => item.periodStart || item.periodEnd)}
            onToggle={toggleInboxSelect}
            onToggleAll={toggleInboxSelectAll}
            onSync={() => handleMailSync()}
            onFullSync={() => handleMailSync({ full: true })}
            onOpenSettings={() => setDialog({ type: "mailSettings" })}
            onMove={handleMoveInboxDocs}
            onAutoAssign={autoAssignInboxDocs}
            onDelete={handleDeleteInboxDocs}
            onPreview={openPreview}
          />
        ) : (
          <>
        <header className="topbar">
          <div>
            <h1>{active?.name || "创建一个报销"}</h1>
            <p>
              {active
                ? `${documents.length} 张单据，合计 ${money(total)} 元${formatPeriod(active) ? ` · 周期 ${formatPeriod(active)}` : ""}`
                : "先创建报销，再上传 PDF 单据"}
            </p>
          </div>
          <div className="topActions">
            <button className="ghostButton" disabled={!active} onClick={() => setDialog({ type: "reimbursement", mode: "rename" })}>
              <Pencil size={17} />
              编辑
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
          </>
        )}
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
      {dialog?.type === "reimbursement" && (
        <ReimbursementDialog
          mode={dialog.mode}
          initial={dialog.mode === "rename" ? active : null}
          onClose={() => setDialog(null)}
          onSave={(values) => handleSaveReimbursement(values, dialog.mode)}
        />
      )}
      {dialog?.type === "moveDocuments" && (
        <MoveDialog
          docs={dialog.docs}
          reimbursements={reimbursements}
          activeId={view === "inbox" ? "" : activeId}
          onClose={() => setDialog(null)}
          onMove={(target) => moveDocumentsTo(dialog.docs, target)}
        />
      )}
      {dialog && !["preferences", "mailSettings", "moveDocuments", "reimbursement"].includes(dialog.type) && (
        <EditDialog
          dialog={dialog}
          onClose={() => setDialog(null)}
          onSave={(value) => {
            if (dialog.type === "documentField") saveDocumentField(value, dialog.doc, dialog.field);
            else if (dialog.type === "merge") saveMergedDocuments(value, dialog.docs);
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

function formatPeriod(item) {
  const start = item?.periodStart || "";
  const end = item?.periodEnd || "";
  if (!start && !end) return "";
  return `${start || "…"} ~ ${end || "…"}`;
}

// 有周期且日期可解析时才判断；日期为空/无周期一律视为不越界
function isOutsidePeriod(item, invoiceDate) {
  if (!item || (!item.periodStart && !item.periodEnd)) return false;
  const date = formatInvoiceDate(invoiceDate);
  if (!date) return false;
  if (item.periodStart && date < item.periodStart) return true;
  if (item.periodEnd && date > item.periodEnd) return true;
  return false;
}

function matchReimbursementsByDate(items, invoiceDate) {
  const date = formatInvoiceDate(invoiceDate);
  if (!date) return [];
  return items.filter(
    (item) => (!item.periodStart || date >= item.periodStart) && (!item.periodEnd || date <= item.periodEnd)
  );
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

function DashboardWorkspace({
  reimbursements,
  docs,
  inboxCount,
  busy,
  canMailSync,
  onSync,
  onFullSync,
  onOpenSettings,
  onOpenInbox,
  onOpenReimbursement,
}) {
  const totalAmount = reimbursements.reduce((sum, item) => sum + Number(item.totalAmount || 0), 0);
  const totalCount = reimbursements.reduce((sum, item) => sum + Number(item.documentCount || 0), 0);

  const months = useMemo(() => {
    const now = new Date();
    const list = [];
    for (let i = 5; i >= 0; i -= 1) {
      const date = new Date(now.getFullYear(), now.getMonth() - i, 1);
      list.push({
        key: `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}`,
        label: `${date.getMonth() + 1}月`,
        full: `${date.getFullYear()}年${date.getMonth() + 1}月`,
        amount: 0,
        count: 0,
      });
    }
    const index = new Map(list.map((month) => [month.key, month]));
    for (const doc of docs) {
      const date = formatInvoiceDate(doc.invoiceDate) || String(doc.uploadedAt || "").slice(0, 10);
      const month = index.get(date.slice(0, 7));
      if (!month) continue;
      month.amount += Number(doc.amount || 0);
      month.count += 1;
    }
    for (const month of list) month.amount = Math.round(month.amount * 100) / 100;
    return list;
  }, [docs]);

  const hasTrend = months.some((month) => month.count > 0);
  const topReimbursements = [...reimbursements]
    .sort((a, b) => Number(b.totalAmount || 0) - Number(a.totalAmount || 0))
    .slice(0, 6);
  const maxAmount = Math.max(...topReimbursements.map((item) => Number(item.totalAmount || 0)), 1);

  return (
    <>
      <header className="topbar">
        <div>
          <h1>首页</h1>
          <p>{reimbursements.length > 0 ? `${reimbursements.length} 个报销 · ${totalCount} 张单据` : "创建报销，或从邮箱同步发票开始"}</p>
        </div>
      </header>

      <div className="dashboard">
        <div className="statRow">
          <div className="statTile heroTile">
            <label>报销总金额</label>
            <strong>¥{money(totalAmount)}</strong>
          </div>
          <div className="statTile">
            <label>单据总数</label>
            <strong>{totalCount}</strong>
          </div>
          <div className="statTile">
            <label>报销个数</label>
            <strong>{reimbursements.length}</strong>
          </div>
          <button type="button" className="statTile clickable" onClick={onOpenInbox}>
            <label>待分配发票</label>
            <strong>{inboxCount}</strong>
          </button>
        </div>

        <div className={`dashRow ${canMailSync ? "" : "single"}`}>
          <section className="dashCard">
            <div className="dashCardHeader">
              <strong>近 6 个月单据金额</strong>
              <span>按开票日期统计</span>
            </div>
            {hasTrend ? (
              <MonthlyLineChart months={months} />
            ) : (
              <div className="chartEmpty">上传或同步发票后，这里会显示金额趋势</div>
            )}
          </section>

          {canMailSync && (
            <section className="dashCard syncCard">
              <div className="dashCardHeader">
                <strong>邮箱同步</strong>
                <button
                  type="button"
                  className="ghostButton iconOnlyButton"
                  title="邮箱同步设置"
                  disabled={Boolean(busy)}
                  onClick={onOpenSettings}
                >
                  <Settings size={17} />
                </button>
              </div>
              <p className="syncCardText">
                {inboxCount > 0 ? `有 ${inboxCount} 张发票待分配到报销` : "从邮箱拉取发票附件，自动识别金额、发票号和日期"}
              </p>
              <div className="syncCardActions">
                <button className="primaryButton" disabled={Boolean(busy)} onClick={onSync}>
                  <RefreshCw size={17} />
                  同步邮箱
                </button>
                <button className="ghostButton" disabled={Boolean(busy)} onClick={onOpenInbox}>
                  <Inbox size={17} />
                  查看待分配{inboxCount > 0 ? `（${inboxCount}）` : ""}
                </button>
                <button
                  className="ghostButton"
                  disabled={Boolean(busy)}
                  title="忽略同步进度，重新拉取时间范围内的全部邮件；已有发票自动去重"
                  onClick={onFullSync}
                >
                  <RotateCcw size={17} />
                  全部重新拉取
                </button>
              </div>
            </section>
          )}
        </div>

        <section className="dashCard">
          <div className="dashCardHeader">
            <strong>各报销金额对比</strong>
            <span>点击进入对应报销</span>
          </div>
          {topReimbursements.length > 0 ? (
            <div className="barList">
              {topReimbursements.map((item) => (
                <button type="button" key={item.id} className="barRow" onClick={() => onOpenReimbursement(item.id)}>
                  <span className="barName" title={item.name}>{item.name}</span>
                  <span className="barTrack">
                    <span
                      className="barFill"
                      style={{
                        width: `${Math.max((Number(item.totalAmount || 0) / maxAmount) * 100, Number(item.totalAmount || 0) > 0 ? 2 : 0)}%`,
                      }}
                    />
                  </span>
                  <span className="barValue">¥{money(item.totalAmount || 0)}</span>
                </button>
              ))}
            </div>
          ) : (
            <div className="chartEmpty">还没有报销，点击左侧「新建报销」创建一个</div>
          )}
        </section>
      </div>
    </>
  );
}

function MonthlyLineChart({ months }) {
  const [hoverIdx, setHoverIdx] = useState(null);
  const VB_W = 640;
  const VB_H = 230;
  const padL = 56;
  const padR = 20;
  const padT = 18;
  const padB = 30;
  const innerW = VB_W - padL - padR;
  const innerH = VB_H - padT - padB;

  const maxValue = niceCeil(Math.max(...months.map((month) => month.amount), 1));
  const xAt = (i) => padL + (months.length <= 1 ? innerW / 2 : (i * innerW) / (months.length - 1));
  const yAt = (value) => padT + innerH * (1 - value / maxValue);
  const points = months.map((month, i) => [xAt(i), yAt(month.amount)]);
  const linePath = points.map(([x, y], i) => `${i === 0 ? "M" : "L"}${x.toFixed(1)},${y.toFixed(1)}`).join(" ");
  const baseY = (padT + innerH).toFixed(1);
  const areaPath = `${linePath} L${points[points.length - 1][0].toFixed(1)},${baseY} L${points[0][0].toFixed(1)},${baseY} Z`;
  const ticks = [0, maxValue / 2, maxValue];
  const lastIdx = months.length - 1;
  const hover = hoverIdx === null ? null : { ...months[hoverIdx], x: points[hoverIdx][0], y: points[hoverIdx][1] };

  function handlePointerMove(event) {
    const rect = event.currentTarget.getBoundingClientRect();
    const x = ((event.clientX - rect.left) / rect.width) * VB_W;
    let nearest = 0;
    let best = Infinity;
    points.forEach(([px], i) => {
      const distance = Math.abs(px - x);
      if (distance < best) {
        best = distance;
        nearest = i;
      }
    });
    setHoverIdx(nearest);
  }

  return (
    <div className="chartWrap">
      {hover && (
        <div className="chartTip" style={{ left: `${Math.min(86, Math.max(14, (hover.x / VB_W) * 100))}%` }}>
          <span className="chartTipKey" />
          <strong>¥{money(hover.amount)}</strong>
          <span>{hover.full} · {hover.count} 张</span>
        </div>
      )}
      <svg
        className="lineChart"
        viewBox={`0 0 ${VB_W} ${VB_H}`}
        role="img"
        aria-label="近 6 个月单据金额趋势"
        onPointerMove={handlePointerMove}
        onPointerLeave={() => setHoverIdx(null)}
      >
        {ticks.map((tick) => (
          <g key={tick}>
            <line className="chartGrid" x1={padL} x2={VB_W - padR} y1={yAt(tick)} y2={yAt(tick)} />
            <text className="chartTickLabel" x={padL - 8} y={yAt(tick) + 4} textAnchor="end">
              {Math.round(tick).toLocaleString("zh-CN")}
            </text>
          </g>
        ))}
        {months.map((month, i) => (
          <text key={month.key} className="chartTickLabel" x={xAt(i)} y={VB_H - 8} textAnchor="middle">
            {month.label}
          </text>
        ))}
        <path className="chartArea" d={areaPath} />
        <path className="chartLine" d={linePath} />
        {hover && <line className="chartCrosshair" x1={hover.x} x2={hover.x} y1={padT} y2={padT + innerH} />}
        {points.map(([x, y], i) => {
          if (i !== lastIdx && i !== hoverIdx) return null;
          return <circle key={months[i].key} className="chartDot" cx={x} cy={y} r={4.5} />;
        })}
        <text
          className="chartEndLabel"
          x={points[lastIdx][0] - 4}
          y={Math.max(points[lastIdx][1] - 10, 12)}
          textAnchor="end"
        >
          ¥{money(months[lastIdx].amount)}
        </text>
      </svg>
    </div>
  );
}

function niceCeil(value) {
  if (value <= 0) return 1;
  const exp = 10 ** Math.floor(Math.log10(value));
  const fraction = value / exp;
  const nice = fraction <= 1 ? 1 : fraction <= 2 ? 2 : fraction <= 2.5 ? 2.5 : fraction <= 5 ? 5 : 10;
  return nice * exp;
}

function InboxWorkspace({
  docs,
  selectedIds,
  busy,
  hasPeriods,
  onToggle,
  onToggleAll,
  onSync,
  onFullSync,
  onOpenSettings,
  onMove,
  onAutoAssign,
  onDelete,
  onPreview,
}) {
  const selectedDocs = docs.filter((doc) => selectedIds.has(doc.id));
  const selectedCount = selectedDocs.length;
  const totalAmount = docs.reduce((sum, doc) => sum + Number(doc.amount || 0), 0);

  return (
    <>
      <header className="topbar">
        <div>
          <h1>邮箱同步</h1>
          <p>
            {docs.length > 0
              ? `${docs.length} 张发票待分配，合计 ${money(totalAmount)} 元 · 移动到报销后参与统计`
              : "从邮箱拉取发票附件，在这里分配到各个报销"}
          </p>
        </div>
        <div className="topActions">
          <button
            className="ghostButton iconOnlyButton"
            title="邮箱同步设置"
            disabled={Boolean(busy)}
            onClick={onOpenSettings}
          >
            <Settings size={17} />
          </button>
          <button
            className="ghostButton"
            title="忽略同步进度，重新拉取时间范围内的全部邮件；已有的发票会自动去重，删除过的会找回"
            disabled={Boolean(busy)}
            onClick={onFullSync}
          >
            <RotateCcw size={17} />
            全部重新拉取
          </button>
          <button className="primaryButton" disabled={Boolean(busy)} onClick={onSync}>
            <RefreshCw size={17} />
            同步邮箱
          </button>
        </div>
      </header>

      <section className="panel inboxPanel">
        <div className="panelToolbar">
          <div className="inboxHint">
            {selectedCount > 0 ? `已选 ${selectedCount} 张，合计 ¥${money(selectedDocs.reduce((sum, doc) => sum + Number(doc.amount || 0), 0))}` : "选中发票后移动到对应报销"}
          </div>
          <div className="tableActions">
            <button className="ghostButton" disabled={selectedCount === 0} onClick={() => onMove(selectedDocs)}>
              <FolderInput size={17} />
              移动到报销
            </button>
            <button
              className="ghostButton"
              disabled={docs.length === 0}
              title={hasPeriods ? "按开票日期匹配各报销的时间周期自动分配（选中则只分配选中的）" : "先给报销设置时间周期后可用"}
              onClick={onAutoAssign}
            >
              <Wand2 size={17} />
              按周期自动分配
            </button>
            <button className="dangerButton" disabled={selectedCount === 0} onClick={onDelete}>
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
                    title="全选"
                    disabled={docs.length === 0}
                    checked={docs.length > 0 && docs.every((doc) => selectedIds.has(doc.id))}
                    ref={(el) => {
                      if (!el) return;
                      el.indeterminate = selectedCount > 0 && selectedCount < docs.length;
                    }}
                    onChange={onToggleAll}
                  />
                </th>
                <th>发票</th>
                <th>金额</th>
                <th>开票日期</th>
                <th>来源邮件</th>
                <th>邮件日期</th>
                <th className="actionCol"></th>
              </tr>
            </thead>
            <tbody>
              {docs.map((doc) => (
                <tr key={doc.id} className={selectedIds.has(doc.id) ? "selectedRow" : ""}>
                  <td>
                    <input type="checkbox" checked={selectedIds.has(doc.id)} onChange={() => onToggle(doc.id)} />
                  </td>
                  <td>
                    <div className="fileCell">
                      <FileText size={19} />
                      <div>
                        <strong>
                          <EllipsisText value={doc.name} />
                        </strong>
                        <span>{formatBytes(doc.size)} · {doc.pageCount || 1} 页</span>
                      </div>
                    </div>
                  </td>
                  <td className="amountCell">{displayAmount(doc)}</td>
                  <td>{formatInvoiceDate(doc.invoiceDate) || "未识别"}</td>
                  <td>
                    <EllipsisText value={doc.sourceSubject} emptyText="-" />
                  </td>
                  <td>
                    <EllipsisText value={doc.sourceDate ? formatDateTime(doc.sourceDate) : ""} emptyText="-" />
                  </td>
                  <td>
                    <div className="rowActions">
                      <button title="预览" onClick={() => onPreview(doc)}><Eye size={16} /></button>
                      <button title="移动到报销" onClick={() => onMove([doc])}><FolderInput size={16} /></button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>

          {docs.length === 0 && (
            <div className="emptyState">
              <Inbox size={32} />
              <strong>还没有待分配的发票</strong>
              <span>点击右上角「同步邮箱」拉取邮箱里的发票附件</span>
            </div>
          )}
        </div>
      </section>
    </>
  );
}

function ReimbursementDialog({ mode, initial, onClose, onSave }) {
  const [name, setName] = useState(initial?.name || "");
  const [periodStart, setPeriodStart] = useState(initial?.periodStart || "");
  const [periodEnd, setPeriodEnd] = useState(initial?.periodEnd || "");

  return (
    <div className="modalBackdrop">
      <form
        className="dialog"
        onSubmit={(event) => {
          event.preventDefault();
          onSave({ name, periodStart, periodEnd });
        }}
      >
        <div className="dialogHeader">
          <strong>{mode === "rename" ? "编辑报销" : "新建报销"}</strong>
          <button type="button" onClick={onClose}><X size={18} /></button>
        </div>
        <label className="mailField">
          <span>名称</span>
          <input autoFocus value={name} onChange={(event) => setName(event.target.value)} placeholder="例如：2026年7月差旅" />
        </label>
        <div className="mailFormRow">
          <label className="mailField">
            <span>周期开始（可选）</span>
            <input type="date" value={periodStart} onChange={(event) => setPeriodStart(event.target.value)} />
          </label>
          <label className="mailField">
            <span>周期结束（可选）</span>
            <input type="date" value={periodEnd} onChange={(event) => setPeriodEnd(event.target.value)} />
          </label>
        </div>
        <p className="mailHint">设置周期后，导入或移入开票日期不在周期内的发票会提示；邮箱同步页可按周期自动分配。</p>
        <div className="dialogActions">
          <button type="button" className="ghostButton" onClick={onClose}>取消</button>
          <button type="submit" className="primaryButton">保存</button>
        </div>
      </form>
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
