/**
 * 服务入口：初始化数据库、引导账户、装配路由、启动 HTTP 服务。
 * 由 systemd 托管（崩溃重启、开机自启），因此这里不做进程守护。
 */
import { createServer } from 'node:http';
import process from 'node:process';
import { CONFIG } from './config';
import { openDb, purgeExpired } from './db';
import { ensureBootstrapAccount, resolveSession } from './auth';
import { registerRoutes } from './routes';
import {
  ApiError,
  bearerToken,
  clientIp,
  errors,
  logAccess,
  newRequestId,
  readJsonBody,
  sendError,
  sendJson,
  type Ctx,
} from './http';

const SERVER_VERSION = '1.0.0';

const db = openDb(CONFIG.dbPath);

const bootstrap = ensureBootstrapAccount(db);
if (bootstrap) {
  process.stdout.write(
    `${JSON.stringify({
      at: new Date().toISOString(),
      level: 'info',
      msg: '已创建初始账户',
      username: bootstrap.account.username,
      ...(bootstrap.generatedPassword
        ? { password: bootstrap.generatedPassword, note: '此密码仅本次打印，请立即保存并于登录后修改' }
        : {}),
    })}\n`,
  );
}

purgeExpired(db, CONFIG.retentionDays);
const purgeTimer = setInterval(() => purgeExpired(db, CONFIG.retentionDays), 24 * 3600_000);
purgeTimer.unref();

const router = registerRoutes(db);

const server = createServer((req, res) => {
  void handle(req, res);
});

async function handle(req: import('node:http').IncomingMessage, res: import('node:http').ServerResponse): Promise<void> {
  const startedAt = Date.now();
  const requestId = newRequestId();
  const url = new URL(req.url ?? '/', 'http://localhost');
  const method = (req.method ?? 'GET').toUpperCase();
  let status = 500;
  let code: string | undefined;

  try {
    const matched = router.match(method, url.pathname);
    if (!matched) throw errors.notFound('接口不存在');

    const token = bearerToken(req);
    let account = null;
    if (matched.route.auth) {
      if (!token) throw errors.sessionExpired();
      account = resolveSession(db, token);
      if (!account) throw errors.sessionExpired();
    }

    const body =
      method === 'POST' || method === 'PATCH' || method === 'PUT'
        ? await readJsonBody(req, CONFIG.maxBodyBytes)
        : {};

    const ctx: Ctx = {
      req,
      res,
      method,
      path: url.pathname,
      params: matched.params,
      query: url.searchParams,
      body,
      account,
      token,
      requestId,
      remoteIp: clientIp(req),
    };

    const result = await matched.route.handler(ctx);
    status = 200;
    sendJson(res, status, result ?? { ok: true }, requestId);
  } catch (err) {
    if (err instanceof ApiError) {
      status = err.status;
      code = err.code;
      sendError(res, err, requestId);
    } else {
      // 不向客户端暴露内部错误细节（架构 §5）
      status = 500;
      code = 'INTERNAL_ERROR';
      sendError(res, new ApiError(500, 'INTERNAL_ERROR', '服务器内部错误，请稍后重试', { retryable: true }), requestId);
      process.stderr.write(
        `${JSON.stringify({
          at: new Date().toISOString(),
          level: 'error',
          requestId,
          msg: err instanceof Error ? err.message : String(err),
          stack: err instanceof Error ? err.stack : undefined,
        })}\n`,
      );
    }
  } finally {
    logAccess({ requestId, method, path: url.pathname, status, ms: Date.now() - startedAt, ...(code ? { code } : {}) });
  }
}

server.listen(CONFIG.port, CONFIG.host, () => {
  process.stdout.write(
    `${JSON.stringify({
      at: new Date().toISOString(),
      level: 'info',
      msg: 'API 已启动',
      version: SERVER_VERSION,
      host: CONFIG.host,
      port: CONFIG.port,
      db: CONFIG.dbPath,
      node: process.version,
    })}\n`,
  );
});

function shutdown(signal: string): void {
  process.stdout.write(`${JSON.stringify({ at: new Date().toISOString(), level: 'info', msg: '收到退出信号', signal })}\n`);
  server.close(() => {
    try {
      db.close();
    } catch {
      /* 关闭失败不影响退出 */
    }
    process.exit(0);
  });
  // 兜底：10 秒内未排空连接也强制退出，避免 systemd 反复强杀
  setTimeout(() => process.exit(0), 10_000).unref();
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
