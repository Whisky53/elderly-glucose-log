/**
 * SQLite 定时备份。
 *
 * 用 `VACUUM INTO` 生成一致性快照——即使服务正在写入也不会拿到半截文件，
 * 比直接 cp（WAL 模式下可能拷到不一致状态）安全得多。
 *
 * 用法：
 *   node backup.mjs <数据库路径> <备份目录> [保留份数]
 * 例：
 *   node backup.mjs /var/lib/gms/gms.sqlite /var/lib/gms/backups 14
 *
 * 建议由 systemd timer 或 crontab 每天执行一次：
 *   0 3 * * *  /usr/bin/node /opt/gms/api/backup.mjs /var/lib/gms/gms.sqlite /var/lib/gms/backups 14
 *
 * 恢复方式：停止服务，把某一日的 .sqlite 覆盖回 GMS_DB_PATH，重启服务。
 * 注意备份文件含个人健康数据，目录权限应与数据库一致（仅 gms 用户可读）。
 */
import { DatabaseSync } from 'node:sqlite';
import { existsSync, mkdirSync, readdirSync, statSync, unlinkSync } from 'node:fs';
import path from 'node:path';
import process from 'node:process';

const [dbPath, backupDir, keepRaw] = process.argv.slice(2);
const keep = Number(keepRaw ?? 14);

if (!dbPath || !backupDir) {
  process.stderr.write('用法: node backup.mjs <数据库路径> <备份目录> [保留份数]\n');
  process.exit(2);
}
if (!existsSync(dbPath)) {
  process.stderr.write(`数据库不存在: ${dbPath}\n`);
  process.exit(1);
}

mkdirSync(backupDir, { recursive: true, mode: 0o700 });

const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
const target = path.join(backupDir, `gms-${stamp}.sqlite`);

// VACUUM INTO 要求目标文件不存在
if (existsSync(target)) unlinkSync(target);

const db = new DatabaseSync(dbPath);
try {
  db.exec(`VACUUM INTO '${target.replace(/'/g, "''")}'`);
} finally {
  db.close();
}

const bytes = statSync(target).size;
process.stdout.write(
  `${JSON.stringify({ at: new Date().toISOString(), level: 'info', msg: '备份完成', target, bytes })}\n`,
);

// 轮转：只保留最近 keep 份，避免磁盘被慢慢吃满
const stale = readdirSync(backupDir)
  .filter((f) => f.startsWith('gms-') && f.endsWith('.sqlite'))
  .map((f) => ({ f, mtime: statSync(path.join(backupDir, f)).mtimeMs }))
  .sort((a, b) => b.mtime - a.mtime)
  .slice(keep);

for (const { f } of stale) {
  unlinkSync(path.join(backupDir, f));
  process.stdout.write(`${JSON.stringify({ at: new Date().toISOString(), level: 'info', msg: '清理旧备份', file: f })}\n`);
}
