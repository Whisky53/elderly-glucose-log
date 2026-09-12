import type { FieldError, LocalRecord } from '@gms/contracts';
import type { RemoteRecordBody } from '../local/repo';

/**
 * 类型化 API 客户端（架构 §5 契约）。
 * 所有错误统一抛 ApiError，携带服务端 code 与可重试标记，
 * 由 SyncEngine 决定是重试、进入冲突还是要求重新登录。
 */

export type ApiErrorCode =
  | 'SESSION_EXPIRED'
  | 'INVALID_CREDENTIALS'
  | 'FORBIDDEN'
  | 'NOT_FOUND'
  | 'BAD_REQUEST'
  | 'VALIDATION_FAILED'
  | 'VERSION_CONFLICT'
  | 'SLOT_EXISTS'
  | 'CURSOR_EXPIRED'
  | 'RATE_LIMITED'
  | 'TEMPORARILY_UNAVAILABLE'
  | 'PAYLOAD_TOO_LARGE'
  | 'INTERNAL_ERROR'
  | 'NETWORK';

export class ApiError extends Error {
  readonly status: number;
  readonly code: ApiErrorCode | string;
  readonly fieldErrors: FieldError[] | undefined;
  readonly retryable: boolean;

  constructor(
    status: number,
    code: string,
    message: string,
    fieldErrors?: FieldError[],
    retryable = false,
  ) {
    super(message);
    this.status = status;
    this.code = code;
    this.fieldErrors = fieldErrors;
    this.retryable = retryable;
  }

  /** 网络中断、429 与明确的 5xx 才重试；422/409 重试没有意义 */
  get isRetryable(): boolean {
    return this.code === 'NETWORK' || this.status === 429 || this.status >= 500 || this.retryable;
  }
}

export type Profile = {
  glucoseUnit: string;
  weightUnit: string;
  waterUnit: string;
  timezone: string;
  version: number;
};

export type MutationResponse = { record: LocalRecord; version: number; commitSeq: number };

export type ChangesPage = {
  changes: Array<{
    seq: number;
    recordId: string;
    version: number;
    action: string;
    committedAt: string;
    record: LocalRecord | null;
  }>;
  nextCursor: number;
  hasMore: boolean;
};

export type SnapshotPage = {
  snapshotSeq: number;
  snapshotAt: string;
  syncCursor: number;
  records: LocalRecord[];
  hasMore: boolean;
  nextPageToken: string | null;
};

export type MutationRequest = {
  mutationId: string;
  recordId: string;
  action: 'create' | 'update' | 'delete' | 'restore';
  expectedVersion: number;
  record?: RemoteRecordBody | null;
};

const BASE = '/api/v1';

export class ApiClient {
  private token: string | null = null;

  setToken(token: string | null): void {
    this.token = token;
  }

  hasToken(): boolean {
    return this.token !== null;
  }

  private async request<T>(method: string, path: string, body?: unknown): Promise<T> {
    let res: Response;
    try {
      res = await fetch(`${BASE}${path}`, {
        method,
        headers: {
          ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
          ...(this.token ? { Authorization: `Bearer ${this.token}` } : {}),
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
    } catch {
      // 断网、服务未启动、被离线拦截
      throw new ApiError(0, 'NETWORK', '无法连接服务器，请检查网络后重试', undefined, true);
    }

    const text = await res.text();
    let payload: unknown = null;
    if (text) {
      try {
        payload = JSON.parse(text);
      } catch {
        payload = null;
      }
    }

    if (!res.ok) {
      const obj = (payload ?? {}) as {
        code?: string;
        message?: string;
        fieldErrors?: FieldError[];
        retryable?: boolean;
      };
      throw new ApiError(
        res.status,
        obj.code ?? 'INTERNAL_ERROR',
        obj.message ?? `请求失败（HTTP ${res.status}）`,
        obj.fieldErrors,
        obj.retryable ?? false,
      );
    }
    return payload as T;
  }

  login(username: string, password: string): Promise<{ token: string; expiresAt: string; account: { id: string; username: string } }> {
    return this.request('POST', '/auth/login', { username, password });
  }

  logout(): Promise<{ ok: boolean }> {
    return this.request('POST', '/auth/logout');
  }

  me(): Promise<{ account: { id: string; username: string } }> {
    return this.request('GET', '/auth/me');
  }

  /** 改密码成功后服务端会作废该账户的全部会话，客户端需要重新登录 */
  changePassword(oldPassword: string, newPassword: string): Promise<{ ok: boolean; reauthRequired: boolean }> {
    return this.request('POST', '/auth/password', { oldPassword, newPassword });
  }

  profile(): Promise<Profile> {
    return this.request('GET', '/profile');
  }

  patchProfile(patch: Partial<Profile> & { expectedVersion: number }): Promise<Profile> {
    return this.request('PATCH', '/profile', patch);
  }

  changes(cursor: number, limit = 200): Promise<ChangesPage> {
    return this.request('GET', `/changes?cursor=${cursor}&limit=${limit}`);
  }

  snapshot(pageToken: string | null, limit = 200, from?: string, to?: string): Promise<SnapshotPage> {
    const params = new URLSearchParams({ limit: String(limit) });
    if (pageToken) params.set('cursor', pageToken);
    if (from) params.set('from', from);
    if (to) params.set('to', to);
    return this.request('GET', `/snapshot?${params.toString()}`);
  }

  mutate(request: MutationRequest): Promise<MutationResponse> {
    return this.request('POST', '/mutations', request);
  }

  getRecord(id: string): Promise<{ record: LocalRecord }> {
    return this.request('GET', `/records/${encodeURIComponent(id)}`);
  }
}

export const api = new ApiClient();
