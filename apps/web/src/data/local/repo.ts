import type { LocalDraft, LocalRecord } from '@gms/contracts';

/**
 * 本地仓库（T06）：IndexedDB 原子写。
 * - drafts：草稿，仅此设备，不进入趋势/导出
 * - records：点击保存后的正式记录，状态 pending（已保存到此设备，待同步）
 * 写入失败时不返回成功，调用方据此提示“保存失败”并保留表单内容。
 */

const DB_NAME = 'gms-local';
const DB_VERSION = 1;
export const LOCAL_ACCOUNT = 'local-user';

let dbPromise: Promise<IDBDatabase> | null = null;

function openDB(): Promise<IDBDatabase> {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains('records')) {
        const store = db.createObjectStore('records', { keyPath: 'id' });
        store.createIndex('periodKey', 'periodKey');
        store.createIndex('kind_period', ['kind', 'periodKey']);
      }
      if (!db.objectStoreNames.contains('drafts')) {
        db.createObjectStore('drafts', { keyPath: 'key' });
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error ?? new Error('IndexedDB 打开失败'));
  });
  return dbPromise;
}

function tx<T>(stores: string[], mode: IDBTransactionMode, fn: (t: IDBTransaction) => IDBRequest<T> | void): Promise<T> {
  return openDB().then(
    (db) =>
      new Promise<T>((resolve, reject) => {
        const t = db.transaction(stores, mode);
        let result: T;
        t.oncomplete = () => resolve(result as T);
        t.onerror = () => reject(t.error ?? new Error('事务失败'));
        t.onabort = () => reject(t.error ?? new Error('事务中止'));
        const req = fn(t);
        if (req) req.onsuccess = () => (result = req.result);
      }),
  );
}

export function uuid(): string {
  return crypto.randomUUID();
}

function nowIso(): string {
  return new Date().toISOString();
}

// ---------- 记录 ----------

export async function listAllRecords(): Promise<LocalRecord[]> {
  return tx(['records'], 'readonly', (t) => t.objectStore('records').getAll() as IDBRequest<LocalRecord[]>);
}

export function recordsOfDate(records: LocalRecord[], dateKey: string): LocalRecord[] {
  return records.filter((r) => r.kind !== 'month_note' && r.periodKey === dateKey);
}

/** 原子写：保存新版本 + 清除对应草稿，同一事务完成 */
export async function saveRecordAndClearDraft(record: LocalRecord, draftKey: string | null): Promise<void> {
  return openDB().then(
    (db) =>
      new Promise<void>((resolve, reject) => {
        const t = db.transaction(['records', 'drafts'], 'readwrite');
        const r = t.objectStore('records').put(record);
        if (draftKey) t.objectStore('drafts').delete(draftKey);
        t.oncomplete = () => resolve();
        t.onerror = () => reject(t.error ?? new Error('保存失败'));
        t.onabort = () => reject(t.error ?? new Error('保存中止'));
        void r;
      }),
  );
}

export async function softDeleteRecord(id: string): Promise<LocalRecord | null> {
  const all = await listAllRecords();
  const rec = all.find((r) => r.id === id);
  if (!rec) return null;
  const updated: LocalRecord = { ...rec, deletedAt: nowIso(), version: rec.version + 1, updatedAt: nowIso() };
  await tx(['records'], 'readwrite', (t) => t.objectStore('records').put(updated));
  return updated;
}

// ---------- 草稿 ----------

export function draftKeyFor(periodKey: string, kind: string, slot: string, entryId: string | null): string {
  return entryId ? `${periodKey}:${kind}:${slot}:${entryId}` : `${periodKey}:${kind}:${slot}:new`;
}

export async function putDraft(draft: LocalDraft): Promise<void> {
  return tx(['drafts'], 'readwrite', (t) => {
    t.objectStore('drafts').put(draft);
  });
}

export async function getDraft(key: string): Promise<LocalDraft | undefined> {
  return tx(['drafts'], 'readonly', (t) => t.objectStore('drafts').get(key) as IDBRequest<LocalDraft | undefined>);
}

export async function deleteDraft(key: string): Promise<void> {
  return tx(['drafts'], 'readwrite', (t) => {
    t.objectStore('drafts').delete(key);
  });
}

export async function listDrafts(): Promise<LocalDraft[]> {
  return tx(['drafts'], 'readonly', (t) => t.objectStore('drafts').getAll() as IDBRequest<LocalDraft[]>);
}

export async function clearAllLocal(): Promise<void> {
  return tx(['records', 'drafts'], 'readwrite', (t) => {
    t.objectStore('records').clear();
    t.objectStore('drafts').clear();
  });
}
