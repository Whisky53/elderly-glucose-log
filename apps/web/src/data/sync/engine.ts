import type { LocalRecord } from '@gms/contracts';
import { ApiError, api } from '../api/client';
import {
  LOCAL_ACCOUNT,
  META_KEYS,
  applyRemoteRecords,
  bodyOfRecord,
  clearSession,
  commitMutationResult,
  deleteOutbox,
  findOutboxByRecord,
  forceApplyRemote,
  getMeta,
  hardDeleteRecord,
  listAllRecords,
  listOutbox,
  pruneLocalRecords,
  putOutbox,
  retagAccount,
  setMeta,
  uuid,
  type OutboxEntry,
} from '../local/repo';

/**
 * 同步引擎（架构 §6 状态机的前端实现）。
 *
 * 顺序：先发送本机队列，再拉增量（避免用远端覆盖尚未上传的本地编辑）。
 * 冲突不自动解决：版本不一致时挂起该记录，交给用户在设置页明确选择以哪边为准，
 * 因为“几条血糖记录到底该听谁的”不该由程序替用户猜。
 */

export type SyncPhase =
  | 'signed_out'
  | 'idle'
  | 'syncing'
  | 'offline'
  | 'conflict'
  | 'needs_attention'
  | 'needs_auth';

export type SyncStatus = {
  signedIn: boolean;
  username: string | null;
  /** 当前账户 id；未登录为 null。新建记录按此归属，而非本机占位账户 */
  accountId: string | null;
  phase: SyncPhase;
  pending: number;
  conflicts: number;
  failed: number;
  lastSyncAt: string | null;
  message: string | null;
};

const EMPTY_STATUS: SyncStatus = {
  signedIn: false,
  username: null,
  accountId: null,
  phase: 'signed_out',
  pending: 0,
  conflicts: 0,
  failed: 0,
  lastSyncAt: null,
  message: null,
};

const AUTO_SYNC_INTERVAL_MS = 30_000;

class SyncEngine {
  private listeners = new Set<(status: SyncStatus) => void>();
  private current: SyncStatus = { ...EMPTY_STATUS };
  private running: Promise<void> | null = null;
  private timer: number | null = null;

  // ---------- 订阅 ----------

  subscribe(listener: (status: SyncStatus) => void): () => void {
    this.listeners.add(listener);
    listener(this.current);
    return () => {
      this.listeners.delete(listener);
    };
  }

  status(): SyncStatus {
    return this.current;
  }

  private patch(next: Partial<SyncStatus>): void {
    this.current = { ...this.current, ...next };
    for (const l of this.listeners) l(this.current);
  }

  // ---------- 启动 ----------

  /** 恢复会话；令牌无效则回到未登录态（不清除本地数据） */
  async init(): Promise<void> {
    const token = await getMeta(META_KEYS.token);
    const username = await getMeta(META_KEYS.username);
    const lastSyncAt = await getMeta(META_KEYS.lastSyncAt);
    await this.refreshCounts();

    if (!token) {
      this.patch({ ...EMPTY_STATUS, pending: this.current.pending, failed: this.current.failed });
      return;
    }

    api.setToken(token);
    try {
      const me = await api.me();
      await setMeta(META_KEYS.accountId, me.account.id);
      this.patch({
        signedIn: true,
        username: me.account.username,
        accountId: me.account.id,
        phase: 'idle',
        lastSyncAt,
        message: null,
      });
      await this.syncNow();
    } catch (err) {
      if (err instanceof ApiError && (err.code === 'SESSION_EXPIRED' || err.status === 401)) {
        // 会话过期但保留本地数据与待同步队列（架构 §6：401 保留草稿并要求登录）
        await clearSession();
        api.setToken(null);
        this.patch({
          signedIn: false,
          username: null,
          accountId: null,
          phase: 'needs_auth',
          message: '登录已过期，请重新登录',
        });
      } else {
        this.patch({ signedIn: true, username, accountId: await getMeta(META_KEYS.accountId), phase: 'offline', message: '暂时无法连接服务器' });
      }
    }
    this.startAutoSync();
  }

  private startAutoSync(): void {
    if (this.timer !== null) return;
    this.timer = window.setInterval(() => {
      if (this.current.signedIn && !document.hidden) void this.syncNow();
    }, AUTO_SYNC_INTERVAL_MS);
    window.addEventListener('online', () => {
      if (this.current.signedIn) void this.syncNow();
    });
    document.addEventListener('visibilitychange', () => {
      // 回到前台立即补一次（浏览器关闭期间不承诺同步执行）
      if (!document.hidden && this.current.signedIn) void this.syncNow();
    });
  }

  async refreshCounts(): Promise<void> {
    const entries = await listOutbox();
    this.patch({
      pending: entries.length,
      conflicts: entries.filter((e) => e.conflict).length,
      failed: entries.filter((e) => !e.conflict && e.lastError !== null).length,
    });
  }

  // ---------- 登录 / 退出 ----------

  async login(username: string, password: string): Promise<void> {
    const res = await api.login(username, password);
    api.setToken(res.token);
    await setMeta(META_KEYS.token, res.token);
    await setMeta(META_KEYS.accountId, res.account.id);
    await setMeta(META_KEYS.username, res.account.username);
    this.patch({
      signedIn: true,
      username: res.account.username,
      accountId: res.account.id,
      phase: 'idle',
      message: null,
    });

    // 本机已有的旧数据归属到该账户并排队上传
    const adopted = await retagAccount(LOCAL_ACCOUNT, res.account.id);
    for (const record of adopted) {
      const entry = await planSaveMutation(record, false);
      if (entry) await putOutbox(entry);
    }
    if (adopted.length > 0) {
      this.patch({ message: `已把本机 ${adopted.length} 条记录归属到该账户，正在上传` });
    }

    await this.refreshCounts();
    await this.syncNow();
  }

  async logout(): Promise<void> {
    try {
      if (api.hasToken()) await api.logout();
    } catch {
      /* 登出失败也要清本地会话，避免卡在过期令牌上 */
    }
    api.setToken(null);
    // 保留本地记录与未同步队列：重新登录后可继续上传
    await clearSession();
    this.patch({ ...EMPTY_STATUS, pending: this.current.pending, phase: 'signed_out', message: null });
    await this.refreshCounts();
  }

  private async markSignedOut(message: string): Promise<void> {
    api.setToken(null);
    await clearSession();
    this.patch({ signedIn: false, username: null, accountId: null, phase: 'needs_auth', message });
  }

  // ---------- 同步主流程 ----------

  syncNow(): Promise<void> {
    if (!this.current.signedIn) return Promise.resolve();
    if (this.running) return this.running;
    this.running = this.runSync().finally(() => {
      this.running = null;
    });
    return this.running;
  }

  private async runSync(): Promise<void> {
    this.patch({ phase: 'syncing' });
    try {
      await this.push();
      await this.pull();
      const at = new Date().toISOString();
      await setMeta(META_KEYS.lastSyncAt, at);
      await setMeta(META_KEYS.lastError, '');
      await this.refreshCounts();
      const hasIssue = this.current.conflicts > 0 || this.current.failed > 0;
      this.patch({
        phase: hasIssue ? 'needs_attention' : 'idle',
        lastSyncAt: at,
        message: null,
      });
    } catch (err) {
      await this.refreshCounts();
      if (err instanceof ApiError && (err.code === 'SESSION_EXPIRED' || err.status === 401)) {
        await this.markSignedOut('登录已过期，请重新登录');
        return;
      }
      const message = err instanceof Error ? err.message : '同步失败';
      await setMeta(META_KEYS.lastError, message);
      this.patch({ phase: 'offline', message });
    }
  }

  /** 发送待同步队列：同一记录已有冲突挂起时跳过，等用户决定 */
  private async push(): Promise<void> {
    const entries = await listOutbox();
    for (const entry of entries) {
      if (entry.conflict) continue;
      try {
        const res = await api.mutate({
          mutationId: entry.mutationId,
          recordId: entry.recordId,
          action: entry.action,
          expectedVersion: entry.expectedVersion,
          ...(entry.record ? { record: entry.record } : {}),
        });
        await commitMutationResult(entry.mutationId, res.record);
      } catch (err) {
        if (!(err instanceof ApiError)) throw err;

        if (err.code === 'SESSION_EXPIRED' || err.status === 401) {
          await this.markSignedOut('登录已过期，请重新登录');
          return;
        }
        // 版本/槽位/不存在：需要人来决定，不自动覆盖
        if (err.code === 'VERSION_CONFLICT' || err.code === 'SLOT_EXISTS' || err.code === 'NOT_FOUND') {
          await putOutbox({ ...entry, conflict: true, lastError: err.message, attempts: entry.attempts + 1 });
          continue;
        }
        // 字段校验失败：内容本身有问题，重试无用
        if (err.status === 422 || err.code === 'VALIDATION_FAILED') {
          await putOutbox({ ...entry, lastError: err.message, attempts: entry.attempts + 1 });
          continue;
        }
        if (err.isRetryable) {
          await putOutbox({ ...entry, lastError: '网络或服务暂时不可用', attempts: entry.attempts + 1 });
          throw err;
        }
        await putOutbox({ ...entry, lastError: err.message, attempts: entry.attempts + 1 });
      }
    }
  }

  /** 拉取增量；游标缺失或过期时退回全量快照对账 */
  private async pull(): Promise<void> {
    const cursorRaw = await getMeta(META_KEYS.cursor);
    if (cursorRaw === null) {
      await this.fullResync();
      return;
    }
    let cursor = Number(cursorRaw);
    if (!Number.isFinite(cursor) || cursor < 0) cursor = 0;

    try {
      for (;;) {
        const page = await api.changes(cursor);
        const pendingIds = new Set((await listOutbox()).map((e) => e.recordId));
        const records = page.changes
          .map((c) => c.record)
          .filter((r): r is LocalRecord => r !== null);
        if (records.length > 0) await applyRemoteRecords(records, pendingIds);
        cursor = page.nextCursor;
        await setMeta(META_KEYS.cursor, String(cursor));
        if (!page.hasMore) break;
      }
    } catch (err) {
      if (err instanceof ApiError && err.code === 'CURSOR_EXPIRED') {
        await this.fullResync();
        return;
      }
      throw err;
    }
  }

  /** 全量对账：分页取快照，应用后清理本地多余记录，并把游标锚定到快照 seq */
  async fullResync(): Promise<void> {
    let pageToken: string | null = null;
    const collected: LocalRecord[] = [];
    let syncCursor = 0;
    for (;;) {
      const page = await api.snapshot(pageToken);
      collected.push(...page.records);
      syncCursor = page.syncCursor;
      pageToken = page.nextPageToken;
      if (!pageToken) break;
    }
    const pendingIds = new Set((await listOutbox()).map((e) => e.recordId));
    await applyRemoteRecords(collected, pendingIds);
    const keep = new Set<string>(collected.map((r) => r.id));
    for (const id of pendingIds) keep.add(id);
    await pruneLocalRecords(keep);
    await setMeta(META_KEYS.cursor, String(syncCursor));
    await this.refreshCounts();
  }

  // ---------- 冲突处理 ----------

  /** 以本机为准：用服务端当前版本作为基准重新提交 */
  async resolveTakeLocal(recordId: string): Promise<void> {
    const entry = await findOutboxByRecord(recordId);
    if (!entry) return;
    const local = (await listAllRecords()).find((r) => r.id === recordId);
    if (!local) {
      await deleteOutbox(entry.mutationId);
      await this.refreshCounts();
      return;
    }
    let expectedVersion = 0;
    let action: OutboxEntry['action'] = 'create';
    try {
      const remote = await api.getRecord(recordId);
      expectedVersion = remote.record.version;
      action = 'update';
    } catch (err) {
      if (err instanceof ApiError && err.code === 'NOT_FOUND') {
        // 服务端已删除该记录：本机内容作为新增重新提交
        expectedVersion = 0;
        action = 'create';
      } else {
        throw err;
      }
    }
    await putOutbox({
      ...entry,
      action,
      expectedVersion,
      record: bodyOfRecord(local),
      conflict: false,
      lastError: null,
      attempts: 0,
    });
    await this.refreshCounts();
    await this.syncNow();
  }

  /** 以云端为准：丢弃本机该条修改，用服务端版本覆盖 */
  async resolveTakeRemote(recordId: string): Promise<void> {
    const entry = await findOutboxByRecord(recordId);
    if (entry) await deleteOutbox(entry.mutationId);
    try {
      const remote = await api.getRecord(recordId);
      await forceApplyRemote(remote.record);
    } catch (err) {
      // 服务端没有这条记录：本机这条是仅在本地存在的，直接删掉
      if (err instanceof ApiError && err.code === 'NOT_FOUND') await hardDeleteRecord(recordId);
      else throw err;
    }
    await this.refreshCounts();
    await this.syncNow();
  }

  /** 放弃一条内容本身不合法的待同步变更（服务端校验不通过） */
  async discardFailed(recordId: string): Promise<void> {
    const entry = await findOutboxByRecord(recordId);
    if (entry) await deleteOutbox(entry.mutationId);
    await this.refreshCounts();
    this.patch({ phase: this.current.conflicts > 0 ? 'needs_attention' : 'idle' });
  }

  async listProblemEntries(): Promise<OutboxEntry[]> {
    const entries = await listOutbox();
    return entries.filter((e) => e.conflict || e.lastError !== null);
  }
}

export const sync = new SyncEngine();

// ---------- 变更计划：本机写入时决定入队内容 ----------

const nowIso = (): string => new Date().toISOString();

/**
 * 保存记录时的入队计划。
 * 同一记录已有待发变更时就地合并（架构 §6：未发送的连续修改可合并），
 * 已发出的修改不合并，因此 expectedVersion 沿用队列里那一版基准。
 */
export async function planSaveMutation(record: LocalRecord, hasAnchor: boolean): Promise<OutboxEntry> {
  const existing = await findOutboxByRecord(record.id);
  if (existing) {
    return {
      ...existing,
      // 尚未被服务端确认的 create 保持 create，避免变成对不存在记录的 update
      action: existing.action === 'create' ? 'create' : 'update',
      record: bodyOfRecord(record),
      lastError: null,
      conflict: false,
    };
  }
  return {
    mutationId: uuid(),
    recordId: record.id,
    action: hasAnchor ? 'update' : 'create',
    expectedVersion: hasAnchor ? Math.max(record.version - 1, 0) : 0,
    record: bodyOfRecord(record),
    enqueuedAt: nowIso(),
    attempts: 0,
    lastError: null,
    conflict: false,
  };
}

/**
 * 删除入队计划。
 *
 * 版本基准约定（容易搞错，务必留意）：调用方必须传入**本机改写之前**的记录，
 * 因为 delete/restore 不改动内容、只改删除标记，其 expectedVersion 就是
 * 「最后一次与服务端对齐的版本」，也就是 record.version 本身。
 * （对比 planSaveMutation：那里第一参数是已 +1 的新版本，所以基准要减 1。）
 * 同一记录已有待发变更时沿用队列里那一版基准，避免基准漂移。
 *
 * 若这条记录只在本地存在（create 尚未发出），返回 null，表示直接取消、不必往返服务端。
 */
export async function planDeleteMutation(record: LocalRecord): Promise<OutboxEntry | null> {
  const existing = await findOutboxByRecord(record.id);
  if (existing && existing.action === 'create') return null;
  return {
    mutationId: existing?.mutationId ?? uuid(),
    recordId: record.id,
    action: 'delete',
    expectedVersion: existing ? existing.expectedVersion : record.version,
    record: null,
    enqueuedAt: existing?.enqueuedAt ?? nowIso(),
    attempts: 0,
    lastError: null,
    conflict: false,
  };
}

/**
 * 恢复入队计划。同样要求传入**本机改写之前**的记录（见 planDeleteMutation 的版本基准约定）。
 * 若取消的是本机尚未发出的删除，改回 update 即可让服务端保持未删除状态。
 */
export async function planRestoreMutation(record: LocalRecord): Promise<OutboxEntry> {
  const existing = await findOutboxByRecord(record.id);
  const cancelPendingDelete = existing?.action === 'delete';
  return {
    mutationId: existing?.mutationId ?? uuid(),
    recordId: record.id,
    action: cancelPendingDelete ? 'update' : 'restore',
    expectedVersion: existing ? existing.expectedVersion : record.version,
    record: cancelPendingDelete ? bodyOfRecord(record) : null,
    enqueuedAt: existing?.enqueuedAt ?? nowIso(),
    attempts: 0,
    lastError: null,
    conflict: false,
  };
}
