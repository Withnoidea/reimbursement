import JSZip from "jszip";

export function money(value) {
  if (value === null || value === undefined || Number.isNaN(Number(value))) return "";
  return Number(value).toFixed(2);
}

export function formatDateTime(iso) {
  if (!iso) return "";
  return new Intl.DateTimeFormat("zh-CN", {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  }).format(new Date(iso));
}

export function formatInvoiceDate(value) {
  if (!value) return "";
  const text = String(value);
  const match = text.match(/(\d{4})\D+(\d{1,2})\D+(\d{1,2})/);
  if (!match) return text;
  const [, year, month, day] = match;
  return `${year}-${month.padStart(2, "0")}-${day.padStart(2, "0")}`;
}

export async function exportDocumentsZip(reimbursement, documents) {
  const zip = new JSZip();
  const folder = zip.folder(safeName(reimbursement?.name || "报销单据"));
  const used = new Set();

  for (const doc of documents) {
    if (doc.mergedItems?.length) {
      const mergedFolder = folder.folder(uniqueStem(doc.name, used));
      const mergedUsed = new Set();
      for (const item of doc.mergedItems) {
        if (item.fileBlob) mergedFolder.file(uniqueName(item.name, mergedUsed), item.fileBlob);
      }
    } else if (doc.fileBlob) {
      folder.file(uniqueName(doc.name, used), doc.fileBlob);
    }
  }

  folder.file("单据汇总.csv", makeCsv(documents));
  const blob = await zip.generateAsync({ type: "blob" });
  downloadBlob(blob, `${safeName(reimbursement?.name || "报销单据")}.zip`);
}

function makeCsv(documents) {
  const rows = [
    ["文件名", "金额", "发票号码", "开票日期", "备注", "上传时间", "页数", "大小", "合并明细"],
    ...documents.map((doc) => [
      doc.name,
      money(doc.amount),
      doc.invoiceNo || "",
      formatInvoiceDate(doc.invoiceDate),
      doc.note || "",
      formatDateTime(doc.uploadedAt),
      doc.pageCount || "",
      formatBytes(doc.size),
      mergedDetailText(doc),
    ]),
  ];
  return `\ufeff${rows.map((row) => row.map(csvCell).join(",")).join("\n")}`;
}

function csvCell(value) {
  return `"${String(value ?? "").replaceAll('"', '""')}"`;
}

function downloadBlob(blob, name) {
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = name;
  document.body.appendChild(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export function formatBytes(bytes) {
  if (!bytes) return "";
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

function safeName(name) {
  return name.replace(/[\\/:*?"<>|]/g, "_").trim() || "报销单据";
}

function uniqueName(name, used) {
  const original = name || "invoice.pdf";
  const dot = original.lastIndexOf(".");
  const stem = dot > 0 ? original.slice(0, dot) : original;
  const ext = dot > 0 ? original.slice(dot) : ".pdf";
  let candidate = original;
  let index = 2;

  while (used.has(candidate.toLowerCase())) {
    candidate = `${stem}_${index}${ext}`;
    index += 1;
  }

  used.add(candidate.toLowerCase());
  return candidate;
}

function uniqueStem(name, used) {
  const safe = safeName(name || "合并单据");
  let candidate = safe;
  let index = 2;

  while (used.has(candidate.toLowerCase())) {
    candidate = `${safe}_${index}`;
    index += 1;
  }

  used.add(candidate.toLowerCase());
  return candidate;
}

function mergedDetailText(doc) {
  if (!doc.mergedItems?.length) return "";
  return doc.mergedItems
    .map((item) => `${item.name || "单据"} ${money(item.amount)} ${item.note || ""}`.trim())
    .join("；");
}
