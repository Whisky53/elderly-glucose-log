#!/usr/bin/env node
/**
 * 账户管理脚本 —— 服务器侧受控开通（架构 §7「账户由受控开通」）
 *
 * 与 src/auth.ts 使用同一套 scrypt 参数，因此这里创建的账户可以直接登录。
 * 应用运行中执行也安全：SQLite 处于 WAL 模式，脚本设置了 busy_timeout。
 *
 * 用法：
 *   node account.mjs list
 *   node account.mjs create  <用户名> <密码>
 *   node account.mjs reset   <用户名> <新密码>      # 重置密码并踢掉该账户所有会话
 *   node account.mjs disable <用户名>               # 停用（不可登录，数据保留）
 *   node account.mjs enable  <用户名>
 *   node account.mjs remove  <用户名>               # 删除账户及其全部数据（不可逆）
 *
 * 库路径：命令行 --db <path> 优先，其次环境变量 GMS_DB_PATH，最后 ./data/gms.sqlite
 *
 * 注意：密码最短 6 位仅在这里给出提示；应用内「修改密码」要求至少 8 位。
 */
import process from 'node:process';
import { randomBytes, randomUUID, scryptSync } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';

const KEY_LEN = 64;
const DEFAULT_UNITS = { glucose: 'mmol/L', weight: 'kg', water: 'mL' };
const DEFAULT_TIMEZONE = 'Asia/Shanghai';

function hashPassword(password) {
  const salt = randomBytes(16);
  return `scrypt$${salt.toString('hex')}$${scryptSync(password, salt, KEY_LEN).toString('hex')}`;
}

function parseArgs(argv) {
  const positional = [];
  let dbPath = process.env['GMS_DB_PATH'] ?? './data/gms.sqlite';
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === '--db') {
      dbPath = argv[i + 1] ?? dbPath;
      i += 1;
    } else {
      positional.push(argv[i]);
    }
  }
  return { positional, dbPath };
}

function openDb(dbPath) {
  const db = new DatabaseSync(dbPath);
  db.exec('PRAGMA busy_timeout = 5000');
  db.exec('PRAGMA journal_mode = WAL');
  return db;
}

function findAccount(db, username) {
  return db.prepare('SELECT * FROM accounts WHERE username = ?').get(username);
}

function fail(message) {
  console.error(`[失败] ${message}`);
  process.exit(1);
}

const { positional, dbPath } = parseArgs(process.argv.slice(2));
const [command, ...rest] = positional;
if (!command) fail('缺少子命令。可用：list / create / reset / disable / enable / remove');

let db;
try {
  db = openDb(dbPath);
} catch (err) {
  fail(`无法打开数据库 ${dbPath}：${err.message}`);
}

const stamp = () => new Date().toISOString();

switch (command) {
  case 'list': {
    const rows = db
      .prepare(
        'SELECT a.username, a.status, a.created_at, (SELECT COUNT(*) FROM records r WHERE r.account_id = a.id AND r.deleted_at IS NULL) AS records FROM accounts a ORDER BY a.created_at',
      )
      .all();
    if (rows.length === 0) {
      console.log('（暂无账户）');
      break;
    }
    console.log('用户名\t状态\t记录数\t创建时间');
    for (const r of rows) {
      console.log(`${r.username}\t${r.status}\t${r.records}\t${r.created_at}`);
    }
    break;
  }

  case 'create': {
    const [username, password] = rest;
    if (!username || !password) fail('用法：create <用户名> <密码>');
    if (!/^[A-Za-z0-9_.-]{2,32}$/.test(username)) {
      fail('用户名只能包含字母、数字、下划线、点和短横线，长度 2-32');
    }
    if (findAccount(db, username)) fail(`账户 ${username} 已存在（需要改密码请用 reset）`);
    if (password.length < 8) {
      console.warn(`[提示] 密码只有 ${password.length} 位。站点对公网开放，建议至少 8 位。`);
    }

    const id = randomUUID();
    const now = stamp();
    db.exec('BEGIN IMMEDIATE');
    try {
      db.prepare('INSERT INTO accounts (id, username, password_hash, status, created_at) VALUES (?, ?, ?, ?, ?)').run(
        id,
        username,
        hashPassword(password),
        'active',
        now,
      );
      db.prepare(
        'INSERT INTO profile_settings (account_id, glucose_unit, weight_unit, water_unit, timezone, version, updated_at) VALUES (?, ?, ?, ?, ?, 1, ?)',
      ).run(id, DEFAULT_UNITS.glucose, DEFAULT_UNITS.weight, DEFAULT_UNITS.water, DEFAULT_TIMEZONE, now);
      db.prepare('INSERT INTO account_sync_state (account_id, last_seq) VALUES (?, 0)').run(id);
      db.exec('COMMIT');
    } catch (err) {
      db.exec('ROLLBACK');
      fail(`创建失败：${err.message}`);
    }
    console.log(`[完成] 已创建账户 ${username}（id ${id}）`);
    break;
  }

  case 'reset': {
    const [username, password] = rest;
    if (!username || !password) fail('用法：reset <用户名> <新密码>');
    const account = findAccount(db, username);
    if (!account) fail(`账户 ${username} 不存在`);
    if (password.length < 8) {
      console.warn(`[提示] 密码只有 ${password.length} 位。站点对公网开放，建议至少 8 位。`);
    }
    db.prepare('UPDATE accounts SET password_hash = ? WHERE id = ?').run(hashPassword(password), account.id);
    db.prepare('DELETE FROM sessions WHERE account_id = ?').run(account.id);
    console.log(`[完成] 已重置 ${username} 的密码，该账户所有登录会话已作废`);
    break;
  }

  case 'disable':
  case 'enable': {
    const [username] = rest;
    if (!username) fail(`用法：${command} <用户名>`);
    const account = findAccount(db, username);
    if (!account) fail(`账户 ${username} 不存在`);
    const status = command === 'disable' ? 'disabled' : 'active';
    db.prepare('UPDATE accounts SET status = ? WHERE id = ?').run(status, account.id);
    if (command === 'disable') db.prepare('DELETE FROM sessions WHERE account_id = ?').run(account.id);
    console.log(`[完成] ${username} 已${command === 'disable' ? '停用' : '启用'}`);
    break;
  }

  case 'remove': {
    const [username, confirm] = rest;
    if (!username) fail('用法：remove <用户名> --yes');
    if (confirm !== '--yes') fail('这是不可逆操作：请追加 --yes 确认删除账户及其全部数据');
    const account = findAccount(db, username);
    if (!account) fail(`账户 ${username} 不存在`);
    const counts = db
      .prepare('SELECT (SELECT COUNT(*) FROM records WHERE account_id = ?) AS records')
      .get(account.id);
    db.exec('BEGIN IMMEDIATE');
    try {
      const tables = [
        'record_revisions',
        'mutations',
        'changes',
        'account_sync_state',
        'profile_settings',
        'sessions',
        'records',
      ];
      for (const t of tables) {
        db.prepare(`DELETE FROM ${t} WHERE account_id = ?`).run(account.id);
      }
      db.prepare('DELETE FROM accounts WHERE id = ?').run(account.id);
      db.exec('COMMIT');
    } catch (err) {
      db.exec('ROLLBACK');
      fail(`删除失败：${err.message}`);
    }
    console.log(`[完成] 已删除 ${username} 及其 ${counts.records} 条记录（不可逆）`);
    break;
  }

  default:
    fail(`未知子命令：${command}`);
}
