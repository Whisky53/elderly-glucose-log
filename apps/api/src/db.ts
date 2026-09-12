/**
 * SQLite 存储层。表结构对应《02-工程架构设计》§4.1，索引对应 §4.2。
 * 使用 Node 内置 node:sqlite（Node ≥ 22.5），无原生编译依赖。
 */
import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

export type Db = DatabaseSync;

const SCHEMA = `
CREATE TABLE IF NOT EXISTS accounts (
  id            TEXT PRIMARY KEY,
  username      TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  status        TEXT NOT NULL DEFAULT 'active',
  created_at    TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS sessions (
  token        TEXT PRIMARY KEY,
  account_id   TEXT NOT NULL,
  created_at   TEXT NOT NULL,
  expires_at   TEXT NOT NULL,
  last_seen_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS ix_sessions_account ON sessions(account_id);

CREATE TABLE IF NOT EXISTS profile_settings (
  account_id   TEXT PRIMARY KEY,
  glucose_unit TEXT NOT NULL,
  weight_unit  TEXT NOT NULL,
  water_unit   TEXT NOT NULL,
  timezone     TEXT NOT NULL,
  version      INTEGER NOT NULL DEFAULT 1,
  updated_at   TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS records (
  id             TEXT PRIMARY KEY,
  account_id     TEXT NOT NULL,
  kind           TEXT NOT NULL,
  period_key     TEXT NOT NULL,
  slot           TEXT NOT NULL,
  occurred_at    TEXT,
  time_precision TEXT NOT NULL,
  timezone       TEXT NOT NULL,
  payload        TEXT NOT NULL,
  version        INTEGER NOT NULL,
  created_at     TEXT NOT NULL,
  updated_at     TEXT NOT NULL,
  deleted_at     TEXT
);
CREATE INDEX IF NOT EXISTS ix_records_acct_period ON records(account_id, period_key, kind);
CREATE INDEX IF NOT EXISTS ix_records_acct_kind_slot ON records(account_id, kind, slot, period_key);
-- 饮食每餐、饮水当日累计、日纪要、月纪要在活动记录上唯一；删除后不占用槽位
CREATE UNIQUE INDEX IF NOT EXISTS ux_records_active_slot
  ON records(account_id, kind, period_key, slot)
  WHERE deleted_at IS NULL AND kind IN ('meal', 'water', 'day_note', 'month_note');

CREATE TABLE IF NOT EXISTS record_revisions (
  record_id  TEXT NOT NULL,
  version    INTEGER NOT NULL,
  account_id TEXT NOT NULL,
  snapshot   TEXT NOT NULL,
  action     TEXT NOT NULL,
  actor_id   TEXT,
  server_at  TEXT NOT NULL,
  PRIMARY KEY (record_id, version)
);

CREATE TABLE IF NOT EXISTS mutations (
  account_id   TEXT NOT NULL,
  mutation_id  TEXT NOT NULL,
  request_hash TEXT NOT NULL,
  response     TEXT NOT NULL,
  created_at   TEXT NOT NULL,
  PRIMARY KEY (account_id, mutation_id)
);

CREATE TABLE IF NOT EXISTS account_sync_state (
  account_id TEXT PRIMARY KEY,
  last_seq   INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS changes (
  account_id   TEXT NOT NULL,
  seq          INTEGER NOT NULL,
  record_id    TEXT NOT NULL,
  version      INTEGER NOT NULL,
  action       TEXT NOT NULL,
  committed_at TEXT NOT NULL,
  PRIMARY KEY (account_id, seq)
);
`;

export function openDb(path: string): Db {
  if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
  const db = new DatabaseSync(path);
  db.exec('PRAGMA journal_mode = WAL');
  db.exec('PRAGMA foreign_keys = ON');
  db.exec('PRAGMA busy_timeout = 5000');
  db.exec(SCHEMA);
  return db;
}

/**
 * 写事务。BEGIN IMMEDIATE 立刻取写锁，等价于架构 §5.1 的“按账户串行”：
 * 变更游标与提交顺序一致，不会出现序列先分配后延迟提交导致的增量漏拉。
 */
export function inTransaction<T>(db: Db, fn: () => T): T {
  db.exec('BEGIN IMMEDIATE');
  try {
    const result = fn();
    db.exec('COMMIT');
    return result;
  } catch (err) {
    try {
      db.exec('ROLLBACK');
    } catch {
      /* 回滚失败时保留原始错误，避免掩盖真实原因 */
    }
    throw err;
  }
}

/** 清理过期幂等记录与变更流水（架构 §4.2：默认保留 90 天） */
export function purgeExpired(db: Db, retentionDays: number): void {
  const cutoff = new Date(Date.now() - retentionDays * 86_400_000).toISOString();
  db.prepare('DELETE FROM mutations WHERE created_at < ?').run(cutoff);
  db.prepare('DELETE FROM sessions WHERE expires_at < ?').run(new Date().toISOString());
  // 变更流水只在“已无任何账户需要该游标”时才安全收缩；此处保守处理，
  // 仅清理远早于保留期的历史，游标过期由 /changes 返回 410 CURSOR_EXPIRED 兜底。
  db.prepare('DELETE FROM changes WHERE committed_at < ?').run(cutoff);
}
