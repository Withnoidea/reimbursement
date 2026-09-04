import { app, safeStorage } from "electron";
import { createRequire } from "node:module";
import { createHash } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import os from "node:os";
import path from "node:path";

const require = createRequire(import.meta.url);

const DEFAULT_CONFIG = {
  host: "imap.qq.com",
  port: 993,
  user: "",
  folder: "INBOX",
  days: 30,
  subjectKeyword: "",
};

const MAX_MESSAGE_BYTES = 60 * 1024 * 1024;
const MAX_ATTACHMENT_BYTES = 30 * 1024 * 1024;
// 图片附件的体积下限：邮件签名 logo、跟踪像素通常远小于这个值，真实发票照片/扫描件则远大于它。
const MIN_IMAGE_ATTACHMENT_BYTES = 20 * 1024;
const FETCH_BATCH_SIZE = 100;
const RECENT_UID_OVERLAP = 25;

let depsCache = null;

// 优先使用预打包的单文件依赖（打包后的应用不带 node_modules），开发环境回退到 node_modules。
function loadDeps() {
  if (!depsCache) {
    try {
      depsCache = require("./vendor/mail-deps.cjs");
    } catch {
      depsCache = {
        ImapFlow: require("imapflow").ImapFlow,
        simpleParser: require("mailparser").simpleParser,
        JSZip: require("jszip"),
      };
    }
  }
  return depsCache;
}

function configFilePath() {
  return path.join(app.getPath("userData"), "mail-sync.json");
}

function readConfigFile() {
  try {
    return JSON.parse(readFileSync(configFilePath(), "utf8"));
  } catch {
    return null;
  }
}

function isEncryptionAvailable() {
  try {
    return safeStorage.isEncryptionAvailable();
  } catch {
    return false;
  }
}

function encryptAuthCode(code) {
  if (isEncryptionAvailable()) {
    return { mode: "safeStorage", value: safeStorage.encryptString(code).toString("base64") };
  }
  return { mode: "plain", value: Buffer.from(code, "utf8").toString("base64") };
}

function decryptAuthCode(auth) {
  if (!auth?.value) return "";
  try {
    if (auth.mode === "safeStorage") {
      return safeStorage.decryptString(Buffer.from(auth.value, "base64"));
    }
    return Buffer.from(auth.value, "base64").toString("utf8");
  } catch {
    return "";
  }
}

export function loadMailConfigSummary() {
  const stored = readConfigFile();
  return {
    host: stored?.host || DEFAULT_CONFIG.host,
    port: Number(stored?.port) || DEFAULT_CONFIG.port,
    user: stored?.user || "",
    folder: stored?.folder || DEFAULT_CONFIG.folder,
    days: Number(stored?.days) || DEFAULT_CONFIG.days,
    subjectKeyword: stored?.subjectKeyword || "",
    hasAuth: Boolean(stored?.auth?.value),
    encryptionAvailable: isEncryptionAvailable(),
  };
}

export function saveMailConfig(input) {
  const stored = readConfigFile();
  const next = {
    host: String(input?.host || "").trim() || DEFAULT_CONFIG.host,
    port: Number(input?.port) || DEFAULT_CONFIG.port,
    user: String(input?.user || "").trim(),
    folder: String(input?.folder || "").trim() || DEFAULT_CONFIG.folder,
    days: Math.max(1, Number(input?.days) || DEFAULT_CONFIG.days),
    subjectKeyword: String(input?.subjectKeyword || "").trim(),
    auth: input?.authCode ? encryptAuthCode(String(input.authCode)) : stored?.auth || null,
  };
  mkdirSync(path.dirname(configFilePath()), { recursive: true });
  writeFileSync(configFilePath(), JSON.stringify(next, null, 2), "utf8");
  return loadMailConfigSummary();
}

function resolveRuntimeConfig(overrides = {}) {
  const stored = readConfigFile();
  const config = { ...DEFAULT_CONFIG, ...(stored || {}) };
  for (const key of ["host", "port", "user", "folder", "days", "subjectKeyword"]) {
    if (overrides[key] !== undefined && overrides[key] !== null && String(overrides[key]).trim() !== "") {
      config[key] = overrides[key];
    }
  }
  const authCode = String(overrides.authCode || "").trim() || decryptAuthCode(stored?.auth);
  return { config, authCode };
}

function friendlyError(error, config) {
  const text = [error?.responseText, error?.message].filter(Boolean).join(" ") || String(error);
  if (error?.authenticationFailed || /AUTHENTICATIONFAILED|Login fail|invalid user or password|password error/i.test(text)) {
    return "登录失败：请确认邮箱已开启 IMAP 服务，且填写的是「授权码」而不是登录密码";
  }
  if (/NONEXISTENT|unknown mailbox|Mailbox doesn't exist/i.test(text)) {
    return `找不到邮箱文件夹「${config.folder}」，请检查文件夹名称（收件箱一般为 INBOX）`;
  }
  if (/ENOTFOUND|EAI_AGAIN/i.test(text)) {
    return `无法解析服务器地址 ${config.host}，请检查网络和服务器设置`;
  }
  if (/ETIMEDOUT|timed? ?out/i.test(text)) {
    return "连接超时，请检查网络后重试";
  }
  if (/ECONNREFUSED|ECONNRESET/i.test(text)) {
    return "连接被服务器拒绝或中断，请检查服务器地址和端口（SSL 端口一般为 993）";
  }
  return text;
}

async function withClient(config, authCode, fn) {
  const { ImapFlow } = loadDeps();
  const client = new ImapFlow({
    host: String(config.host),
    port: Number(config.port) || 993,
    secure: true,
    auth: { user: String(config.user), pass: authCode },
    logger: false,
    // 国内邮箱（QQ/163）要求客户端上报 IMAP ID，否则可能拒绝操作
    clientInfo: { name: "ReimbursementDesktop", version: app.getVersion(), vendor: "local" },
    connectionTimeout: 20000,
    greetingTimeout: 20000,
    socketTimeout: 120000,
  });
  try {
    await client.connect();
    return await fn(client);
  } finally {
    try {
      await client.logout();
    } catch {
      try {
        client.close();
      } catch {
        // 连接已经断开
      }
    }
  }
}

export async function testMailConnection(overrides = {}) {
  const { config, authCode } = resolveRuntimeConfig(overrides);
  if (!config.user) return { ok: false, error: "请填写邮箱账号" };
  if (!authCode) return { ok: false, error: "请填写授权码" };
  try {
    return await withClient(config, authCode, async (client) => {
      const box = await client.mailboxOpen(config.folder || "INBOX", { readOnly: true });
      return { ok: true, exists: box.exists };
    });
  } catch (error) {
    return { ok: false, error: friendlyError(error, config) };
  }
}

export async function syncMailbox({ state, range = null, onProgress = () => {}, parsePdfFile }) {
  const { config, authCode } = resolveRuntimeConfig();
  if (!config.user || !authCode) {
    return { ok: false, needsConfig: true, error: "请先在邮箱设置中填写账号和授权码" };
  }

  const customRange = normalizeSyncRange(range);
  if (range && !customRange) {
    return { ok: false, error: "同步时间段无效，请确认结束时间晚于开始时间" };
  }

  let tempRoot = "";
  try {
    tempRoot = await mkdtemp(path.join(os.tmpdir(), "reimb-mail-"));
    return await withClient(config, authCode, async (client) => {
      onProgress("正在打开邮箱…");
      const lock = await client.getMailboxLock(config.folder || "INBOX");
      try {
        const mailbox = client.mailbox;
        const uidValidity = String(mailbox.uidValidity ?? "");
        const uidNext = Number(mailbox.uidNext ?? 0);

        let baseline = 0;
        let query;
        let sinceDate = null;
        const hasValidState = !customRange && state
          && String(state.uidValidity) === uidValidity
          && Number.isSafeInteger(Number(state.lastUid))
          && Number(state.lastUid) > 0;
        if (customRange) {
          // IMAP SEARCH has day-level precision; internalDate below enforces the exact time range.
          query = { since: customRange.startTime, before: dayAfter(customRange.endTime) };
        } else if (hasValidState) {
          baseline = Math.floor(Number(state.lastUid));
          // Recheck a small UID overlap to recover messages missed by a transient fetch failure.
          const searchStart = Math.max(1, baseline - RECENT_UID_OVERLAP + 1);
          query = { uid: `${searchStart}:*` };
        } else {
          const days = Math.max(1, Number(config.days) || DEFAULT_CONFIG.days);
          sinceDate = new Date(Date.now() - days * 86400000);
          query = { since: sinceDate };
        }

        onProgress(customRange
          ? `正在查找 ${formatDateTime(customRange.startTime)} 至 ${formatDateTime(customRange.endTime)} 的邮件…`
          : sinceDate
            ? `正在查找 ${isoDay(sinceDate)} 以来的邮件…`
            : "正在查找上次同步之后的新邮件…");
        let uids = (await client.search(query, { uid: true })) || [];
        uids = [...new Set(uids.map(Number))]
          .filter((uid) => Number.isSafeInteger(uid) && uid > 0)
          .sort((a, b) => a - b);

        const stats = {
          scanned: customRange ? 0 : sinceDate ? uids.length : uids.filter((uid) => uid > baseline).length,
          rechecked: customRange || sinceDate ? 0 : uids.filter((uid) => uid <= baseline).length,
          checked: uids.length,
          matchedMessages: 0,
          messagesWithAttachments: 0,
          filteredBySubject: 0,
          oversizedMessages: 0,
          pdfCount: 0,
          imageCount: 0,
          zipCount: 0,
          skippedOfd: 0,
          skippedInlineImages: 0,
          unsupportedAttachments: 0,
          oversizedAttachments: 0,
          invalidZipCount: 0,
          parseFailures: 0,
          sinceDate: sinceDate ? isoDay(sinceDate) : "",
          startTime: customRange ? customRange.startTime.toISOString() : "",
          endTime: customRange ? customRange.endTime.toISOString() : "",
          mode: customRange ? "custom" : sinceDate ? "window" : "incremental",
        };
        const items = [];
        const keyword = String(config.subjectKeyword || "").trim().toLowerCase();

        const { simpleParser } = loadDeps();
        let inspected = 0;
        for (let offset = 0; offset < uids.length; offset += FETCH_BATCH_SIZE) {
          const batch = uids.slice(offset, offset + FETCH_BATCH_SIZE);
          const candidates = [];
          // UID 分批请求，避免全量同步时生成过长的 IMAP FETCH 命令。
          for await (const message of client.fetch(batch, { uid: true, envelope: true, size: true, internalDate: true }, { uid: true })) {
            const subject = message.envelope?.subject || "";
            if (keyword && !subject.toLowerCase().includes(keyword)) {
              stats.filteredBySubject += 1;
              continue;
            }
            if (Number(message.size || 0) > MAX_MESSAGE_BYTES) {
              stats.oversizedMessages += 1;
              continue;
            }
            // 个别服务器对 SEARCH SINCE 的实现不严格，这里再按邮件时间过滤一次。
            const messageDate = message.internalDate || message.envelope?.date || null;
            if (sinceDate && messageDate && new Date(messageDate) < sinceDate) continue;
            if (customRange && messageDate && !isWithinRange(messageDate, customRange)) continue;
            candidates.push({ uid: Number(message.uid), subject, messageDate });
            if (customRange) stats.scanned += 1;
          }

          for (const candidate of candidates) {
            inspected += 1;
            onProgress(`正在检查邮件 ${inspected}/${uids.length}…`);
            const full = await client.fetchOne(candidate.uid, { uid: true, source: true }, { uid: true });
            if (!full?.source) {
              throw new Error(`邮件 UID ${candidate.uid} 下载失败，请重新同步`);
            }
            const mail = await simpleParser(full.source);
            const subject = mail.subject || candidate.subject || "";
            if (keyword && !subject.toLowerCase().includes(keyword)) {
              stats.filteredBySubject += 1;
              continue;
            }
            const effectiveDate = candidate.messageDate || mail.date;
            if (customRange && (!effectiveDate || !isWithinRange(effectiveDate, customRange))) continue;
            const attachments = mail.attachments || [];
            if (attachments.length === 0) continue;
            stats.messagesWithAttachments += 1;
            const itemCountBefore = items.length;
            const sourceDate = toIsoString(mail.date || candidate.messageDate);
            for (const attachment of attachments) {
              await collectAttachment({ attachment, uid: candidate.uid, subject, sourceDate, items, stats, tempRoot, parsePdfFile });
            }
            if (items.length > itemCountBefore) stats.matchedMessages += 1;
          }
        }

        const maxScanned = uids.length > 0 ? uids[uids.length - 1] : 0;
        const initialHighWater = sinceDate && uidNext > 0 ? uidNext - 1 : 0;
        const newState = customRange ? null : {
          uidValidity,
          // Custom historical scans must not advance the incremental high-water mark.
          lastUid: Math.max(baseline, maxScanned, initialHighWater),
        };
        return { ok: true, items, stats, newState };
      } finally {
        lock.release();
      }
    });
  } catch (error) {
    return { ok: false, error: friendlyError(error, config) };
  } finally {
    if (tempRoot) await rm(tempRoot, { recursive: true, force: true }).catch(() => {});
  }
}

function hasPdfSignature(content) {
  return content?.length >= 5 && content.subarray(0, 5).toString("ascii") === "%PDF-";
}

function hasZipSignature(content) {
  if (!content?.length || content.length < 4) return false;
  return content[0] === 0x50 && content[1] === 0x4b
    && ((content[2] === 0x03 && content[3] === 0x04)
      || (content[2] === 0x05 && content[3] === 0x06)
      || (content[2] === 0x07 && content[3] === 0x08));
}

function isPdfAttachment(fileName, contentType, content) {
  return /\.pdf$/i.test(fileName)
    || ["application/pdf", "application/x-pdf", "application/acrobat"].includes(contentType)
    || hasPdfSignature(content);
}

function hasJpegSignature(content) {
  return content?.length >= 3 && content[0] === 0xff && content[1] === 0xd8 && content[2] === 0xff;
}

function hasPngSignature(content) {
  if (!content?.length || content.length < 8) return false;
  const magic = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
  return magic.every((byte, index) => content[index] === byte);
}

function isImageAttachment(fileName, contentType, content) {
  return /\.(png|jpe?g)$/i.test(fileName)
    || ["image/png", "image/jpeg", "image/jpg"].includes(contentType)
    || hasJpegSignature(content)
    || hasPngSignature(content);
}

// 邮件签名里的 logo、HTML 正文内嵌图片同样会出现在 attachments 里，
// 不加区分会把它们当成发票收进来，所以只接受作为独立附件发送的图片。
function isInlineImage(attachment) {
  return attachment?.related === true
    || (String(attachment?.contentDisposition || "").toLowerCase() === "inline" && Boolean(attachment?.cid));
}

function isZipAttachment(fileName, contentType, content) {
  return /\.zip$/i.test(fileName)
    || contentType === "application/zip"
    || contentType === "application/x-zip-compressed"
    || hasZipSignature(content);
}

function isOfdAttachment(fileName, contentType) {
  return /\.ofd$/i.test(fileName) || contentType === "application/ofd";
}

async function collectAttachment({ attachment, uid, subject, sourceDate, items, stats, tempRoot, parsePdfFile }) {
  const content = attachment.content;
  if (!content?.length) {
    stats.unsupportedAttachments += 1;
    return;
  }
  if (content.length > MAX_ATTACHMENT_BYTES) {
    stats.oversizedAttachments += 1;
    return;
  }
  const fileName = String(attachment.filename || "").trim();
  const contentType = String(attachment.contentType || "").toLowerCase().split(";", 1)[0].trim();

  if (isOfdAttachment(fileName, contentType)) {
    stats.skippedOfd += 1;
    return;
  }

  // 一些邮箱把 PDF/ZIP 标成 application/octet-stream，使用文件签名兜底识别。
  if (isPdfAttachment(fileName, contentType, content)) {
    await addAttachmentItem({ data: content, fileName, kind: "pdf", uid, subject, sourceDate, items, stats, tempRoot, parsePdfFile, viaZip: "" });
    return;
  }

  if (isImageAttachment(fileName, contentType, content)) {
    if (isInlineImage(attachment) || content.length < MIN_IMAGE_ATTACHMENT_BYTES) {
      stats.skippedInlineImages += 1;
      return;
    }
    await addAttachmentItem({
      data: content,
      fileName,
      kind: "image",
      fallbackExt: hasPngSignature(content) ? ".png" : ".jpg",
      uid,
      subject,
      sourceDate,
      items,
      stats,
      tempRoot,
      parsePdfFile,
      viaZip: "",
    });
    return;
  }

  if (isZipAttachment(fileName, contentType, content)) {
    stats.zipCount += 1;
    const { JSZip } = loadDeps();
    let zip;
    try {
      zip = await JSZip.loadAsync(content, { decodeFileName: decodeZipFileName });
    } catch {
      stats.invalidZipCount += 1;
      return;
    }
    for (const entry of Object.values(zip.files)) {
      if (entry.dir) continue;
      const entryName = entry.name.split("/").pop() || "";
      if (/\.ofd$/i.test(entryName)) {
        stats.skippedOfd += 1;
        continue;
      }
      let entryData;
      try {
        entryData = await entry.async("nodebuffer");
      } catch {
        stats.unsupportedAttachments += 1;
        continue;
      }
      if (!entryData?.length) continue;
      if (entryData.length > MAX_ATTACHMENT_BYTES) {
        stats.oversizedAttachments += 1;
        continue;
      }
      if (/\.pdf$/i.test(entryName) || hasPdfSignature(entryData)) {
        await addAttachmentItem({ data: entryData, fileName: entryName, kind: "pdf", uid, subject, sourceDate, items, stats, tempRoot, parsePdfFile, viaZip: fileName });
        continue;
      }
      // 压缩包里的图片是用户主动打包的，不存在正文内嵌 logo 的干扰，只做体积下限过滤。
      if (isImageAttachment(entryName, "", entryData) && entryData.length >= MIN_IMAGE_ATTACHMENT_BYTES) {
        await addAttachmentItem({
          data: entryData,
          fileName: entryName,
          kind: "image",
          fallbackExt: hasPngSignature(entryData) ? ".png" : ".jpg",
          uid,
          subject,
          sourceDate,
          items,
          stats,
          tempRoot,
          parsePdfFile,
          viaZip: fileName,
        });
      }
    }
    return;
  }

  stats.unsupportedAttachments += 1;
}

async function addAttachmentItem({ data, fileName, kind, fallbackExt, uid, subject, sourceDate, items, stats, tempRoot, parsePdfFile, viaZip }) {
  const isImage = kind === "image";
  if (isImage) stats.imageCount += 1;
  else stats.pdfCount += 1;

  const ext = fallbackExt || ".pdf";
  const safeName = sanitizeFileName(fileName, `发票_${uid}_${stats.pdfCount + stats.imageCount}${ext}`);
  const tempPath = path.join(tempRoot, `${uid}_${items.length}_${safeName}`);
  await writeFile(tempPath, data);

  let parsed = { amount: null, invoiceNo: "", invoiceDate: "", pageCount: 1 };
  try {
    parsed = await parsePdfFile(tempPath);
  } catch {
    stats.parseFailures += 1;
  }

  items.push({
    uid,
    fileName: safeName,
    mimeType: isImage ? (/\.png$/i.test(safeName) ? "image/png" : "image/jpeg") : "application/pdf",
    size: data.length,
    data,
    fileHash: createHash("sha256").update(data).digest("hex"),
    amount: parsed?.amount ?? null,
    invoiceNo: parsed?.invoiceNo || "",
    invoiceDate: parsed?.invoiceDate || "",
    pageCount: parsed?.pageCount || 1,
    subject,
    sourceDate: sourceDate || "",
    viaZip: viaZip || "",
  });
}


function normalizeSyncRange(range) {
  if (!range) return null;
  const startTime = new Date(range.startTime);
  const endTime = new Date(range.endTime);
  if (Number.isNaN(startTime.getTime()) || Number.isNaN(endTime.getTime()) || startTime >= endTime) return null;
  return { startTime, endTime };
}

function isWithinRange(date, range) {
  const value = new Date(date).getTime();
  return Number.isFinite(value) && value >= range.startTime.getTime() && value <= range.endTime.getTime();
}

function dayAfter(date) {
  const value = new Date(date);
  value.setDate(value.getDate() + 1);
  value.setHours(0, 0, 0, 0);
  return value;
}

function formatDateTime(date) {
  const value = new Date(date);
  if (Number.isNaN(value.getTime())) return "";
  const hours = String(value.getHours()).padStart(2, "0");
  const minutes = String(value.getMinutes()).padStart(2, "0");
  return `${isoDay(value)} ${hours}:${minutes}`;
}

function isoDay(date) {
  const value = new Date(date);
  if (Number.isNaN(value.getTime())) return "";
  const month = String(value.getMonth() + 1).padStart(2, "0");
  const day = String(value.getDate()).padStart(2, "0");
  return `${value.getFullYear()}-${month}-${day}`;
}

function toIsoString(date) {
  if (!date) return "";
  const value = new Date(date);
  return Number.isNaN(value.getTime()) ? "" : value.toISOString();
}

function sanitizeFileName(name, fallback) {
  const cleaned = String(name || "")
    .replace(/[\x00-\x1f\\/:*?"<>|]/g, "_")
    .trim();
  if (!cleaned) return fallback;
  if (/\.(pdf|png|jpe?g)$/i.test(cleaned)) return cleaned;
  return `${cleaned}${path.extname(fallback) || ".pdf"}`;
}

const utf8Strict = new TextDecoder("utf-8", { fatal: true });
let gbDecoder = null;
try {
  gbDecoder = new TextDecoder("gb18030");
} catch {
  gbDecoder = null;
}

// 国内平台生成的 ZIP 常用 GBK 文件名，jszip 默认按 UTF-8 解码会乱码
function decodeZipFileName(bytes) {
  try {
    return utf8Strict.decode(bytes);
  } catch {
    // 不是合法 UTF-8，尝试 GB18030
  }
  if (gbDecoder) {
    try {
      return gbDecoder.decode(bytes);
    } catch {
      // 继续走兜底
    }
  }
  return Buffer.from(bytes).toString("latin1");
}

