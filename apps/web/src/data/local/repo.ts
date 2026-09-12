import type { LocalDraft, LocalRecord, RecordKind, RecordPayload } from '@gms/contracts';

/**
 * 本地仓库（T06 + T07—T09）。
 * - drafts：草稿，仅此设备，不进入趋势/导出
 * - records：正式记录本地副本
 * - outbox：待同步变更队列（本机写入与入队同一事务，保证不丢）
 * - meta：会话令牌、同步游标等技术状态
 *
 * 写入顺序遵循架构 §6：先本地事务成功（记录 + outbox 原子写入），
 * 再告诉用户“已保存到此设备”，同步由 SyncEngine 异步完成。
 */

const DB_NAME = 'gms-local';
const DB_VERSION = 2;
export const LOCAL_ACCOUNT = 'local-user';

export type MutationAction = 'create' | 'update' | 'delete' | 'restore';

export type OutboxEntry = {
  mutationId: string;
  recordId: string;
  action: MutationAction;
  expectedVersion: number;
  /** create/update 携带记录体；delete/restore 不需要 */
  record: RemoteRecordBody | null;
  enqueuedAt: string;
  attempts: number;
  /** 上次失败原因；用于状态栏与“需要处理”的提示 */
  lastError: string | null;
  /** 服务端版本冲突：需要用户决定以本机还是以云端为准 */
  conflict: boolean;
};

/** 提交给服务端的记录体（accountId 由服务端从会话推导） */
export type RemoteRecordBody = {
  kind: RecordKind;
  periodKey: string;
  slot: string;
  occurredAt: string | null;
  timePrecision: 'minute' | 'unknown';
  timezone: string;
  payload: RecordPayload;
};

export function bodyOfRecord(record: LocalRecord): RemoteRecordBody {
  return {
    kind: record.kind,
    periodKey: record.periodKey,
    slot: record.slot,
    occurredAt: record.occurredAt,
    timePrecision: record.timePrecision,
    timezone: record.timezone,
    payload: record.payload,
  };
}

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
      if (!db.objectStoreNames.contains('outbox')) {
        const outbox = db.createObjectStore('outbox', { keyPath: 'mutationId' });
        outbox.createIndex('recordId', 'recordId');
      }
      if (!db.objectStoreNames.contains('meta')) {
        db.createObjectStore('meta', { keyPath: 'key' });
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error ?? new Error('IndexedDB 打开失败'));
  });
  return dbPromise;
}

/** 在一个事务里同步执行若干操作；await 非 IDB 的 Promise 会让事务提前提交，故回调内保持同步 */
function runTx(stores: string[], mode: IDBTransactionMode, fn: (t: IDBTransaction) => void): Promise<void> {
  return openDB().then(
    (db) =>
      new Promise<void>((resolve, reject) => {
        const t = db.transaction(stores, mode);
        t.oncomplete = () => resolve();
        t.onerror = () => reject(t.error ?? new Error('事务失败'));
        t.onabort = () => reject(t.error ?? new Error('事务中止'));
        fn(t);
      }),
  );
}

function getAll<T>(store: IDBObjectStore): Promise<T[]> {
  return new Promise((resolve, reject) => {
    const req = store.getAll();
    req.onsuccess = () => resolve(req.result as T[]);
    req.onerror = () => reject(req.error ?? new Error('读取失败'));
  });
}

export function uuid(): string {
  return crypto.randomUUID();
}

function nowIso(): string {
  return new Date().toISOString();
}

// ---------- 记录 ----------

export async function listAllRecords(): Promise<LocalRecord[]> {
  const db = await openDB();
  return getAll<LocalRecord>(db.transaction('records', 'readonly').objectStore('records'));
}

export function recordsOfDate(records: LocalRecord[], dateKey: string): LocalRecord[] {
  return records.filter((r) => r.kind !== 'month_note' && r.periodKey === dateKey);
}

/**
 * 原子写：保存记录版本 + 清除对应草稿 + 写入待同步队列，同一事务完成。
 * 任一步失败都不会留下“已保存但没进队列”的记录。
 */
export async function saveRecordAndClearDraft(
  record: LocalRecord,
  draftKey: string | null,
  outbox?: OutboxEntry,
): Promise<void> {
  return runTx(['records', 'drafts', 'outbox'], 'readwrite', (t) => {
    t.objectStore('records').put(record);
    if (draftKey) t.objectStore('drafts').delete(draftKey);
    if (outbox) t.objectStore('outbox').put(outbox);
  });
}

export async function softDeleteRecord(id: string): Promise<LocalRecord | null> {
  const all = await listAllRecords();
  const rec = all.find((r) => r.id === id);
  if (!rec) return null;
  const updated: LocalRecord = { ...rec, deletedAt: nowIso(), version: rec.version + 1, updatedAt: nowIso() };
  await runTx(['records'], 'readwrite', (t) => {
    t.objectStore('records').put(updated);
  });
  return updated;
}

export async function restoreRecord(id: string): Promise<LocalRecord | null> {
  const all = await listAllRecords();
  const rec = all.find((r) => r.id === id);
  if (!rec) return null;
  const restored: LocalRecord = { ...rec, deletedAt: null, version: rec.version + 1, updatedAt: nowIso() };
  await runTx(['records'], 'readwrite', (t) => {
    t.objectStore('records').put(restored);
  });
  return restored;
}

/** 把本机旧数据（local-user）归属到云端账户，返回被改写的记录，供调用方入队上传 */
export async function retagAccount(fromAccountId: string, toAccountId: string): Promise<LocalRecord[]> {
  const all = await listAllRecords();
  const affected = all.filter((r) => r.accountId === fromAccountId);
  if (affected.length === 0) return [];
  const rewritten = affected.map((r) => ({ ...r, accountId: toAccountId }));
  await runTx(['records'], 'readwrite', (t) => {
    const store = t.objectStore('records');
    for (const r of rewritten) store.put(r);
  });
  return rewritten;
}

/**
 * 应用服务端记录（增量变更或全量快照）。
 * - 有未同步本地修改的记录跳过，避免远端覆盖本机正在编辑的内容（架构 §6）
 * - 版本不高于本机则跳过，保证幂等重放安全
 */
export async function applyRemoteRecords(
  incoming: LocalRecord[],
  pendingRecordIds: ReadonlySet<string>,
): Promise<{ applied: number; skipped: number }> {
  const existing = await listAllRecords();
  const localById = new Map(existing.map((r) => [r.id, r]));
  const toPut: LocalRecord[] = [];
  let skipped = 0;

  for (const incomingRecord of incoming) {
    if (pendingRecordIds.has(incomingRecord.id)) {
      skipped += 1;
      continue;
    }
    const local = localById.get(incomingRecord.id);
    if (local && local.version >= incomingRecord.version) {
      skipped += 1;
      continue;
    }
    toPut.push(incomingRecord);
  }

  if (toPut.length > 0) {
    await runTx(['records'], 'readwrite', (t) => {
      const store = t.objectStore('records');
      for (const r of toPut) store.put(r);
    });
  }
  return { applied: toPut.length, skipped };
}

/**
 * 全量对账后清理：删除本地存在但服务端快照里没有、且不在待同步队列里的记录。
 * 处理“另一台设备新增后又被删除”这类本地无法从增量推断的情况。
 */
export async function pruneLocalRecords(keepIds: ReadonlySet<string>): Promise<number> {
  const existing = await listAllRecords();
  const stale = existing.filter((r) => !keepIds.has(r.id));
  if (stale.length === 0) return 0;
  await runTx(['records'], 'readwrite', (t) => {
    const store = t.objectStore('records');
    for (const r of stale) store.delete(r.id);
  });
  return stale.length;
}

/** 冲突解决选择“以云端为准”：无条件用服务端版本覆盖本地 */
export async function forceApplyRemote(record: LocalRecord): Promise<void> {
  return runTx(['records'], 'readwrite', (t) => {
    t.objectStore('records').put(record);
  });
}

export async function hardDeleteRecord(id: string): Promise<void> {
  return runTx(['records'], 'readwrite', (t) => {
    t.objectStore('records').delete(id);
  });
}

// ---------- 草稿 ----------
export function draftKeyFor(periodKey: string, kind: string, slot: string, entryId: string | null): string {
  return entryId ? `${periodKey}:${kind}:${slot}:${entryId}` : `${periodKey}:${kind}:${slot}:new`;
}

export async function putDraft(draft: LocalDraft): Promise<void> {
  return runTx(['drafts'], 'readwrite', (t) => {
    t.objectStore('drafts').put(draft);
  });
}

export async function getDraft(key: string): Promise<LocalDraft | undefined> {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const req = db.transaction('drafts', 'readonly').objectStore('drafts').get(key);
    req.onsuccess = () => resolve(req.result as LocalDraft | undefined);
    req.onerror = () => reject(req.error ?? new Error('读取草稿失败'));
  });
}

export async function deleteDraft(key: string): Promise<void> {
  return runTx(['drafts'], 'readwrite', (t) => {
    t.objectStore('drafts').delete(key);
  });
}

export async function listDrafts(): Promise<LocalDraft[]> {
  const db = await openDB();
  return getAll<LocalDraft>(db.transaction('drafts', 'readonly').objectStore('drafts'));
}

// ---------- 待同步队列 ----------

export async function listOutbox(): Promise<OutboxEntry[]> {
  const db = await openDB();
  const list = await getAll<OutboxEntry>(db.transaction('outbox', 'readonly').objectStore('outbox'));
  return list.sort((a, b) => (a.enqueuedAt < b.enqueuedAt ? -1 : a.enqueuedAt > b.enqueuedAt ? 1 : 0));
}

export async function putOutbox(entry: OutboxEntry): Promise<void> {
  return runTx(['outbox'], 'readwrite', (t) => {
    t.objectStore('outbox').put(entry);
  });
}

export async function deleteOutbox(mutationId: string): Promise<void> {
  return runTx(['outbox'], 'readwrite', (t) => {
    t.objectStore('outbox').delete(mutationId);
  });
}

/** 记录级去重：同一记录已有待发变更时，合并为一条，避免重复插入 */
export async function findOutboxByRecord(recordId: string): Promise<OutboxEntry | null> {
  const db = await openDB();
  const store = db.transaction('outbox', 'readonly').objectStore('outbox');
  const list = await new Promise<OutboxEntry[]>((resolve, reject) => {
    const req = store.index('recordId').getAll(recordId);
    req.onsuccess = () => resolve(req.result as OutboxEntry[]);
    req.onerror = () => reject(req.error ?? new Error('读取待同步队列失败'));
  });
  return list[0] ?? null;
}

/**
 * 服务端确认后：把服务端返回的记录写回本地（版本号以服务端为准）+ 移除队列条目。
 * 同一事务完成，避免“队列已清空但本地版本仍是旧的”导致下次重复提交。
 */
export async function commitMutationResult(mutationId: string, serverRecord: LocalRecord): Promise<void> {
  const all = await listAllRecords();
  const local = all.find((r) => r.id === serverRecord.id);
  // 本地在发送后又改过（版本更高）则保留本地内容，仅更新基准版本
  const merged: LocalRecord =
    local && local.version > serverRecord.version
      ? { ...local, createdAt: serverRecord.createdAt }
      : serverRecord;
  return runTx(['records', 'outbox'], 'readwrite', (t) => {
    t.objectStore('records').put(merged);
    t.objectStore('outbox').delete(mutationId);
  });
}

// ---------- meta（令牌 / 游标 / 同步状态） ----------

export const META_KEYS = {
  token: 'token',
  accountId: 'accountId',
  username: 'username',
  cursor: 'cursor',
  lastSyncAt: 'lastSyncAt',
  lastError: 'lastError',
  /** 用户主动选择“只在本机记录”，不阻止使用，也不反复弹登录 */
  localOnly: 'localOnly',
} as const;

export async function getMeta(key: string): Promise<string | null> {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const req = db.transaction('meta', 'readonly').objectStore('meta').get(key);
    req.onsuccess = () => {
      const row = req.result as { key: string; value: string } | undefined;
      resolve(row ? row.value : null);
    };
    req.onerror = () => reject(req.error ?? new Error('读取状态失败'));
  });
}

export async function setMeta(key: string, value: string): Promise<void> {
  return runTx(['meta'], 'readwrite', (t) => {
    t.objectStore('meta').put({ key, value });
  });
}

export async function deleteMeta(key: string): Promise<void> {
  return runTx(['meta'], 'readwrite', (t) => {
    t.objectStore('meta').delete(key);
  });
}

/** 退出登录：清除会话与游标，保留未同步队列以便重新登录后继续上传 */
export async function clearSession(): Promise<void> {
  return runTx(['meta'], 'readwrite', (t) => {
    const store = t.objectStore('meta');
    for (const k of [META_KEYS.token, META_KEYS.accountId, META_KEYS.username, META_KEYS.cursor, META_KEYS.lastError]) {
      store.delete(k);
    }
  });
}

/**
 * 清空本机缓存。不会删除云端记录——游标归零后重新同步会把云端数据拉回来。
 * 待同步队列一并清空，因此本机未上传的修改会丢失，调用方必须明确告知用户。
 */
export async function clearLocalCache(): Promise<void> {
  return runTx(['records', 'drafts', 'outbox', 'meta'], 'readwrite', (t) => {
    t.objectStore('records').clear();
    t.objectStore('drafts').clear();
    t.objectStore('outbox').clear();
    const meta = t.objectStore('meta');
    for (const k of [META_KEYS.cursor, META_KEYS.lastError, META_KEYS.lastSyncAt]) meta.delete(k);
  });
}
