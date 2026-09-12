/**
 * API 路由与业务逻辑（架构 §5 契约、§5.1 写事务、§6 同步状态机服务端部分）。
 *
 * 写路径要点：
 * - 幂等：唯一 (account_id, mutation_id)；同 hash 直接回放原响应，不同 hash 拒绝重用幂等键。
 * - 并发：BEGIN IMMEDIATE 取写锁，账户内串行分配 seq，保证变更流水与提交顺序一致。
 * - 版本：update/delete/restore 必须携带 expectedVersion，不匹配返回 409 VERSION_CONFLICT。
 * - 授权：account_id 一律由会话推导，绝不采信请求体里的 accountId。
 */
import { createHash, randomUUID } from 'node:crypto';
import type { LocalRecord, RecordKind, RecordPayload } from '@gms/contracts';
import { isUniqueSlot } from '@gms/domain';
import type { Db } from './db';
import { inTransaction } from './db';
import { CONFIG } from './config';
import { authenticate, changePassword, createSession, ensureBootstrapAccount, revokeSession } from './auth';
import {
  ApiError,
  errors,
  type Ctx,
  type Handler,
  createRouter,
  readJsonBody,
  sendError,
  sendJson,
  logAccess,
  clientIp,
  bearerToken,
  newRequestId,
} from './http';
import { isRecordKind, validatePayload, validatePeriodKey, validateSlot } from './validate';

type Row = Record<string, unknown>;

const MAX_PAGE = 200;

// ---------- 行映射 ----------

function rowToRecord(row: Row): LocalRecord {
  return {
    id: String(row['id']),
    accountId: String(row['account_id']),
    kind: String(row['kind']) as RecordKind,
    periodKey: String(row['period_key']),
    slot: String(row['slot']),
    occurredAt: row['occurred_at'] === null || row['occurred_at'] === undefined ? null : String(row['occurred_at']),
    timePrecision: String(row['time_precision']) === 'minute' ? 'minute' : 'unknown',
    timezone: String(row['timezone']),
    payload: JSON.parse(String(row['payload'])) as RecordPayload,
    version: Number(row['version']),
    createdAt: String(row['created_at']),
    updatedAt: String(row['updated_at']),
    deletedAt: row['deleted_at'] === null || row['deleted_at'] === undefined ? null : String(row['deleted_at']),
  };
}

/** 稳定序列化，用于幂等请求指纹 */
function canonical(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  const obj = value as Record<string, unknown>;
  const keys = Object.keys(obj).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${canonical(obj[k])}`).join(',')}}`;
}

function requestHash(payload: unknown): string {
  return createHash('sha256').update(canonical(payload)).digest('hex');
}

// ---------- 账户内工具 ----------

function bumpSeq(db: Db, accountId: string): number {
  db.prepare('UPDATE account_sync_state SET last_seq = last_seq + 1 WHERE account_id = ?').run(accountId);
  const row = db.prepare('SELECT last_seq FROM account_sync_state WHERE account_id = ?').get(accountId) as
    | Row
    | undefined;
  if (!row) {
    db.prepare('INSERT INTO account_sync_state (account_id, last_seq) VALUES (?, 1)').run(accountId);
    return 1;
  }
  return Number(row['last_seq']);
}

function getRecord(db: Db, accountId: string, recordId: string): LocalRecord | null {
  const row = db
    .prepare('SELECT * FROM records WHERE id = ? AND account_id = ?')
    .get(recordId, accountId) as Row | undefined;
  return row ? rowToRecord(row) : null;
}

// ---------- 登录限流（内存，够单实例使用） ----------

const loginAttempts = new Map<string, { count: number; resetAt: number }>();
const LOGIN_WINDOW_MS = 5 * 60_000;
const LOGIN_MAX = 10;

function throttleLogin(ip: string): void {
  const now = Date.now();
  const entry = loginAttempts.get(ip);
  if (!entry || entry.resetAt < now) {
    loginAttempts.set(ip, { count: 1, resetAt: now + LOGIN_WINDOW_MS });
    return;
  }
  entry.count += 1;
  if (entry.count > LOGIN_MAX) throw errors.rateLimited();
}

// ---------- 路由 ----------

export function registerRoutes(db: Db) {
  const router = createRouter();

  // 健康检查：免鉴权，供 Nginx 与运维探活
  router.get('/healthz', () => ({ ok: true, time: new Date().toISOString() }), false);

  // ---- 认证 ----

  router.post(
    '/api/v1/auth/login',
    (ctx) => {
      throttleLogin(ctx.remoteIp);
      const username = typeof ctx.body['username'] === 'string' ? ctx.body['username'].trim() : '';
      const password = typeof ctx.body['password'] === 'string' ? ctx.body['password'] : '';
      if (!username || !password) {
        throw errors.validation([
          ...(username ? [] : [{ field: 'username', message: '请输入用户名' }]),
          ...(password ? [] : [{ field: 'password', message: '请输入密码' }]),
        ]);
      }
      const account = authenticate(db, username, password);
      if (!account) throw new ApiError(401, 'INVALID_CREDENTIALS', '用户名或密码不正确');
      const session = createSession(db, account.id);
      return {
        token: session.token,
        expiresAt: session.expiresAt,
        account: { id: account.id, username: account.username },
      };
    },
    false,
  );

  router.post('/api/v1/auth/logout', (ctx) => {
    if (ctx.token) revokeSession(db, ctx.token);
    return { ok: true };
  });

  router.get('/api/v1/auth/me', (ctx) => ({
    account: { id: ctx.account!.id, username: ctx.account!.username },
  }));

  router.post('/api/v1/auth/password', (ctx) => {
    const oldPassword = typeof ctx.body['oldPassword'] === 'string' ? ctx.body['oldPassword'] : '';
    const newPassword = typeof ctx.body['newPassword'] === 'string' ? ctx.body['newPassword'] : '';
    if (newPassword.length < 8) {
      throw errors.validation([{ field: 'newPassword', message: '新密码至少 8 位' }]);
    }
    if (!changePassword(db, ctx.account!.id, oldPassword, newPassword)) {
      throw errors.validation([{ field: 'oldPassword', message: '原密码不正确' }]);
    }
    // 作废该账户全部会话（含当前），客户端需要重新登录
    db.prepare('DELETE FROM sessions WHERE account_id = ?').run(ctx.account!.id);
    return { ok: true, reauthRequired: true };
  });

  // ---- 账户配置 ----

  router.get('/api/v1/profile', (ctx) => {
    const row = db.prepare('SELECT * FROM profile_settings WHERE account_id = ?').get(ctx.account!.id) as Row;
    return {
      glucoseUnit: String(row['glucose_unit']),
      weightUnit: String(row['weight_unit']),
      waterUnit: String(row['water_unit']),
      timezone: String(row['timezone']),
      version: Number(row['version']),
    };
  });

  router.patch('/api/v1/profile', (ctx) => {
    const accountId = ctx.account!.id;
    const row = db.prepare('SELECT * FROM profile_settings WHERE account_id = ?').get(accountId) as Row;
    const current = Number(row['version']);
    const expected = Number(ctx.body['expectedVersion']);
    if (!Number.isInteger(expected)) {
      throw errors.validation([{ field: 'expectedVersion', message: '缺少版本号' }]);
    }
    if (expected !== current) throw errors.versionConflict('账户配置已在其它设备被修改');

    const fields: Array<[string, string]> = [];
    for (const [key, column] of [
      ['glucoseUnit', 'glucose_unit'],
      ['weightUnit', 'weight_unit'],
      ['waterUnit', 'water_unit'],
      ['timezone', 'timezone'],
    ] as const) {
      const v = ctx.body[key];
      if (v === undefined) continue;
      if (typeof v !== 'string' || v.trim() === '') {
        throw errors.validation([{ field: key, message: '不能为空' }]);
      }
      fields.push([column, v.trim()]);
    }
    if (fields.length === 0) throw errors.validation([{ field: '__form', message: '没有需要更新的字段' }]);

    const now = new Date().toISOString();
    const sets = fields.map(([c]) => `${c} = ?`).join(', ');
    db.prepare(`UPDATE profile_settings SET ${sets}, version = version + 1, updated_at = ? WHERE account_id = ?`).run(
      ...fields.map(([, v]) => v),
      now,
      accountId,
    );
    const updated = db.prepare('SELECT * FROM profile_settings WHERE account_id = ?').get(accountId) as Row;
    return {
      glucoseUnit: String(updated['glucose_unit']),
      weightUnit: String(updated['weight_unit']),
      waterUnit: String(updated['water_unit']),
      timezone: String(updated['timezone']),
      version: Number(updated['version']),
    };
  });

  // ---- 读取：全量快照（游标过期后的对账基线） ----

  router.get('/api/v1/snapshot', (ctx) => {
    const accountId = ctx.account!.id;
    const limit = Math.min(Number(ctx.query.get('limit') ?? 100) || 100, MAX_PAGE);
    const from = ctx.query.get('from');
    const to = ctx.query.get('to');
    const token = ctx.query.get('cursor');

    let snapshotSeq: number;
    let offset = 0;
    let snapshotAt: string;
    if (token) {
      const parsed = parseSnapshotToken(token, accountId);
      snapshotSeq = parsed.snapshotSeq;
      offset = parsed.offset;
      snapshotAt = parsed.snapshotAt;
    } else {
      const state = db.prepare('SELECT last_seq FROM account_sync_state WHERE account_id = ?').get(accountId) as
        | Row
        | undefined;
      snapshotSeq = state ? Number(state['last_seq']) : 0;
      snapshotAt = new Date().toISOString();
    }

    const conditions = ['account_id = ?', 'created_at <= ?'];
    const params: Array<string | number> = [accountId, snapshotAt];
    if (from) {
      conditions.push('period_key >= ?');
      params.push(from);
    }
    if (to) {
      conditions.push('period_key <= ?');
      params.push(to);
    }

    // 按 id 排序保证分页稳定；快照时间锚定使分页期间新增记录不挤占偏移
    const rows = db
      .prepare(
        `SELECT * FROM records WHERE ${conditions.join(' AND ')} ORDER BY id ASC LIMIT ? OFFSET ?`,
      )
      .all(...params, limit + 1, offset) as Row[];
    const hasMore = rows.length > limit;
    const page = hasMore ? rows.slice(0, limit) : rows;
    const nextOffset = offset + page.length;

    return {
      snapshotSeq,
      snapshotAt,
      syncCursor: snapshotSeq,
      records: page.map(rowToRecord),
      hasMore,
      nextPageToken: hasMore ? formatSnapshotToken(accountId, snapshotSeq, snapshotAt, nextOffset) : null,
    };
  });

  // ---- 读取：增量变更流水（含墓碑） ----

  router.get('/api/v1/changes', (ctx) => {
    const accountId = ctx.account!.id;
    const limit = Math.min(Number(ctx.query.get('limit') ?? 200) || 200, MAX_PAGE);
    const cursorRaw = ctx.query.get('cursor');
    const cursor = cursorRaw ? Number(cursorRaw) : 0;
    if (!Number.isInteger(cursor) || cursor < 0) {
      throw errors.validation([{ field: 'cursor', message: '游标格式不正确' }]);
    }

    // 流水被清理且客户端游标落在缺口之前：无法补齐增量，要求重新快照
    const minRow = db.prepare('SELECT MIN(seq) AS m FROM changes WHERE account_id = ?').get(accountId) as Row;
    const minSeq = minRow['m'] === null || minRow['m'] === undefined ? null : Number(minRow['m']);
    if (minSeq !== null && cursor < minSeq - 1) throw errors.cursorExpired();

    const rows = db
      .prepare(
        `SELECT c.seq, c.record_id, c.version, c.action, c.committed_at, r.snapshot
           FROM changes c
           LEFT JOIN record_revisions r
             ON r.record_id = c.record_id AND r.version = c.version
          WHERE c.account_id = ? AND c.seq > ?
          ORDER BY c.seq ASC
          LIMIT ?`,
      )
      .all(accountId, cursor, limit + 1) as Row[];

    const hasMore = rows.length > limit;
    const page = hasMore ? rows.slice(0, limit) : rows;
    const lastSeq = page.length > 0 ? Number(page[page.length - 1]!['seq']) : cursor;

    return {
      changes: page.map((r) => ({
        seq: Number(r['seq']),
        recordId: String(r['record_id']),
        version: Number(r['version']),
        action: String(r['action']),
        committedAt: String(r['committed_at']),
        // 该 seq 对应的提交版本快照，而不是记录当前最新版本
        record: r['snapshot'] === null || r['snapshot'] === undefined ? null : JSON.parse(String(r['snapshot'])),
      })),
      nextCursor: lastSeq,
      hasMore,
    };
  });

  // ---- 读取：记录列表 ----

  router.get('/api/v1/records', (ctx) => {
    const accountId = ctx.account!.id;
    const limit = Math.min(Number(ctx.query.get('limit') ?? 100) || 100, MAX_PAGE);
    const offset = Math.max(Number(ctx.query.get('offset') ?? 0) || 0, 0);
    const conditions = ['account_id = ?'];
    const params: Array<string | number> = [accountId];
    const periodKey = ctx.query.get('periodKey');
    const kind = ctx.query.get('kind');
    const slot = ctx.query.get('slot');
    if (periodKey) {
      conditions.push('period_key = ?');
      params.push(periodKey);
    }
    if (kind) {
      if (!isRecordKind(kind)) throw errors.validation([{ field: 'kind', message: '记录类型不正确' }]);
      conditions.push('kind = ?');
      params.push(kind);
    }
    if (slot) {
      conditions.push('slot = ?');
      params.push(slot);
    }
    if (ctx.query.get('includeDeleted') !== '1') conditions.push('deleted_at IS NULL');
    const rows = db
      .prepare(`SELECT * FROM records WHERE ${conditions.join(' AND ')} ORDER BY period_key DESC, kind ASC, slot ASC LIMIT ? OFFSET ?`)
      .all(...params, limit, offset) as Row[];
    return { records: rows.map(rowToRecord) };
  });

  // 单条记录：冲突解决时用来读取服务端当前版本
  router.get('/api/v1/records/:id', (ctx) => {
    const record = getRecord(db, ctx.account!.id, ctx.params['id']!);
    if (!record) throw errors.notFound('记录不存在');
    return { record };
  });

  router.get('/api/v1/records/:id/revisions', (ctx) => {
    const accountId = ctx.account!.id;
    const recordId = ctx.params['id']!;
    const record = getRecord(db, accountId, recordId);
    if (!record) throw errors.notFound('记录不存在');
    const rows = db
      .prepare(
        `SELECT version, action, server_at, snapshot FROM record_revisions
          WHERE record_id = ? AND account_id = ? ORDER BY version DESC LIMIT 50`,
      )
      .all(recordId, accountId) as Row[];
    return {
      revisions: rows.map((r) => ({
        version: Number(r['version']),
        action: String(r['action']),
        serverAt: String(r['server_at']),
        record: JSON.parse(String(r['snapshot'])),
      })),
    };
  });

  // ---- 写入：单条原子提交 ----

  router.post('/api/v1/mutations', (ctx) => {
    const accountId = ctx.account!.id;
    const mutationId = ctx.body['mutationId'];
    const recordId = ctx.body['recordId'];
    const action = ctx.body['action'];
    if (typeof mutationId !== 'string' || mutationId.trim() === '') {
      throw errors.validation([{ field: 'mutationId', message: '缺少幂等键' }]);
    }
    if (typeof recordId !== 'string' || recordId.trim() === '') {
      throw errors.validation([{ field: 'recordId', message: '缺少记录 ID' }]);
    }
    if (action !== 'create' && action !== 'update' && action !== 'delete' && action !== 'restore') {
      throw errors.validation([{ field: 'action', message: '不支持的操作类型' }]);
    }
    const expectedVersion = Number(ctx.body['expectedVersion'] ?? 0);
    if (!Number.isInteger(expectedVersion) || expectedVersion < 0) {
      throw errors.validation([{ field: 'expectedVersion', message: '版本号不正确' }]);
    }

    // 幂等键必须在同一事务内检查与写入，避免两个并发重试都判定为“首次”
    const fingerprint = requestHash({ recordId, action, expectedVersion, record: ctx.body['record'] ?? null });

    return inTransaction(db, () => {
      const seen = db
        .prepare('SELECT request_hash, response FROM mutations WHERE account_id = ? AND mutation_id = ?')
        .get(accountId, mutationId) as Row | undefined;
      if (seen) {
        if (String(seen['request_hash']) !== fingerprint) {
          throw errors.validation([
            { field: 'mutationId', message: '该幂等键已用于不同的请求内容，请更换 mutationId' },
          ]);
        }
        return JSON.parse(String(seen['response']));
      }

      const now = new Date().toISOString();
      let result: { record: LocalRecord; version: number; commitSeq: number };

      if (action === 'delete' || action === 'restore') {
        const current = getRecord(db, accountId, recordId);
        if (!current) throw errors.notFound('记录不存在');
        if (current.version !== expectedVersion) throw errors.versionConflict();
        const next: LocalRecord = {
          ...current,
          deletedAt: action === 'delete' ? now : null,
          version: current.version + 1,
          updatedAt: now,
        };
        try {
          db.prepare('UPDATE records SET deleted_at = ?, version = ?, updated_at = ? WHERE id = ? AND account_id = ?').run(
            next.deletedAt,
            next.version,
            now,
            recordId,
            accountId,
          );
        } catch (err) {
          // 恢复时可能撞上同槽位已有的活动记录（部分唯一索引）
          if (isUniqueViolation(err)) throw errors.slotExists('该条目已存在活动记录，无法恢复');
          throw err;
        }
        result = { record: next, version: next.version, commitSeq: 0 };
      } else {
        const raw = ctx.body['record'];
        if (typeof raw !== 'object' || raw === null) {
          throw errors.validation([{ field: 'record', message: '缺少记录内容' }]);
        }
        const body = raw as Record<string, unknown>;
        const kind = body['kind'];
        if (!isRecordKind(kind)) {
          throw errors.validation([{ field: 'kind', message: '记录类型不正确' }]);
        }
        const fieldErrors = [
          validatePeriodKey(kind, body['periodKey']),
          validateSlot(kind, body['slot']),
        ].filter((e): e is { field: string; message: string } => e !== null);
        const payloadResult = validatePayload(kind, body['payload']);
        let payloadText = '';
        if (payloadResult.ok) {
          payloadText = JSON.stringify(payloadResult.payload);
        } else {
          fieldErrors.push(...payloadResult.errors);
        }
        if (fieldErrors.length > 0) throw errors.validation(fieldErrors);

        const occurredAt =
          typeof body['occurredAt'] === 'string' && body['occurredAt'].trim() !== '' ? body['occurredAt'].trim() : null;
        if (occurredAt !== null && !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/.test(occurredAt)) {
          throw errors.validation([{ field: 'occurredAt', message: '时间格式不正确' }]);
        }
        const timePrecision = occurredAt === null ? 'unknown' : 'minute';
        const timezone = typeof body['timezone'] === 'string' && body['timezone'].trim() !== ''
          ? body['timezone'].trim()
          : CONFIG.defaultTimezone;
        // 原始填写文本始终保留，不因校验而截断

        const existing = getRecord(db, accountId, recordId);
        if (action === 'create') {
          if (existing) {
            throw errors.versionConflict('该记录已存在，请刷新后重试');
          }
          if (isUniqueSlot(kind)) {
            const clash = db
              .prepare(
                'SELECT id FROM records WHERE account_id = ? AND kind = ? AND period_key = ? AND slot = ? AND deleted_at IS NULL',
              )
              .get(accountId, kind, String(body['periodKey']), String(body['slot'])) as Row | undefined;
            if (clash) throw errors.slotExists();
          }
          try {
            db.prepare(
              `INSERT INTO records (id, account_id, kind, period_key, slot, occurred_at, time_precision, timezone, payload, version, created_at, updated_at, deleted_at)
               VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?, NULL)`,
            ).run(
              recordId,
              accountId,
              kind,
              String(body['periodKey']),
              String(body['slot']),
              occurredAt,
              timePrecision,
              timezone,
              payloadText,
              now,
              now,
            );
          } catch (err) {
            if (isUniqueViolation(err)) throw errors.slotExists();
            throw err;
          }
        } else {
          if (!existing) throw errors.notFound('记录不存在');
          if (existing.version !== expectedVersion) throw errors.versionConflict();
          if (existing.kind !== kind) {
            throw errors.validation([{ field: 'kind', message: '不能修改记录类型' }]);
          }
          try {
            db.prepare(
              `UPDATE records SET period_key = ?, slot = ?, occurred_at = ?, time_precision = ?, timezone = ?, payload = ?, version = version + 1, updated_at = ?, deleted_at = NULL
                WHERE id = ? AND account_id = ?`,
            ).run(
              String(body['periodKey']),
              String(body['slot']),
              occurredAt,
              timePrecision,
              timezone,
              payloadText,
              now,
              recordId,
              accountId,
            );
          } catch (err) {
            if (isUniqueViolation(err)) throw errors.slotExists();
            throw err;
          }
        }
        const saved = getRecord(db, accountId, recordId);
        if (!saved) throw errors.unavailable('写入后未能读回记录');
        result = { record: saved, version: saved.version, commitSeq: 0 };
      }

      // 修订快照 + 变更流水 + 账户游标，同一事务提交
      db.prepare(
        'INSERT INTO record_revisions (record_id, version, account_id, snapshot, action, actor_id, server_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
      ).run(recordId, result.version, accountId, JSON.stringify(result.record), action, ctx.account!.id, now);

      const seq = bumpSeq(db, accountId);
      db.prepare(
        'INSERT INTO changes (account_id, seq, record_id, version, action, committed_at) VALUES (?, ?, ?, ?, ?, ?)',
      ).run(accountId, seq, recordId, result.version, action, now);

      const response = { ...result, commitSeq: seq };
      db.prepare(
        'INSERT INTO mutations (account_id, mutation_id, request_hash, response, created_at) VALUES (?, ?, ?, ?, ?)',
      ).run(accountId, mutationId, fingerprint, JSON.stringify(response), now);
      return response;
    });
  });

  return router;
}

// ---------- 快照分页令牌 ----------

function formatSnapshotToken(accountId: string, snapshotSeq: number, snapshotAt: string, offset: number): string {
  const body = `${snapshotSeq}|${snapshotAt}|${offset}`;
  const mac = createHash('sha256').update(`${accountId}|${body}`).digest('hex').slice(0, 16);
  return Buffer.from(`${body}|${mac}`).toString('base64url');
}

function parseSnapshotToken(token: string, accountId: string): { snapshotSeq: number; snapshotAt: string; offset: number } {
  let decoded: string;
  try {
    decoded = Buffer.from(token, 'base64url').toString('utf8');
  } catch {
    throw errors.validation([{ field: 'cursor', message: '分页游标格式不正确' }]);
  }
  const parts = decoded.split('|');
  if (parts.length !== 4) throw errors.validation([{ field: 'cursor', message: '分页游标格式不正确' }]);
  const [seqRaw, snapshotAt, offsetRaw, mac] = parts as [string, string, string, string];
  const expected = createHash('sha256').update(`${accountId}|${seqRaw}|${snapshotAt}|${offsetRaw}`).digest('hex').slice(0, 16);
  if (mac !== expected) throw errors.validation([{ field: 'cursor', message: '分页游标无效' }]);
  return { snapshotSeq: Number(seqRaw), snapshotAt, offset: Number(offsetRaw) };
}

function isUniqueViolation(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err);
  return /UNIQUE constraint failed|SQLITE_CONSTRAINT_UNIQUE/i.test(msg);
}
