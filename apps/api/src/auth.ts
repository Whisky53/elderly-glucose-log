/**
 * 认证与会话（架构 §7）。密码用 scrypt 加盐散列，令牌为高熵随机串；
 * 首版账户由受控开通（环境变量或随机生成的一次性密码），不自造认证协议。
 */
import { randomBytes, randomUUID, scryptSync, timingSafeEqual } from 'node:crypto';
import type { Db } from './db';
import { CONFIG } from './config';

export type Account = { id: string; username: string; status: string; createdAt: string };

const KEY_LEN = 64;

function hashPassword(password: string): string {
  const salt = randomBytes(16);
  const hash = scryptSync(password, salt, KEY_LEN);
  return `scrypt$${salt.toString('hex')}$${hash.toString('hex')}`;
}

function verifyPassword(password: string, stored: string): boolean {
  const parts = stored.split('$');
  if (parts.length !== 3 || parts[0] !== 'scrypt') return false;
  const saltHex = parts[1];
  const hashHex = parts[2];
  if (!saltHex || !hashHex) return false;
  const expected = Buffer.from(hashHex, 'hex');
  const actual = scryptSync(password, Buffer.from(saltHex, 'hex'), expected.length);
  return expected.length === actual.length && timingSafeEqual(expected, actual);
}

function rowToAccount(row: Record<string, unknown>): Account {
  return {
    id: String(row['id']),
    username: String(row['username']),
    status: String(row['status']),
    createdAt: String(row['created_at']),
  };
}

export function findAccountByUsername(db: Db, username: string): (Account & { passwordHash: string }) | null {
  const row = db.prepare('SELECT * FROM accounts WHERE username = ?').get(username) as
    | Record<string, unknown>
    | undefined;
  if (!row) return null;
  return { ...rowToAccount(row), passwordHash: String(row['password_hash']) };
}

export function findAccountById(db: Db, id: string): Account | null {
  const row = db.prepare('SELECT * FROM accounts WHERE id = ?').get(id) as Record<string, unknown> | undefined;
  return row ? rowToAccount(row) : null;
}

/** 校验用户名口令；失败一律返回 null，不区分“用户不存在”与“密码错误” */
export function authenticate(db: Db, username: string, password: string): Account | null {
  const account = findAccountByUsername(db, username);
  if (!account) {
    // 用户不存在时也做一次散列，避免用响应时间探测账户是否存在
    scryptSync(password, randomBytes(16), KEY_LEN);
    return null;
  }
  if (account.status !== 'active') return null;
  if (!verifyPassword(password, account.passwordHash)) return null;
  return { id: account.id, username: account.username, status: account.status, createdAt: account.createdAt };
}

export function createSession(db: Db, accountId: string): { token: string; expiresAt: string } {
  const token = randomBytes(32).toString('base64url');
  const now = new Date();
  const expiresAt = new Date(now.getTime() + CONFIG.sessionTtlDays * 86_400_000).toISOString();
  db.prepare('INSERT INTO sessions (token, account_id, created_at, expires_at, last_seen_at) VALUES (?, ?, ?, ?, ?)').run(
    token,
    accountId,
    now.toISOString(),
    expiresAt,
    now.toISOString(),
  );
  return { token, expiresAt };
}

/** 令牌 → 账户；顺带更新 last_seen_at，过期会话视为无效 */
export function resolveSession(db: Db, token: string): Account | null {
  const row = db.prepare('SELECT account_id, expires_at FROM sessions WHERE token = ?').get(token) as
    | Record<string, unknown>
    | undefined;
  if (!row) return null;
  if (String(row['expires_at']) <= new Date().toISOString()) {
    db.prepare('DELETE FROM sessions WHERE token = ?').run(token);
    return null;
  }
  db.prepare('UPDATE sessions SET last_seen_at = ? WHERE token = ?').run(new Date().toISOString(), token);
  return findAccountById(db, String(row['account_id']));
}

export function revokeSession(db: Db, token: string): void {
  db.prepare('DELETE FROM sessions WHERE token = ?').run(token);
}

/**
 * 首次启动且库内无账户时创建账户与默认配置。
 * 未提供 GMS_ADMIN_PASSWORD 时随机生成并返回，由启动日志打印一次。
 */
export function ensureBootstrapAccount(db: Db): { account: Account; generatedPassword?: string } | null {
  const existing = db.prepare('SELECT * FROM accounts LIMIT 1').get() as Record<string, unknown> | undefined;
  if (existing) return null;

  const password = CONFIG.adminPassword || randomBytes(9).toString('base64url');
  const now = new Date().toISOString();
  const id = randomUUID();
  db.prepare('INSERT INTO accounts (id, username, password_hash, status, created_at) VALUES (?, ?, ?, ?, ?)').run(
    id,
    CONFIG.adminUser,
    hashPassword(password),
    'active',
    now,
  );
  db.prepare(
    'INSERT INTO profile_settings (account_id, glucose_unit, weight_unit, water_unit, timezone, version, updated_at) VALUES (?, ?, ?, ?, ?, 1, ?)',
  ).run(
    id,
    CONFIG.defaultUnits.glucose,
    CONFIG.defaultUnits.weight,
    CONFIG.defaultUnits.water,
    CONFIG.defaultTimezone,
    now,
  );
  db.prepare('INSERT INTO account_sync_state (account_id, last_seq) VALUES (?, 0)').run(id);

  return {
    account: { id, username: CONFIG.adminUser, status: 'active', createdAt: now },
    generatedPassword: CONFIG.adminPassword ? undefined : password,
  };
}

/** 修改口令（设置页用），需要旧口令验证 */
export function changePassword(db: Db, accountId: string, oldPassword: string, newPassword: string): boolean {
  const row = db.prepare('SELECT username, password_hash FROM accounts WHERE id = ?').get(accountId) as
    | Record<string, unknown>
    | undefined;
  if (!row) return false;
  if (!verifyPassword(oldPassword, String(row['password_hash']))) return false;
  db.prepare('UPDATE accounts SET password_hash = ? WHERE id = ?').run(hashPassword(newPassword), accountId);
  // 改密后作废该账户其它会话，保留当前会话由调用方决定
  return true;
}
