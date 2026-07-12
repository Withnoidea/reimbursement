import * as pdfjs from "pdfjs-dist/build/pdf.mjs";
import pdfWorkerUrl from "pdfjs-dist/build/pdf.worker.mjs?url";

pdfjs.GlobalWorkerOptions.workerSrc = pdfWorkerUrl;

const assetBase = import.meta.env.BASE_URL || "./";

const smallAmountPatterns = [
  /[（(]\s*小写\s*[）)]\s*[¥￥]?\s*([0-9]+(?:\.[0-9]{1,2})?)/,
  /小写\s*[¥￥]?\s*([0-9]+(?:\.[0-9]{1,2})?)/,
];
const currencyPattern = /[¥￥]\s*([0-9]+(?:\.[0-9]{1,2})?)/g;
// 行程单、账单等无 ¥ 符号的单据：带标签的合计金额
const labeledAmountPatterns = [
  /(?:价税合计|合计金额|金额合计|总计|应付金额|实付金额|实收金额|付款金额)[:：]?[¥￥]?([0-9]{1,7}(?:\.[0-9]{1,2})?)/,
  /合计[:：]?[¥￥]?([0-9]{1,7}(?:\.[0-9]{1,2})?)元/,
];
// 前后紧邻数字或点号的不算（排除 2026.07.09 这类日期片段）
const decimalAmountPattern = /(?<![0-9.])([0-9]{1,6}\.[0-9]{2})(?![0-9.])/g;
const invoiceNoPattern = /发票号码\s*[:：]?\s*([0-9]{8,})/;
const anyInvoiceNoPattern = /\b(\d{20})\b/;
const datePattern = /开票日期\s*[:：]?\s*(\d{4}年\d{1,2}月\d{1,2}日)/;
const anyDatePattern = /\d{4}年\d{1,2}月\d{1,2}日/;
const anyNumericDatePattern = /(20\d{2})[.\-/](\d{1,2})[.\-/](\d{1,2})/;
const datePartsPattern = /(\d{4})\D+(\d{1,2})\D+(\d{1,2})/;
const dateNumbersPattern = /(20\d{2})\D{0,3}(\d{1,2})\D{0,3}(\d{1,2})/;

export async function parsePdf(file) {
  const buffer = await file.arrayBuffer();
  const pdf = await pdfjs.getDocument({
    data: buffer.slice(0),
    cMapUrl: `${assetBase}cmaps/`,
    cMapPacked: true,
    standardFontDataUrl: `${assetBase}standard_fonts/`,
  }).promise;
  const pageTexts = [];
  const positionedItems = [];

  for (let pageNumber = 1; pageNumber <= pdf.numPages; pageNumber += 1) {
    const page = await pdf.getPage(pageNumber);
    const content = await page.getTextContent();
    pageTexts.push(content.items.map((item) => item.str).join("\n"));
    positionedItems.push(
      ...content.items
        .filter((item) => item.str?.trim())
        .map((item) => ({
          page: pageNumber,
          text: item.str,
          x0: item.transform[4],
          y0: item.transform[5],
          x1: item.transform[4] + (item.width || 0),
        }))
    );
  }

  const text = pageTexts.join("\n");
  const lines = buildLines(positionedItems);
  return {
    amount: extractAmount(text),
    invoiceNo: extractInvoiceNo(text, lines),
    invoiceDate: extractInvoiceDate(text, lines),
    pageCount: pdf.numPages,
  };
}

function extractAmount(text) {
  const normalized = text.replace(/\s+/g, "");
  for (const pattern of smallAmountPatterns) {
    const match = normalized.match(pattern);
    if (match) return roundMoney(match[1]);
  }

  const values = [...text.matchAll(currencyPattern)].map((match) => Number(match[1]));
  if (values.length > 0) return roundMoney(Math.max(...values));

  for (const pattern of labeledAmountPatterns) {
    const match = normalized.match(pattern);
    if (match) return roundMoney(match[1]);
  }

  const decimalValues = [...text.matchAll(decimalAmountPattern)]
    .map((match) => match[1])
    .filter((value) => !looksLikeYearMonth(value))
    .map(Number);
  if (decimalValues.length > 0) return roundMoney(Math.max(...decimalValues));

  return null;
}

function looksLikeYearMonth(value) {
  const [whole, fraction = ""] = String(value).split(".");
  const month = Number(fraction);
  const year = Number(whole);
  return fraction.length === 2 && month >= 1 && month <= 12 && year >= 1900 && year <= 2099;
}

function extractInvoiceNo(text, lines = []) {
  const normalized = text.replace(/\s+/g, "");
  const direct = normalized.match(invoiceNoPattern)?.[1];
  if (direct) return direct;

  const positioned = fieldValueFromLines(lines, "发票号码");
  const positionedMatch = positioned.match(/\d{8,20}/);
  if (positionedMatch) return positionedMatch[0];

  return text.match(anyInvoiceNoPattern)?.[1] || "";
}

function extractInvoiceDate(text, lines = []) {
  const normalized = text.replace(/\s+/g, "");
  const direct = normalized.match(datePattern)?.[1];
  if (direct) return normalizeDate(direct);

  const positioned = fieldValueFromLines(lines, "开票日期");
  const positionedDate = normalizeDate(positioned);
  if (positionedDate) return positionedDate;

  const fallback = text.match(anyDatePattern)?.[0];
  if (fallback) return normalizeDate(fallback);

  const numeric = normalized.match(anyNumericDatePattern);
  if (numeric) {
    const [, year, month, day] = numeric;
    return `${year}-${month.padStart(2, "0")}-${day.padStart(2, "0")}`;
  }
  return "";
}

function roundMoney(value) {
  return Math.round(Number(value) * 100) / 100;
}

function buildLines(items) {
  const lines = [];
  const sortedItems = [...items].sort((a, b) => a.page - b.page || b.y0 - a.y0 || a.x0 - b.x0);

  for (const item of sortedItems) {
    const current = lines[lines.length - 1];
    if (current && current.page === item.page && Math.abs(current.y - item.y0) <= 3) {
      current.items.push(item);
      current.y = (current.y + item.y0) / 2;
    } else {
      lines.push({ page: item.page, y: item.y0, items: [item] });
    }
  }

  return lines.map((line) => ({
    ...line,
    items: line.items.sort((a, b) => a.x0 - b.x0),
  }));
}

function fieldValueFromLines(lines, label) {
  for (const line of lines) {
    const labelItem = line.items.find((item) => item.text.includes(label));
    if (!labelItem) continue;

    return line.items
      .filter((item) => item.x0 >= labelItem.x1 - 1 && item.text.trim())
      .map((item) => item.text.trim())
      .join("");
  }
  return "";
}

function normalizeDate(value) {
  const match = String(value || "").match(datePartsPattern) || String(value || "").match(dateNumbersPattern);
  if (!match) return "";
  const [, year, month, day] = match;
  return `${year}-${month.padStart(2, "0")}-${day.padStart(2, "0")}`;
}
