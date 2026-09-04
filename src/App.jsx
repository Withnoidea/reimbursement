import { useEffect, useMemo, useRef, useState } from "react";
import {
  Archive,
  ArrowLeft,
  ChevronRight,
  Download,
  Eye,
  FileText,
  FolderInput,
  FolderOpen,
  Home,
  Inbox,
  Mail,
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
import {
  getReimbursementStatusMeta,
  isReimbursementReceived,
  normalizeReimbursementStatus,
  REIMBURSEMENT_STATUSES,
  todayDateValue,
} from "./reimbursementStatus.js";

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
  { value: "ledger", label: "账册蓝", description: "冷白票据纸与沉静账册蓝，适合长时间整理", colors: ["#e8eef0", "#2d6470", "#f3f6f7"] },
  { value: "paper", label: "纸墨灰", description: "中性纸面与松烟灰，减少颜色干扰", colors: ["#e9ebe7", "#53675d", "#f4f5f2"] },
  { value: "night", label: "夜间账台", description: "深墨底色与低饱和青色，适合夜间核对", colors: ["#0a1013", "#73b9aa", "#11191d"] },
];

function getInitialTheme() {
  const saved = localStorage.getItem("reimbursement-theme");
  return themeOptions.some((option) => option.value === saved) ? saved : "ledger";
}

export default function App() {
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
  const [sortConfig, setSortConfig] = useState({ field: "uploadedAt", direction: "desc" });
  const [theme, setTheme] = useState(getInitialTheme);
  const [view, setView] = useState("home");
  const [reimbursementFilter, setReimbursementFilter] = useState("all");
  const [inboxDocs, setInboxDocs] = useState([]);
  const [inboxSelectedIds, setInboxSelectedIds] = useState(new Set());
  const [allDocs, setAllDocs] = useState([]);
  const [updateState, setUpdateState] = useState(null);
  const [updateCheckRequested, setUpdateCheckRequested] = useState(0);

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
      if (action === "check-updates") {
        setDialog({ type: "preferences" });
        setUpdateCheckRequested((n) => n + 1);
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
    if (!window.desktopApi?.onUpdaterState) return undefined;
    return window.desktopApi.onUpdaterState((next) => setUpdateState(next || null));
  }, []);

  useEffect(() => {
    if (updateState?.status !== "downloaded") return;
    setDialog((current) => (current ? current : { type: "updateReady", version: updateState.version }));
  }, [updateState?.status, updateState?.version]);

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

  function openReimbursements(status = "all") {
    setReimbursementFilter(status);
    setView("reimbursements");
  }

  function openReimbursement(id) {
    setActiveId(id);
    setView("reimbursement");
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
    const status = normalizeReimbursementStatus(values.status);
    const receivedAt = status === "received" ? values.receivedAt || todayDateValue() : "";
    if (periodStart && periodEnd && periodStart > periodEnd) {
      [periodStart, periodEnd] = [periodEnd, periodStart];
    }
    if (mode === "rename" && active) {
      await updateReimbursement(active.id, { name, periodStart, periodEnd, status, receivedAt });
      await refreshReimbursements(active.id);
    } else {
      const item = await createReimbursement(name, { periodStart, periodEnd, status, receivedAt });
      await refreshReimbursements(item.id);
      setView("reimbursement");
    }
    setDialog(null);
    setToast(status === "received" ? "报销已保存并计入到账统计" : "报销信息已保存");
  }

  async function handleReimbursementStatusChange(target, nextStatus) {
    if (!target) return;
    const status = normalizeReimbursementStatus(nextStatus);
    const receivedAt = status === "received" ? target.receivedAt || todayDateValue() : "";
    await updateReimbursement(target.id, { status, receivedAt });
    await refreshReimbursements(target.id);
    const statusMeta = getReimbursementStatusMeta(status);
    setToast(status === "received" ? `“${target.name}”已标记到账并计入统计` : `“${target.name}”已更新为${statusMeta.label}`);
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
        if (target.id === activeId) openReimbursements();
        setDialog(null);
        setToast("已删除报销");
      },
    });
  }

  // target 为报销对象时直接归入该报销；为 null 时落进发票箱，之后由发票箱分配。
  async function handleFiles(files, target) {
    const accepted = [...files].filter((file) => getFileKind(file) !== "");
    if (accepted.length === 0) {
      setToast("请选择 PDF 或图片单据");
      return;
    }

    setBusy(`正在识别 ${accepted.length} 个单据`);
    const failures = [];
    let outOfPeriod = 0;
    for (const file of accepted) {
      try {
        const parsed = await parseWithBestAvailableParser(file);
        if (target && isOutsidePeriod(target, parsed.invoiceDate)) outOfPeriod += 1;
        await addDocument({
          id: makeId("d"),
          reimbursementId: target ? target.id : INBOX_ID,
          name: file.name,
          fileType: getFileKind(file),
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
    if (target) {
      await refreshDocuments(target.id);
      await refreshReimbursements(target.id);
    } else {
      await refreshInbox();
    }

    if (failures.length > 0) {
      setToast(`部分文件失败：${failures.join("；")}`);
      return;
    }
    if (target) {
      const periodWarning = outOfPeriod > 0 ? `，注意：${outOfPeriod} 张开票日期不在报销周期内` : "";
      setToast(`已导入 ${accepted.length} 个单据${periodWarning}`);
    } else {
      setToast(`已导入 ${accepted.length} 个单据到发票箱，可在发票箱分配到报销`);
    }
  }

  async function handleEditField(doc, field) {
    setDialog({ type: "documentField", field, doc, value: getDocumentFieldEditValue(doc, field) });
  }

  async function handleMailSync({ full = false, startTime = "", endTime = "" } = {}) {
    if (!canMailSync || busy) return;

    const config = await window.desktopApi.loadMailConfig();
    if (!config?.user || !config?.hasAuth) {
      setDialog({ type: "mailSettings" });
      setToast("请先配置邮箱账号和授权码");
      return;
    }

    const stateKey = `mail-sync-state:${config.user}@${config.host}/${config.folder}`;
    const hasCustomRange = Boolean(startTime && endTime);
    let syncState = null;
    if (!full && !hasCustomRange) {
      try {
        syncState = JSON.parse(localStorage.getItem(stateKey) || "null");
      } catch {
        syncState = null;
      }
    }

    mailSyncingRef.current = true;
    setBusy(hasCustomRange ? "正在按指定时间段同步邮箱…" : full ? "正在重新拉取全部邮件…" : "正在连接邮箱…");
    try {
      const result = await window.desktopApi.syncMailbox({
        state: syncState,
        range: hasCustomRange ? { startTime, endTime } : null,
      });
      if (!result?.ok) {
        if (result?.needsConfig) setDialog({ type: "mailSettings" });
        setToast(`同步失败：${result?.error || "未知错误"}`);
        return;
      }

      const allDocs = await listAllDocuments();
      const known = collectKnownInvoiceNos(allDocs);
      const knownHashes = await collectKnownFileHashes(allDocs);
      let added = 0;
      const duplicates = [];
      for (const item of result.items) {
        const invoiceNo = String(item.invoiceNo || "").trim();
        const fileHash = item.fileHash || "";
        const existing = allDocs.find((doc) =>
          (invoiceNo && doc.invoiceNo === invoiceNo) || (fileHash && doc.fileHash === fileHash)
        );
        if (existing) {
          const target = reimbursements.find((r) => r.id === existing.reimbursementId);
          duplicates.push({
            name: item.fileName,
            location: target ? target.name : "发票箱",
          });
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
          fileType: item.mimeType && item.mimeType.startsWith("image/") ? "image" : "pdf",
          fileBlob: new Blob([item.data], { type: item.mimeType || "application/pdf" }),
          fileHash: fileHash || null,
          sourceSubject: item.subject || "",
          sourceDate: item.sourceDate || "",
        });
        added += 1;
      }

      if (result.newState && result.stats.mode !== "custom") {
        localStorage.setItem(stateKey, JSON.stringify(result.newState));
      }
      await refreshInbox();
      setView("inbox");

      const rangeText = result.stats.mode === "custom"
        ? `扫描 ${result.stats.scanned} 封邮件（${formatSyncRange(result.stats.startTime, result.stats.endTime)}）`
        : result.stats.sinceDate
          ? `扫描 ${result.stats.scanned} 封邮件（${result.stats.sinceDate} 以来）`
          : `扫描 ${result.stats.scanned} 封上次同步后的新邮件`;
      const parts = [rangeText];
      if (result.stats.mode === "incremental" && result.stats.rechecked > 0) {
        parts.push(`复查最近 ${result.stats.rechecked} 封邮件`);
      }
      if (added > 0) parts.push(`新收 ${added} 张发票待分配`);
      if (duplicates.length > 0) {
        const summary = duplicates.slice(0, 3).map((dup) => `${dup.name}（已在${dup.location}）`).join("、");
        const more = duplicates.length > 3 ? `等 ${duplicates.length} 张` : "";
        parts.push(`跳过重复：${summary}${more}`);
      }
      if (result.stats.skippedOfd > 0) parts.push(`${result.stats.skippedOfd} 个 OFD 文件暂不支持`);
      if (result.stats.skippedInlineImages > 0) parts.push(`忽略 ${result.stats.skippedInlineImages} 个正文内嵌图片`);
      if (result.stats.filteredBySubject > 0) parts.push(`${result.stats.filteredBySubject} 封邮件未匹配主题关键词`);
      if (result.stats.oversizedMessages > 0) parts.push(`${result.stats.oversizedMessages} 封邮件超过 60MB 未处理`);
      if (result.stats.oversizedAttachments > 0) parts.push(`${result.stats.oversizedAttachments} 个附件超过 30MB 未导入`);
      if (result.stats.invalidZipCount > 0) parts.push(`${result.stats.invalidZipCount} 个 ZIP 无法解压`);
      if (result.stats.parseFailures > 0) parts.push(`${result.stats.parseFailures} 张未识别出信息`);
      if (added === 0 && duplicated === 0) {
        if (result.stats.messagesWithAttachments > 0 && result.stats.pdfCount === 0 && result.stats.imageCount === 0) {
          parts.push(`${result.stats.messagesWithAttachments} 封邮件含附件，但没有可导入的发票`);
        } else {
          parts.push("没有发现新发票");
        }
      }
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
    const firstName = selectedDocs[0]?.name?.replace(/\.(pdf|png|jpe?g)$/i, "") || "合并单据";
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

  async function handleReparseDocuments(targetDocs, refreshScope = "reimbursement") {
    const docs = targetDocs.filter((doc) => doc.fileBlob && !doc.mergedItems?.length);
    if (docs.length === 0) {
      setToast("没有可重新识别的原始文件");
      return;
    }

    setBusy(`正在重新识别 ${docs.length} 张单据`);
    let success = 0;
    const failures = [];
    for (const doc of docs) {
      try {
        const parsed = await parseStoredDocument(doc);
        await updateDocument(doc.id, {
          amount: parsed.amount,
          invoiceNo: parsed.invoiceNo || "",
          invoiceDate: parsed.invoiceDate || "",
          pageCount: parsed.pageCount || doc.pageCount || 1,
          reparsedAt: new Date().toISOString(),
        });
        success += 1;
      } catch (error) {
        failures.push(`${doc.name}: ${error.message}`);
      }
    }

    setBusy("");
    if (refreshScope === "inbox") {
      await refreshInbox();
    } else {
      await refreshDocuments(activeId);
    }
    await refreshReimbursements(activeId);
    if (view === "home") {
      setAllDocs(await listAllDocuments());
    }

    const failedText = failures.length > 0 ? `，失败 ${failures.length} 张` : "";
    setToast(`已重新识别 ${success} 张单据${failedText}`);
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
      message: `确定删除待分配的 ${ids.length} 张发票吗？删除后可用「指定时间段」从邮箱找回。`,
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
            <div className="brandTitle">报销台账</div>
            <div className="brandSub">凭证与到账管理</div>
          </div>
        </div>

        <button className="primaryButton full" onClick={() => setDialog({ type: "reimbursement", mode: "create" })}>
          <Plus size={17} />
          新建报销
        </button>

        <nav className="primaryNav" aria-label="主要导航">
          <button className={`primaryNavItem ${view === "home" ? "active" : ""}`} onClick={() => setView("home")}>
            <span className="navIcon"><Home size={18} /></span>
            <span><strong>总览</strong><em>资金进度与待办</em></span>
          </button>
          <button
            className={`primaryNavItem ${view === "reimbursements" || view === "reimbursement" ? "active" : ""}`}
            onClick={() => openReimbursements()}
          >
            <span className="navIcon"><ReceiptText size={18} /></span>
            <span><strong>报销记录</strong><em>{reimbursements.length} 个报销</em></span>
            <span className="navCount">{reimbursements.length}</span>
          </button>
          <button className={`primaryNavItem ${view === "inbox" ? "active" : ""}`} onClick={() => setView("inbox")}>
            <span className="navIcon"><Inbox size={18} /></span>
            <span><strong>发票箱</strong><em>上传、同步与待分配</em></span>
            {inboxDocs.length > 0 && <span className="navCount attention">{inboxDocs.length}</span>}
          </button>
        </nav>

        <div className="sidebarFooter">
          <div className="localStoreNote">
            <span><i /> 本机存储</span>
            <em>数据只保存在这台设备</em>
          </div>
          <button className="sidebarSettings" onClick={openPreferences}>
            <Settings size={17} />
            外观与设置
          </button>
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
            onSync={() => setDialog({ type: "mailSync", initialMode: "incremental" })}
            onOpenInbox={() => setView("inbox")}
            onOpenReimbursements={openReimbursements}
            onOpenReimbursement={openReimbursement}
            onUpload={(files) => handleFiles(files, null)}
          />
        ) : view === "reimbursements" ? (
          <ReimbursementsWorkspace
            reimbursements={reimbursements}
            statusFilter={reimbursementFilter}
            onStatusFilterChange={setReimbursementFilter}
            onCreate={() => setDialog({ type: "reimbursement", mode: "create" })}
            onOpen={openReimbursement}
            onDelete={handleDeleteReimbursement}
            onStatusChange={handleReimbursementStatusChange}
          />
        ) : view === "inbox" ? (
          <InboxWorkspace
            docs={inboxDocs}
            selectedIds={inboxSelectedIds}
            busy={busy}
            hasPeriods={reimbursements.some((item) => item.periodStart || item.periodEnd)}
            onToggle={toggleInboxSelect}
            onToggleAll={toggleInboxSelectAll}
            onSync={() => setDialog({ type: "mailSync", initialMode: "incremental" })}
            onFullSync={() => setDialog({ type: "mailSync", initialMode: "custom" })}
            onOpenSettings={() => setDialog({ type: "mailSettings" })}
            onMove={handleMoveInboxDocs}
            onAutoAssign={autoAssignInboxDocs}
            onDelete={handleDeleteInboxDocs}
            onPreview={openPreview}
            onReparse={(docs) => handleReparseDocuments(docs, "inbox")}
            onUpload={(files) => handleFiles(files, null)}
          />
        ) : (
          <>
        <header className="topbar">
          <div>
            <button type="button" className="breadcrumbButton" onClick={() => openReimbursements()}>
              <ArrowLeft size={15} />
              报销记录
            </button>
            <div className="pageTitleLine">
              <h1>{active?.name || "创建一个报销"}</h1>
              {active && <ReimbursementStatusBadge item={active} />}
            </div>
            <p>
              {active
                ? `${documents.length} 张单据，合计 ${money(total)} 元${formatPeriod(active) ? ` · 周期 ${formatPeriod(active)}` : ""}${isReimbursementReceived(active) && active.receivedAt ? ` · ${formatReceivedDate(active.receivedAt)}到账` : ""}`
                : "先创建报销，再上传 PDF 或图片单据"}
            </p>
          </div>
          <div className="topActions">
            {active && (
              <label className="statusQuickControl">
                <span>报销状态</span>
                <select
                  value={normalizeReimbursementStatus(active.status)}
                  onChange={(event) => handleReimbursementStatusChange(active, event.target.value)}
                >
                  {REIMBURSEMENT_STATUSES.map((status) => (
                    <option key={status.value} value={status.value}>{status.label}</option>
                  ))}
                </select>
              </label>
            )}
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

        <UploadBand
          busy={busy}
          hint="自动识别金额、发票号码和开票日期，扫描件和照片走 OCR"
          onFiles={(files) => handleFiles(files, active)}
        />

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
                <button
                  className="ghostButton"
                  disabled={selectedIds.size === 0 || Boolean(busy)}
                  onClick={() => handleReparseDocuments(selectedDocs)}
                >
                  <RefreshCw size={17} />
                  重新识别
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
                          <button
                            title="重新识别"
                            disabled={!doc.fileBlob || Boolean(busy)}
                            onClick={() => handleReparseDocuments([doc])}
                          >
                            <RefreshCw size={16} />
                          </button>
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
                  <span>{documents.length === 0 ? "上传单据后会出现在这里" : "换一个关键词试试"}</span>
                </div>
              )}
            </div>
          </section>

          <aside className="panel summaryPanel">
            <div className="summaryHeader">
              <span>当前报销</span>
              {active && <ReimbursementStatusBadge item={active} compact />}
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
            {active && (
              <div className={`settlementSummary ${isReimbursementReceived(active) ? "received" : "pending"}`}>
                <label>{isReimbursementReceived(active) ? "到账记录" : "到账统计"}</label>
                <strong>{isReimbursementReceived(active) ? formatReceivedDate(active.receivedAt) || "已到账" : "尚未到账"}</strong>
                <span>{isReimbursementReceived(active) ? "该笔金额已纳入首页到账统计" : "状态改为“已到账”后自动计入首页统计"}</span>
              </div>
            )}
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
          updateState={updateState}
          updateCheckRequested={updateCheckRequested}
        />
      )}
      {dialog?.type === "mailSettings" && (
        <MailSettingsDialog
          onClose={() => setDialog(null)}
          onSaved={() => setToast("邮箱设置已保存")}
        />
      )}
      {dialog?.type === "mailSync" && (
        <MailSyncDialog
          initialMode={dialog.initialMode}
          onClose={() => setDialog(null)}
          onSync={(options) => {
            setDialog(null);
            handleMailSync(options);
          }}
        />
      )}
      {dialog?.type === "updateReady" && (
        <UpdateReadyDialog
          version={dialog.version}
          onClose={() => setDialog(null)}
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
      {dialog && !["preferences", "mailSettings", "mailSync", "moveDocuments", "reimbursement"].includes(dialog.type) && (
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

// 返回 "pdf" | "image" | ""（不支持的类型）
const UPLOAD_ACCEPT = "application/pdf,.pdf,image/png,image/jpeg,.png,.jpg,.jpeg";

// 三处上传入口共用：报销详情页、发票箱、总览空状态。拖拽状态各自独立。
function UploadBand({ busy, hint, onFiles, compact = false }) {
  const [dragging, setDragging] = useState(false);
  const inputRef = useRef(null);

  return (
    <section
      className={`uploadBand ${compact ? "uploadBandCompact" : ""} ${dragging ? "dragging" : ""}`}
      onDragEnter={(event) => {
        event.preventDefault();
        setDragging(true);
      }}
      onDragOver={(event) => event.preventDefault()}
      onDragLeave={() => setDragging(false)}
      onDrop={(event) => {
        event.preventDefault();
        setDragging(false);
        onFiles(event.dataTransfer.files);
      }}
    >
      <div className="uploadCopy">
        <Upload size={22} aria-hidden="true" />
        <div>
          <strong>上传 PDF 或图片单据</strong>
          <span>{hint}</span>
        </div>
      </div>
      <div className="uploadActions">
        <button className="primaryButton" disabled={Boolean(busy)} onClick={() => inputRef.current?.click()}>
          <FolderOpen size={17} aria-hidden="true" />
          选择文件
        </button>
      </div>
      <input
        ref={inputRef}
        type="file"
        accept={UPLOAD_ACCEPT}
        multiple
        hidden
        onChange={(event) => {
          onFiles(event.target.files);
          event.target.value = "";
        }}
      />
    </section>
  );
}

function getFileKind(file) {
  const name = String(file?.name || "").toLowerCase();
  const type = String(file?.type || "").toLowerCase();
  if (type === "application/pdf" || name.endsWith(".pdf")) return "pdf";
  if (type === "image/png" || type === "image/jpeg" || /\.(png|jpe?g)$/.test(name)) return "image";
  return "";
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
  // 图片识别依赖桌面端的 OCR，浏览器里没有 desktopApi 时只能先入库、之后再识别。
  if (getFileKind(file) === "image") {
    return { amount: null, invoiceNo: "", invoiceDate: "", pageCount: 1 };
  }
  return parsePdf(file);
}

async function parseStoredDocument(doc) {
  if (!doc.fileBlob) throw new Error("缺少原始文件");
  if (window.desktopApi?.parsePdfData) {
    const data = await doc.fileBlob.arrayBuffer();
    return window.desktopApi.parsePdfData(data, doc.name || "document.pdf");
  }
  if (doc.fileType === "image") throw new Error("图片识别需要在桌面端进行");
  return parsePdf(doc.fileBlob);
}

function ReimbursementStatusBadge({ item, compact = false }) {
  const status = normalizeReimbursementStatus(item?.status);
  const meta = getReimbursementStatusMeta(status);
  const receivedText = status === "received" && item?.receivedAt ? ` · ${formatReceivedDate(item.receivedAt)}到账` : "";
  return (
    <span
      className={`statusBadge ${compact ? "compact" : ""}`}
      data-status={status}
      title={`${meta.description}${receivedText}`}
    >
      <span className="statusDot" aria-hidden="true" />
      {meta.label}
    </span>
  );
}

function SortableTh({ field, sortConfig, onSort, className = "", children }) {
  const active = sortConfig.field === field;
  const nextDirection = active && sortConfig.direction === "asc" ? "降序" : "升序";
  return (
    <th className={className} aria-sort={active ? (sortConfig.direction === "asc" ? "ascending" : "descending") : "none"}>
      <button
        type="button"
        className={`sortHeader ${active ? "active" : ""}`}
        title={`按${children}${nextDirection}排序`}
        onClick={() => onSort(field)}
      >
        <span>{children}</span>
        <em aria-hidden="true">{active ? (sortConfig.direction === "asc" ? "↑" : "↓") : "↕"}</em>
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

function formatReceivedDate(value) {
  const text = String(value || "").trim();
  const matched = /^(\d{4})-(\d{2})-(\d{2})$/.exec(text);
  if (!matched) return text;
  return `${Number(matched[2])}月${Number(matched[3])}日`;
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

function PreferencesDialog({ theme, onThemeChange, canMailSync, onOpenMailSettings, onClose, updateState, updateCheckRequested }) {
  const [version, setVersion] = useState("");
  const [autoCheck, setAutoCheck] = useState(true);
  const [checking, setChecking] = useState(false);
  const [feedback, setFeedback] = useState(null);

  useEffect(() => {
    if (window.desktopApi?.updaterVersion) {
      window.desktopApi.updaterVersion().then(setVersion).catch(() => {});
    }
    if (window.desktopApi?.updaterSettingsLoad) {
      window.desktopApi.updaterSettingsLoad().then((settings) => {
        setAutoCheck(settings?.autoCheck !== false);
      }).catch(() => {});
    }
  }, []);

  function handleAutoCheckChange(next) {
    setAutoCheck(next);
    if (window.desktopApi?.updaterSettingsSave) {
      window.desktopApi.updaterSettingsSave({ autoCheck: next }).catch(() => {});
    }
  }

  async function handleCheckNow() {
    if (!window.desktopApi?.updaterCheck || checking) return;
    setChecking(true);
    setFeedback(null);
    try {
      await window.desktopApi.updaterCheck();
    } catch (error) {
      setFeedback({ kind: "error", text: `检查更新失败：${error?.message || "网络不可用"}` });
    } finally {
      setChecking(false);
    }
  }

  // 菜单「帮助 → 检查更新」打开偏好设置时自动触发一次检查。
  const checkRequestRef = useRef(0);
  useEffect(() => {
    if (!updateCheckRequested || updateCheckRequested === checkRequestRef.current) return;
    checkRequestRef.current = updateCheckRequested;
    handleCheckNow();
  }, [updateCheckRequested]);

  const status = updateState?.status;
  const downloading = status === "checking" || status === "downloading" || checking;

  return (
    <div className="modalBackdrop">
      <div className="dialog preferencesDialog">
        <div className="dialogHeader">
          <strong>外观与设置</strong>
          <button type="button" onClick={onClose}><X size={18} /></button>
        </div>
        <div className="preferenceSection">
          <div>
            <strong>界面主题</strong>
            <span>三套主题共享同一套信息层级，只改变明暗与材质。</span>
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
                  style={{
                    "--swatch-sidebar": option.colors[0],
                    "--swatch-accent": option.colors[1],
                    "--swatch-bg": option.colors[2],
                  }}
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
        <div className="preferenceSection">
          <div>
            <strong>软件更新</strong>
            <span>{version ? `当前版本 ${version}` : "检查新版本并自动安装"}</span>
          </div>
          <label className="updateAutoCheck">
            <input
              type="checkbox"
              checked={autoCheck}
              onChange={(event) => handleAutoCheckChange(event.target.checked)}
            />
            启动时自动检查更新
          </label>
          {status === "downloading" && (
            <span className="updateProgress">正在下载新版本… {Number(updateState.percent || 0)}%</span>
          )}
          {status === "downloaded" ? (
            <button
              type="button"
              className="primaryButton"
              onClick={() => {
                if (window.desktopApi?.updaterInstall) window.desktopApi.updaterInstall();
              }}
            >
              <RefreshCw size={17} />
              {updateState.version ? `重启并安装 v${updateState.version}` : "重启并安装"}
            </button>
          ) : (
            <button type="button" className="ghostButton" disabled={downloading} onClick={handleCheckNow}>
              <RefreshCw size={17} className={checking ? "spin" : ""} />
              {downloading ? (status === "checking" || checking ? "正在检查…" : "正在下载…") : "检查更新"}
            </button>
          )}
          {status === "none" && !downloading && <span className="updateHint">当前已是最新版本</span>}
          {status === "available" && !downloading && (
            <span className="updateHint">发现新版本 v{updateState.version}，正在后台下载…</span>
          )}
          {feedback && <span className={feedback.kind === "error" ? "updateHintError" : "updateHint"}>{feedback.text}</span>}
        </div>
        <div className="dialogActions">
          <button type="button" className="primaryButton" onClick={onClose}>完成</button>
        </div>
      </div>
    </div>
  );
}

function UpdateReadyDialog({ version, onClose }) {
  return (
    <div className="modalBackdrop">
      <div className="dialog">
        <div className="dialogHeader">
          <strong>更新已就绪</strong>
          <button type="button" aria-label="关闭" onClick={onClose}><X size={18} /></button>
        </div>
        <p className="dialogMessage">
          新版本{version ? ` v${version}` : ""}已下载完成。现在重启完成安装，或稍后退出应用时自动安装。
        </p>
        <div className="dialogActions">
          <button type="button" className="ghostButton" onClick={onClose}>稍后</button>
          <button
            type="button"
            className="primaryButton"
            onClick={() => {
              onClose();
              if (window.desktopApi?.updaterInstall) window.desktopApi.updaterInstall();
            }}
          >
            <RefreshCw size={17} />
            立即重启安装
          </button>
        </div>
      </div>
    </div>
  );
}

function MailSyncDialog({ initialMode = "incremental", onClose, onSync }) {
  const [mode, setMode] = useState(initialMode);
  const [range, setRange] = useState(() => createDefaultSyncRange(30));
  const [error, setError] = useState("");

  useEffect(() => {
    window.desktopApi.loadMailConfig().then((config) => {
      setRange(createDefaultSyncRange(Number(config?.days) || 30));
    }).catch(() => {});
  }, []);

  function handleSubmit(event) {
    event.preventDefault();
    if (mode === "incremental") {
      onSync({});
      return;
    }
    const start = new Date(range.startTime);
    const end = new Date(range.endTime);
    if (!range.startTime || !range.endTime || Number.isNaN(start.getTime()) || Number.isNaN(end.getTime())) {
      setError("请选择完整、有效的开始和结束时间");
      return;
    }
    if (start >= end) {
      setError("结束时间必须晚于开始时间");
      return;
    }
    onSync({ startTime: start.toISOString(), endTime: end.toISOString() });
  }

  return (
    <div className="modalBackdrop">
      <form className="dialog mailSyncDialog" onSubmit={handleSubmit}>
        <div className="dialogHeader">
          <strong>同步邮箱</strong>
          <button type="button" onClick={onClose}><X size={18} /></button>
        </div>
        <div className="syncModeOptions">
          <label className={`syncModeOption ${mode === "incremental" ? "active" : ""}`}>
            <input type="radio" name="syncMode" checked={mode === "incremental"} onChange={() => { setMode("incremental"); setError(""); }} />
            <span><strong>增量同步</strong><em>同步上次进度之后的新邮件，并复查最近邮件</em></span>
          </label>
          <label className={`syncModeOption ${mode === "custom" ? "active" : ""}`}>
            <input type="radio" name="syncMode" checked={mode === "custom"} onChange={() => { setMode("custom"); setError(""); }} />
            <span><strong>指定时间段</strong><em>按邮件接收时间重新扫描，已有发票会自动去重</em></span>
          </label>
        </div>
        {mode === "custom" && (
          <div className="mailForm syncRangeFields">
            <label className="mailField">
              <span>开始时间</span>
              <input type="datetime-local" value={range.startTime} max={range.endTime} onChange={(event) => { setRange({ ...range, startTime: event.target.value }); setError(""); }} />
            </label>
            <label className="mailField">
              <span>结束时间</span>
              <input type="datetime-local" value={range.endTime} min={range.startTime} onChange={(event) => { setRange({ ...range, endTime: event.target.value }); setError(""); }} />
            </label>
            <p className="mailHint">时间按本机时区计算。指定时间段同步不会改变增量同步进度。</p>
          </div>
        )}
        {error && <p className="mailFeedback error">{error}</p>}
        <div className="dialogActions">
          <button type="button" className="ghostButton" onClick={onClose}>取消</button>
          <button type="submit" className="primaryButton">开始同步</button>
        </div>
      </form>
    </div>
  );
}

function createDefaultSyncRange(days) {
  const end = new Date();
  const start = new Date(end.getTime() - Math.max(1, days) * 86400000);
  return { startTime: toDateTimeLocal(start), endTime: toDateTimeLocal(end) };
}

function toDateTimeLocal(date) {
  const offset = date.getTimezoneOffset() * 60000;
  return new Date(date.getTime() - offset).toISOString().slice(0, 16);
}

function formatSyncRange(startTime, endTime) {
  if (!startTime || !endTime) return "指定时间段";
  const format = (value) => new Intl.DateTimeFormat("zh-CN", {
    year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hour12: false,
  }).format(new Date(value));
  return `${format(startTime)} 至 ${format(endTime)}`;
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
          {url
            ? (currentItem.fileType === "image" || currentItem.fileBlob?.type?.startsWith("image/")
              ? <img className="previewImage" alt={currentItem.name || preview.doc.name} src={url} />
              : <iframe title={currentItem.name || preview.doc.name} src={url}></iframe>)
            : <div className="emptyPreview">没有可预览的单据</div>}
        </div>
      </div>
    </div>
  );
}

function ReimbursementsWorkspace({
  reimbursements,
  statusFilter,
  onStatusFilterChange,
  onCreate,
  onOpen,
  onDelete,
  onStatusChange,
}) {
  const [query, setQuery] = useState("");
  const filtered = useMemo(() => {
    const keyword = query.trim().toLowerCase();
    return reimbursements.filter((item) => {
      if (statusFilter !== "all" && normalizeReimbursementStatus(item.status) !== statusFilter) return false;
      if (!keyword) return true;
      return [item.name, formatPeriod(item), money(item.totalAmount), getReimbursementStatusMeta(item.status).label]
        .join(" ")
        .toLowerCase()
        .includes(keyword);
    });
  }, [query, reimbursements, statusFilter]);
  const filters = [
    { value: "all", label: "全部", count: reimbursements.length },
    ...REIMBURSEMENT_STATUSES.map((status) => ({
      value: status.value,
      label: status.label,
      count: reimbursements.filter((item) => normalizeReimbursementStatus(item.status) === status.value).length,
    })),
  ];

  return (
    <>
      <header className="topbar sectionTopbar">
        <div>
          <span className="pageEyebrow">工作区</span>
          <h1>报销记录</h1>
          <p>在一个列表里查找、筛选并推进每笔报销。</p>
        </div>
        <button className="primaryButton" onClick={onCreate}><Plus size={17} />新建报销</button>
      </header>

      <div className="recordsWorkspace">
        <div className="recordsToolbar">
          <div className="searchBox recordsSearch">
            <Search size={17} />
            <input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="搜索名称、周期、金额或状态" />
          </div>
          <div className="statusFilters" role="group" aria-label="按报销状态筛选">
            {filters.map((filter) => (
              <button
                type="button"
                key={filter.value}
                className={statusFilter === filter.value ? "active" : ""}
                onClick={() => onStatusFilterChange(filter.value)}
              >
                {filter.label}<span>{filter.count}</span>
              </button>
            ))}
          </div>
        </div>

        <section className="recordsPanel">
          {filtered.length > 0 ? (
            <div className="recordsTableWrap">
              <table className="recordsTable">
                <thead>
                  <tr>
                    <th>报销</th>
                    <th>状态</th>
                    <th>金额</th>
                    <th>单据</th>
                    <th>报销周期</th>
                    <th>到账日期</th>
                    <th className="actionCol" />
                  </tr>
                </thead>
                <tbody>
                  {filtered.map((item) => (
                    <tr key={item.id}>
                      <td>
                        <button type="button" className="recordNameButton" onClick={() => onOpen(item.id)}>
                          <strong>{item.name}</strong>
                          <span>{formatDateTime(item.createdAt)}</span>
                        </button>
                      </td>
                      <td>
                        <select
                          className="recordStatusSelect"
                          data-status={normalizeReimbursementStatus(item.status)}
                          aria-label={`修改“${item.name}”的状态`}
                          value={normalizeReimbursementStatus(item.status)}
                          onChange={(event) => onStatusChange(item, event.target.value)}
                        >
                          {REIMBURSEMENT_STATUSES.map((status) => (
                            <option key={status.value} value={status.value}>{status.label}</option>
                          ))}
                        </select>
                      </td>
                      <td className="recordAmount">¥{money(item.totalAmount)}</td>
                      <td>{item.documentCount} 张</td>
                      <td className="recordMuted">{formatPeriod(item) || "未设置"}</td>
                      <td className="recordMuted">{isReimbursementReceived(item) ? formatReceivedDate(item.receivedAt) || "已到账" : "—"}</td>
                      <td>
                        <div className="rowActions recordActions">
                          <button title="打开报销" onClick={() => onOpen(item.id)}><ChevronRight size={17} /></button>
                          <button title="删除报销" onClick={() => onDelete(item)}><Trash2 size={16} /></button>
                        </div>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : (
            <div className="emptyState recordsEmpty">
              <ReceiptText size={32} />
              <strong>{reimbursements.length === 0 ? "还没有报销记录" : "没有符合条件的报销"}</strong>
              <span>{reimbursements.length === 0 ? "新建一笔报销后，它会在这里按状态集中管理。" : "调整状态筛选或换一个关键词。"}</span>
              {reimbursements.length === 0 && <button className="primaryButton" onClick={onCreate}><Plus size={17} />新建报销</button>}
            </div>
          )}
        </section>
      </div>
    </>
  );
}

function DashboardWorkspace({
  reimbursements,
  docs,
  inboxCount,
  busy,
  canMailSync,
  onSync,
  onOpenInbox,
  onOpenReimbursements,
  onOpenReimbursement,
  onUpload,
}) {
  const [trendMode, setTrendMode] = useState("received");
  const uploadInputRef = useRef(null);
  const onPickFiles = () => uploadInputRef.current?.click();
  const totalAmount = reimbursements.reduce((sum, item) => sum + Number(item.totalAmount || 0), 0);
  const totalCount = reimbursements.reduce((sum, item) => sum + Number(item.documentCount || 0), 0);
  const statusStats = useMemo(() => REIMBURSEMENT_STATUSES.map((status) => {
    const items = reimbursements.filter((item) => normalizeReimbursementStatus(item.status) === status.value);
    return {
      ...status,
      count: items.length,
      amount: items.reduce((sum, item) => sum + Number(item.totalAmount || 0), 0),
    };
  }), [reimbursements]);
  const receivedStat = statusStats.find((item) => item.value === "received");
  const receivedAmount = receivedStat?.amount || 0;
  const pendingAmount = Math.max(totalAmount - receivedAmount, 0);
  const receivedProgress = totalAmount > 0 ? Math.round((receivedAmount / totalAmount) * 100) : 0;
  const recent = [...reimbursements].sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt))).slice(0, 5);
  const pendingStatusStats = statusStats.slice(0, 2).filter((status) => status.count > 0);
  const hasTodos = inboxCount > 0 || pendingStatusStats.length > 0;

  const documentMonths = useMemo(() => buildRecentMonths(
    docs,
    (doc) => formatInvoiceDate(doc.invoiceDate) || String(doc.uploadedAt || "").slice(0, 10),
    (doc) => Number(doc.amount || 0)
  ), [docs]);
  const receivedMonths = useMemo(() => buildRecentMonths(
    reimbursements.filter(isReimbursementReceived),
    (item) => item.receivedAt,
    (item) => Number(item.totalAmount || 0)
  ), [reimbursements]);
  const months = trendMode === "received" ? receivedMonths : documentMonths;
  const hasTrend = months.some((month) => month.count > 0);

  return (
    <>
      <header className="topbar sectionTopbar">
        <div>
          <span className="pageEyebrow">本地财务账台</span>
          <h1>总览</h1>
          <p>{reimbursements.length > 0 ? `${reimbursements.length} 个报销 · ${totalCount} 张单据` : "上传发票或新建报销，从这里开始。"}</p>
        </div>
        <div className="topActions">
          <button className="ghostButton" onClick={() => onOpenReimbursements("all")}>查看报销记录<ChevronRight size={16} aria-hidden="true" /></button>
          <button className="primaryButton" disabled={Boolean(busy)} onClick={onPickFiles}>
            <Upload size={17} aria-hidden="true" />
            上传发票
          </button>
        </div>
      </header>

      <input
        ref={uploadInputRef}
        type="file"
        accept={UPLOAD_ACCEPT}
        multiple
        hidden
        onChange={(event) => {
          onUpload(event.target.files);
          event.target.value = "";
        }}
      />

      <div className="dashboard overviewDashboard">
        <section className="fundingRail">
          <div className="fundingRailSummary">
            <div>
              <span>报销总额</span>
              <strong>¥{money(totalAmount)}</strong>
              <em>{receivedProgress}% 已到账</em>
            </div>
            <dl>
              <div><dt>已到账</dt><dd>¥{money(receivedAmount)}</dd></div>
              <div><dt>待到账</dt><dd>¥{money(pendingAmount)}</dd></div>
            </dl>
          </div>
          <div className="statusRail" aria-label="报销资金状态轨">
            {statusStats.map((status, index) => (
              <button type="button" key={status.value} data-status={status.value} onClick={() => onOpenReimbursements(status.value)}>
                <span className="railMarker">{index + 1}</span>
                <span className="railLabel"><strong>{status.label}</strong><em>{status.description}</em></span>
                <span className="railValue"><strong>¥{money(status.amount)}</strong><em>{status.count} 笔</em></span>
              </button>
            ))}
          </div>
        </section>

        <div className="overviewGrid">
          <section className="overviewSection todoSection">
            <div className="sectionHeading">
              <div><strong>待处理</strong><span>只显示下一步需要关注的事项</span></div>
            </div>
            {hasTodos ? (
              <div className="todoList">
                {inboxCount > 0 && (
                  <div className="todoRow">
                    <span className="todoIcon"><Inbox size={18} /></span>
                    <span><strong>{inboxCount} 张发票待分配</strong><em>移入对应报销后才会参与金额统计</em></span>
                    <div className="todoActions"><button type="button" onClick={onOpenInbox}>打开<ChevronRight size={15} /></button></div>
                  </div>
                )}
                {pendingStatusStats.map((status) => (
                  <div className="todoRow" key={status.value}>
                    <span className="todoIndex">{status.value === "collecting" ? "整" : "报"}</span>
                    <span><strong>{status.count} 笔{status.label}</strong><em>{status.description}</em></span>
                    <div className="todoActions"><button type="button" onClick={() => onOpenReimbursements(status.value)}>查看<ChevronRight size={15} /></button></div>
                  </div>
                ))}
              </div>
            ) : (
              <div className="todoClear">
                <span className="todoIcon"><Inbox size={18} /></span>
                <span><strong>当前没有待处理事项</strong><em>发票箱已清空，也没有进行中的报销。</em></span>
                {canMailSync && <button type="button" disabled={Boolean(busy)} onClick={onSync}><RefreshCw size={15} />同步邮箱</button>}
              </div>
            )}
          </section>

          <section className="overviewSection recentSection">
            <div className="sectionHeading">
              <div><strong>最近报销</strong><span>按创建时间排列</span></div>
              <button type="button" onClick={() => onOpenReimbursements("all")}>全部记录</button>
            </div>
            {recent.length > 0 ? (
              <div className="recentRecords">
                {recent.map((item) => (
                  <button type="button" key={item.id} onClick={() => onOpenReimbursement(item.id)}>
                    <span><strong>{item.name}</strong><em>{item.documentCount} 张单据 · {formatPeriod(item) || "未设置周期"}</em></span>
                    <span className="recentRecordValue"><strong>¥{money(item.totalAmount)}</strong><ReimbursementStatusBadge item={item} compact /></span>
                  </button>
                ))}
              </div>
            ) : (
              <div className="compactEmpty">还没有报销记录。</div>
            )}
          </section>
        </div>

        <section className="overviewSection trendSection">
          <div className="sectionHeading">
            <div><strong>{trendMode === "received" ? "到账走势" : "单据走势"}</strong><span>{trendMode === "received" ? "按到账日期统计近 6 个月" : "按开票日期统计近 6 个月"}</span></div>
            <div className="trendSwitch" role="group" aria-label="金额趋势统计口径">
              <button type="button" className={trendMode === "received" ? "active" : ""} onClick={() => setTrendMode("received")}>到账</button>
              <button type="button" className={trendMode === "documents" ? "active" : ""} onClick={() => setTrendMode("documents")}>单据</button>
            </div>
          </div>
          {hasTrend ? (
            <MonthlyLineChart
              months={months}
              unit={trendMode === "received" ? "笔" : "张"}
              ariaLabel={trendMode === "received" ? "近 6 个月到账金额趋势" : "近 6 个月单据金额趋势"}
            />
          ) : (
            <div className="chartEmpty compactChartEmpty">
              {trendMode === "received" ? "将报销标记为“已到账”后，这里会形成到账曲线。" : "上传或同步发票后，这里会形成单据曲线。"}
            </div>
          )}
        </section>
      </div>
    </>
  );
}

function buildRecentMonths(items, getDate, getAmount) {
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
  for (const item of items) {
    const date = String(getDate(item) || "");
    const month = index.get(date.slice(0, 7));
    if (!month) continue;
    month.amount += Number(getAmount(item) || 0);
    month.count += 1;
  }
  for (const month of list) month.amount = Math.round(month.amount * 100) / 100;
  return list;
}

function MonthlyLineChart({ months, unit = "张", ariaLabel = "近 6 个月金额趋势" }) {
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
          <span>{hover.full} · {hover.count} {unit}</span>
        </div>
      )}
      <svg
        className="lineChart"
        viewBox={`0 0 ${VB_W} ${VB_H}`}
        role="img"
        aria-label={ariaLabel}
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
  onReparse,
  onUpload,
}) {
  const [sortConfig, setSortConfig] = useState({ field: "sourceDate", direction: "desc" });
  const selectedDocs = docs.filter((doc) => selectedIds.has(doc.id));
  const selectedCount = selectedDocs.length;
  const totalAmount = docs.reduce((sum, doc) => sum + Number(doc.amount || 0), 0);
  const sortedDocs = useMemo(() => sortDocuments(docs, sortConfig), [docs, sortConfig]);

  function handleSort(field) {
    setSortConfig((current) => ({
      field,
      direction: current.field === field && current.direction === "asc" ? "desc" : "asc",
    }));
  }

  return (
    <>
      <header className="topbar">
        <div>
          <h1>发票箱</h1>
          <p>
            {docs.length > 0
              ? `${docs.length} 张发票待分配，合计 ${money(totalAmount)} 元 · 移动到报销后参与统计`
              : "手动上传或从邮箱拉取发票，在这里分配到各个报销"}
          </p>
        </div>
        <div className="topActions">
          <button
            className="ghostButton iconOnlyButton"
            title="邮箱同步设置"
            aria-label="邮箱同步设置"
            disabled={Boolean(busy)}
            onClick={onOpenSettings}
          >
            <Settings size={17} aria-hidden="true" />
          </button>
          <button
            className="ghostButton"
            title="忽略同步进度，重新拉取时间范围内的全部邮件；已有的发票会自动去重，删除过的会找回"
            disabled={Boolean(busy)}
            onClick={onFullSync}
          >
            <RotateCcw size={17} aria-hidden="true" />
            指定时间段
          </button>
          <button className="primaryButton" disabled={Boolean(busy)} onClick={onSync}>
            <RefreshCw size={17} aria-hidden="true" />
            同步邮箱
          </button>
        </div>
      </header>

      <UploadBand
        busy={busy}
        hint="上传的发票先进发票箱，选中后移动到对应报销"
        onFiles={onUpload}
      />

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
              disabled={docs.length === 0 || Boolean(busy)}
              title={selectedCount > 0 ? "重新识别选中的发票" : "未选中时重新识别全部待分配发票"}
              onClick={() => onReparse(selectedCount > 0 ? selectedDocs : docs)}
            >
              <RefreshCw size={17} />
              重新识别
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
                <SortableTh field="name" sortConfig={sortConfig} onSort={handleSort}>发票</SortableTh>
                <SortableTh field="amount" sortConfig={sortConfig} onSort={handleSort}>金额</SortableTh>
                <SortableTh field="invoiceDate" sortConfig={sortConfig} onSort={handleSort}>开票日期</SortableTh>
                <SortableTh field="sourceSubject" sortConfig={sortConfig} onSort={handleSort}>来源邮件</SortableTh>
                <SortableTh field="sourceDate" sortConfig={sortConfig} onSort={handleSort}>邮件日期</SortableTh>
                <th className="actionCol"></th>
              </tr>
            </thead>
            <tbody>
              {sortedDocs.map((doc) => (
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
                      <button title="重新识别" disabled={!doc.fileBlob || Boolean(busy)} onClick={() => onReparse([doc])}><RefreshCw size={16} /></button>
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
  const [status, setStatus] = useState(normalizeReimbursementStatus(initial?.status));
  const [receivedAt, setReceivedAt] = useState(initial?.receivedAt || "");

  function chooseStatus(nextStatus) {
    setStatus(nextStatus);
    if (nextStatus === "received" && !receivedAt) setReceivedAt(todayDateValue());
    if (nextStatus !== "received") setReceivedAt("");
  }

  return (
    <div className="modalBackdrop">
      <form
        className="dialog reimbursementDialog"
        onSubmit={(event) => {
          event.preventDefault();
          onSave({ name, periodStart, periodEnd, status, receivedAt });
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
        <fieldset className="statusFieldset">
          <legend>报销状态</legend>
          <div className="statusOptions">
            {REIMBURSEMENT_STATUSES.map((option) => (
              <button
                key={option.value}
                type="button"
                className={status === option.value ? "active" : ""}
                data-status={option.value}
                aria-pressed={status === option.value}
                onClick={() => chooseStatus(option.value)}
              >
                <span className="statusDot" aria-hidden="true" />
                <strong>{option.label}</strong>
                <em>{option.description}</em>
              </button>
            ))}
          </div>
        </fieldset>
        {status === "received" && (
          <label className="mailField receivedDateField">
            <span>到账日期</span>
            <input type="date" required value={receivedAt} onChange={(event) => setReceivedAt(event.target.value)} />
            <em>到账金额按当前报销内的单据合计计算，并自动纳入首页统计。</em>
          </label>
        )}
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
        <p className="mailHint">设置周期后，导入或移入开票日期不在周期内的发票会提示；发票箱可按周期自动分配。</p>
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
