/**
 * 极简 HTTP 层：路由匹配、请求体读取、统一错误响应与访问日志。
 * 只用 Node 内置模块，无第三方框架。
 * 错误契约对应《02-工程架构设计》§5：requestId、code、message、fieldErrors、retryable。
 */
import type { IncomingMessage, ServerResponse } from 'node:http';
import { randomUUID } from 'node:crypto';
import type { FieldError } from '@gms/contracts';
import type { Account } from './auth';

export type Ctx = {
  req: IncomingMessage;
  res: ServerResponse;
  method: string;
  path: string;
  params: Record<string, string>;
  query: URLSearchParams;
  body: Record<string, unknown>;
  account: Account | null;
  token: string | null;
  requestId: string;
  remoteIp: string;
};

export class ApiError extends Error {
  readonly status: number;
  readonly code: string;
  readonly fieldErrors?: FieldError[];
  readonly retryable: boolean;

  constructor(
    status: number,
    code: string,
    message: string,
    opts: { fieldErrors?: FieldError[]; retryable?: boolean } = {},
  ) {
    super(message);
    this.status = status;
    this.code = code;
    this.fieldErrors = opts.fieldErrors;
    this.retryable = opts.retryable ?? false;
  }
}

export const errors = {
  sessionExpired: () => new ApiError(401, 'SESSION_EXPIRED', '登录已过期，请重新登录'),
  forbidden: (msg = '无权访问该资源') => new ApiError(403, 'FORBIDDEN', msg),
  notFound: (msg = '资源不存在') => new ApiError(404, 'NOT_FOUND', msg),
  badRequest: (msg: string) => new ApiError(400, 'BAD_REQUEST', msg),
  validation: (fieldErrors: FieldError[], msg = '提交内容未通过校验') =>
    new ApiError(422, 'VALIDATION_FAILED', msg, { fieldErrors }),
  versionConflict: (msg = '记录已在其它设备被修改') => new ApiError(409, 'VERSION_CONFLICT', msg),
  slotExists: (msg = '该条目已存在，不能重复创建') => new ApiError(409, 'SLOT_EXISTS', msg),
  cursorExpired: () => new ApiError(410, 'CURSOR_EXPIRED', '增量游标已过期，需要重新获取全量快照'),
  rateLimited: () => new ApiError(429, 'RATE_LIMITED', '请求过于频繁，请稍后重试', { retryable: true }),
  unavailable: (msg = '服务暂时不可用') => new ApiError(503, 'TEMPORARILY_UNAVAILABLE', msg, { retryable: true }),
  payloadTooLarge: () => new ApiError(413, 'PAYLOAD_TOO_LARGE', '请求体过大'),
};

export type Handler = (ctx: Ctx) => Promise<unknown> | unknown;

type Route = {
  method: string;
  segments: string[];
  handler: Handler;
  /** false 表示免鉴权（健康检查、登录） */
  auth: boolean;
};

export function createRouter() {
  const routes: Route[] = [];
  const add = (method: string, path: string, handler: Handler, auth = true) => {
    routes.push({ method, segments: path.split('/').filter(Boolean), handler, auth });
  };
  return {
    get: (p: string, h: Handler, auth = true) => add('GET', p, h, auth),
    post: (p: string, h: Handler, auth = true) => add('POST', p, h, auth),
    patch: (p: string, h: Handler, auth = true) => add('PATCH', p, h, auth),
    delete: (p: string, h: Handler, auth = true) => add('DELETE', p, h, auth),
    match(method: string, path: string): { route: Route; params: Record<string, string> } | null {
      const parts = path.split('/').filter(Boolean);
      for (const route of routes) {
        if (route.method !== method) continue;
        if (route.segments.length !== parts.length) continue;
        const params: Record<string, string> = {};
        let ok = true;
        for (let i = 0; i < route.segments.length; i += 1) {
          const seg = route.segments[i]!;
          const actual = parts[i]!;
          if (seg.startsWith(':')) {
            params[seg.slice(1)] = decodeURIComponent(actual);
          } else if (seg !== actual) {
            ok = false;
            break;
          }
        }
        if (ok) return { route, params };
      }
      return null;
    },
  };
}

export async function readJsonBody(req: IncomingMessage, maxBytes: number): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    const buf = chunk as Buffer;
    size += buf.length;
    if (size > maxBytes) throw errors.payloadTooLarge();
    chunks.push(buf);
  }
  if (size === 0) return {};
  const raw = Buffer.concat(chunks).toString('utf8');
  try {
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
      throw errors.badRequest('请求体必须是 JSON 对象');
    }
    return parsed as Record<string, unknown>;
  } catch (err) {
    if (err instanceof ApiError) throw err;
    throw errors.badRequest('请求体不是合法 JSON');
  }
}

const SECURITY_HEADERS: Record<string, string> = {
  'X-Content-Type-Options': 'nosniff',
  'X-Frame-Options': 'DENY',
  'Referrer-Policy': 'no-referrer',
  // API 响应不进任何缓存；Service Worker 也不得缓存（架构 §2）
  'Cache-Control': 'no-store, no-cache, must-revalidate, private',
};

export function sendJson(res: ServerResponse, status: number, payload: unknown, requestId: string): void {
  const body = payload === undefined ? '' : JSON.stringify(payload);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'X-Request-Id': requestId,
    ...SECURITY_HEADERS,
  });
  res.end(body);
}

export function sendError(res: ServerResponse, err: ApiError, requestId: string): void {
  sendJson(
    res,
    err.status,
    {
      requestId,
      code: err.code,
      message: err.message,
      ...(err.fieldErrors ? { fieldErrors: err.fieldErrors } : {}),
      retryable: err.retryable,
    },
    requestId,
  );
}

export function clientIp(req: IncomingMessage): string {
  const fwd = req.headers['x-forwarded-for'];
  if (typeof fwd === 'string' && fwd.length > 0) return fwd.split(',')[0]!.trim();
  if (Array.isArray(fwd) && fwd.length > 0) return fwd[0]!.split(',')[0]!.trim();
  return req.socket.remoteAddress ?? 'unknown';
}

export function newRequestId(): string {
  return randomUUID();
}

export function bearerToken(req: IncomingMessage): string | null {
  const raw = req.headers['authorization'];
  if (typeof raw !== 'string') return null;
  const m = /^Bearer\s+(.+)$/i.exec(raw.trim());
  return m?.[1]?.trim() || null;
}

/** 访问日志只保留技术字段，不记录数值、备注、令牌与导出链接（架构 §7） */
export function logAccess(entry: {
  requestId: string;
  method: string;
  path: string;
  status: number;
  ms: number;
  code?: string;
}): void {
  process.stdout.write(
    `${JSON.stringify({ at: new Date().toISOString(), ...entry })}\n`,
  );
}
