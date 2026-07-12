import { openDB } from "idb";

const DB_NAME = "reimbursement-app";
const DB_VERSION = 1;

let dbPromise;

function getDb() {
  if (!dbPromise) {
    dbPromise = openDB(DB_NAME, DB_VERSION, {
      upgrade(db) {
        const reimbursements = db.createObjectStore("reimbursements", { keyPath: "id" });
        reimbursements.createIndex("createdAt", "createdAt");

        const documents = db.createObjectStore("documents", { keyPath: "id" });
        documents.createIndex("reimbursementId", "reimbursementId");
        documents.createIndex("uploadedAt", "uploadedAt");
      },
    });
  }
  return dbPromise;
}

export function makeId(prefix) {
  if (crypto.randomUUID) return `${prefix}_${crypto.randomUUID()}`;
  return `${prefix}_${Date.now()}_${Math.random().toString(16).slice(2)}`;
}

export async function listReimbursements() {
  const db = await getDb();
  const reimbursements = await db.getAll("reimbursements");
  const documents = await db.getAll("documents");
  const stats = new Map();

  for (const doc of documents) {
    const current = stats.get(doc.reimbursementId) || { count: 0, total: 0 };
    current.count += 1;
    current.total += Number(doc.amount || 0);
    stats.set(doc.reimbursementId, current);
  }

  return reimbursements
    .map((item) => ({
      ...item,
      documentCount: stats.get(item.id)?.count || 0,
      totalAmount: stats.get(item.id)?.total || 0,
    }))
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

export async function createReimbursement(name) {
  const db = await getDb();
  const item = {
    id: makeId("r"),
    name: name.trim(),
    createdAt: new Date().toISOString(),
  };
  await db.add("reimbursements", item);
  return item;
}

export async function updateReimbursement(id, changes) {
  const db = await getDb();
  const item = await db.get("reimbursements", id);
  if (!item) return null;
  const updated = { ...item, ...changes };
  await db.put("reimbursements", updated);
  return updated;
}

export async function deleteReimbursement(id) {
  const db = await getDb();
  const tx = db.transaction(["reimbursements", "documents"], "readwrite");
  await tx.objectStore("reimbursements").delete(id);
  const index = tx.objectStore("documents").index("reimbursementId");
  let cursor = await index.openCursor(id);
  while (cursor) {
    await cursor.delete();
    cursor = await cursor.continue();
  }
  await tx.done;
}

export async function listDocuments(reimbursementId) {
  const db = await getDb();
  const docs = await db.getAllFromIndex("documents", "reimbursementId", reimbursementId);
  return docs.sort((a, b) => b.uploadedAt.localeCompare(a.uploadedAt));
}

export async function listAllDocuments() {
  const db = await getDb();
  return db.getAll("documents");
}

export async function addDocument(document) {
  const db = await getDb();
  await db.add("documents", document);
  return document;
}

export async function updateDocument(id, changes) {
  const db = await getDb();
  const item = await db.get("documents", id);
  if (!item) return null;
  const updated = { ...item, ...changes };
  await db.put("documents", updated);
  return updated;
}

export async function deleteDocuments(ids) {
  const db = await getDb();
  const tx = db.transaction("documents", "readwrite");
  await Promise.all(ids.map((id) => tx.store.delete(id)));
  await tx.done;
}
