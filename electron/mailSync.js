import { app, safeStorage } from "electron";
import { createRequire } from "node:module";
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
  days: 90,
  subjectKeyword: "",
};

const MAX_MESSAGE_BYTES = 60 * 1024 * 1024;
const MAX_ATTACHMENT_BYTES = 30 * 1024 * 1024;

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

export async function syncMailbox({ state, onProgress = () => {}, parsePdfFile }) {
  const { config, authCode } = resolveRuntimeConfig();
  if (!config.user || !authCode) {
    return { ok: false, needsConfig: true, error: "请先在邮箱设置中填写账号和授权码" };
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
        if (state && String(state.uidValidity) === uidValidity && Number(state.lastUid) > 0) {
          baseline = Math.floor(Number(state.lastUid));
          query = { uid: `${baseline + 1}:*` };
        } else {
          const days = Math.max(1, Number(config.days) || DEFAULT_CONFIG.days);
          query = { since: new Date(Date.now() - days * 86400000) };
        }

        onProgress("正在查找新邮件…");
        let uids = (await client.search(query, { uid: true })) || [];
        uids = [...new Set(uids)].filter((uid) => uid > baseline).sort((a, b) => a - b);

        const stats = { scanned: uids.length, matchedMessages: 0, pdfCount: 0, zipCount: 0, skippedOfd: 0, parseFailures: 0 };
        const items = [];
        const keyword = String(config.subjectKeyword || "").trim().toLowerCase();

        const candidates = [];
        if (uids.length > 0) {
          for await (const message of client.fetch(uids, { uid: true, envelope: true, bodyStructure: true, size: true }, { uid: true })) {
            const subject = message.envelope?.subject || "";
            if (keyword && !subject.toLowerCase().includes(keyword)) continue;
            if (Number(message.size || 0) > MAX_MESSAGE_BYTES) continue;
            if (!hasCandidateAttachment(message.bodyStructure)) continue;
            candidates.push({ uid: message.uid, subject });
          }
        }
        stats.matchedMessages = candidates.length;

        const { simpleParser } = loadDeps();
        let index = 0;
        for (const candidate of candidates) {
          index += 1;
          onProgress(`正在处理附件邮件 ${index}/${candidates.length}…`);
          const full = await client.fetchOne(candidate.uid, { uid: true, source: true }, { uid: true });
          if (!full?.source) continue;
          const mail = await simpleParser(full.source);
          const subject = mail.subject || candidate.subject || "";
          if (keyword && !subject.toLowerCase().includes(keyword)) continue;
          for (const attachment of mail.attachments || []) {
            await collectAttachment({ attachment, uid: candidate.uid, subject, items, stats, tempRoot, parsePdfFile });
          }
        }

        const maxScanned = uids.length > 0 ? uids[uids.length - 1] : 0;
        const newState = {
          uidValidity,
          lastUid: Math.max(baseline, uidNext > 0 ? uidNext - 1 : 0, maxScanned),
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

function hasCandidateAttachment(node) {
  if (!node) return false;
  const stack = [node];
  while (stack.length > 0) {
    const current = stack.pop();
    if (Array.isArray(current.childNodes)) stack.push(...current.childNodes);
    const filename = current.dispositionParameters?.filename || current.parameters?.name || "";
    const type = String(current.type || "").toLowerCase();
    if (/\.(pdf|zip|ofd)$/i.test(filename)) return true;
    if (["application/pdf", "application/zip", "application/x-zip-compressed", "application/octet-stream"].includes(type)) return true;
    if (String(current.disposition || "").toLowerCase() === "attachment") return true;
  }
  return false;
}

function isPdfAttachment(fileName, contentType) {
  return /\.pdf$/i.test(fileName) || contentType === "application/pdf";
}

function isZipAttachment(fileName, contentType) {
  return /\.zip$/i.test(fileName) || contentType === "application/zip" || contentType === "application/x-zip-compressed";
}

function isOfdAttachment(fileName, contentType) {
  return /\.ofd$/i.test(fileName) || contentType === "application/ofd";
}

async function collectAttachment({ attachment, uid, subject, items, stats, tempRoot, parsePdfFile }) {
  const content = attachment.content;
  if (!content?.length || content.length > MAX_ATTACHMENT_BYTES) return;
  const fileName = String(attachment.filename || "").trim();
  const contentType = String(attachment.contentType || "").toLowerCase();

  if (isOfdAttachment(fileName, contentType)) {
    stats.skippedOfd += 1;
    return;
  }

  if (isZipAttachment(fileName, contentType)) {
    stats.zipCount += 1;
    const { JSZip } = loadDeps();
    let zip;
    try {
      zip = await JSZip.loadAsync(content, { decodeFileName: decodeZipFileName });
    } catch {
      return;
    }
    for (const entry of Object.values(zip.files)) {
      if (entry.dir) continue;
      const entryName = entry.name.split("/").pop() || "";
      if (/\.ofd$/i.test(entryName)) {
        stats.skippedOfd += 1;
        continue;
      }
      if (!/\.pdf$/i.test(entryName)) continue;
      let entryData;
      try {
        entryData = await entry.async("nodebuffer");
      } catch {
        continue;
      }
      if (!entryData?.length || entryData.length > MAX_ATTACHMENT_BYTES) continue;
      await addPdfItem({ data: entryData, fileName: entryName, uid, subject, items, stats, tempRoot, parsePdfFile, viaZip: fileName });
    }
    return;
  }

  if (isPdfAttachment(fileName, contentType)) {
    await addPdfItem({ data: content, fileName, uid, subject, items, stats, tempRoot, parsePdfFile, viaZip: "" });
  }
}

async function addPdfItem({ data, fileName, uid, subject, items, stats, tempRoot, parsePdfFile, viaZip }) {
  stats.pdfCount += 1;
  const safeName = sanitizeFileName(fileName, `发票_${uid}_${stats.pdfCount}.pdf`);
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
    size: data.length,
    data,
    amount: parsed?.amount ?? null,
    invoiceNo: parsed?.invoiceNo || "",
    invoiceDate: parsed?.invoiceDate || "",
    pageCount: parsed?.pageCount || 1,
    subject,
    viaZip: viaZip || "",
  });
}

function sanitizeFileName(name, fallback) {
  const cleaned = String(name || "")
    .replace(/[\x00-\x1f\\/:*?"<>|]/g, "_")
    .trim();
  if (!cleaned) return fallback;
  return /\.pdf$/i.test(cleaned) ? cleaned : `${cleaned}.pdf`;
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
