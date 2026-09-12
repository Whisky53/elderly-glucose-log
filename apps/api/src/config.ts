/**
 * 运行配置。全部可用环境变量覆盖，便于 dev/test/prod 使用独立数据库（架构 §9）。
 */
import process from 'node:process';

function envInt(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return fallback;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

export const CONFIG = {
  /** 只监听本机，由 Nginx 反代对外，避免 API 直接暴露公网 */
  host: process.env['GMS_API_HOST'] ?? '127.0.0.1',
  port: envInt('GMS_API_PORT', 8100),
  dbPath: process.env['GMS_DB_PATH'] ?? './data/gms.sqlite',
  /** 首次启动且库内无账户时用于创建账户；密码留空则随机生成并打印一次 */
  adminUser: process.env['GMS_ADMIN_USER'] ?? 'admin',
  adminPassword: process.env['GMS_ADMIN_PASSWORD'] ?? '',
  sessionTtlDays: envInt('GMS_SESSION_TTL_DAYS', 90),
  /** 幂等记录、修订与变更流水保留天数（架构 §4.2） */
  retentionDays: envInt('GMS_RETENTION_DAYS', 90),
  maxBodyBytes: envInt('GMS_MAX_BODY_BYTES', 1024 * 1024),
  defaultTimezone: 'Asia/Shanghai',
  defaultUnits: { glucose: 'mmol/L', weight: 'kg', water: 'mL' },
} as const;
