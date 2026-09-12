// 血糖管理同步 API — 由 scripts/bundle.mjs 生成，请勿直接编辑

// src/server.ts
import { createServer } from "node:http";
import process3 from "node:process";

// src/config.ts
import process2 from "node:process";
function envInt(name, fallback) {
  const raw = process2.env[name];
  if (raw === void 0 || raw === "") return fallback;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}
var CONFIG = {
  /** 只监听本机，由 Nginx 反代对外，避免 API 直接暴露公网 */
  host: process2.env["GMS_API_HOST"] ?? "127.0.0.1",
  port: envInt("GMS_API_PORT", 8100),
  dbPath: process2.env["GMS_DB_PATH"] ?? "./data/gms.sqlite",
  /** 首次启动且库内无账户时用于创建账户；密码留空则随机生成并打印一次 */
  adminUser: process2.env["GMS_ADMIN_USER"] ?? "admin",
  adminPassword: process2.env["GMS_ADMIN_PASSWORD"] ?? "",
  sessionTtlDays: envInt("GMS_SESSION_TTL_DAYS", 90),
  /** 幂等记录、修订与变更流水保留天数（架构 §4.2） */
  retentionDays: envInt("GMS_RETENTION_DAYS", 90),
  maxBodyBytes: envInt("GMS_MAX_BODY_BYTES", 1024 * 1024),
  defaultTimezone: "Asia/Shanghai",
  defaultUnits: { glucose: "mmol/L", weight: "kg", water: "mL" }
};

// src/db.ts
import { DatabaseSync } from "node:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
var SCHEMA = `
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
-- \u996E\u98DF\u6BCF\u9910\u3001\u996E\u6C34\u5F53\u65E5\u7D2F\u8BA1\u3001\u65E5\u7EAA\u8981\u3001\u6708\u7EAA\u8981\u5728\u6D3B\u52A8\u8BB0\u5F55\u4E0A\u552F\u4E00\uFF1B\u5220\u9664\u540E\u4E0D\u5360\u7528\u69FD\u4F4D
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
function openDb(path) {
  if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
  const db2 = new DatabaseSync(path);
  db2.exec("PRAGMA journal_mode = WAL");
  db2.exec("PRAGMA foreign_keys = ON");
  db2.exec("PRAGMA busy_timeout = 5000");
  db2.exec(SCHEMA);
  return db2;
}
function inTransaction(db2, fn) {
  db2.exec("BEGIN IMMEDIATE");
  try {
    const result = fn();
    db2.exec("COMMIT");
    return result;
  } catch (err) {
    try {
      db2.exec("ROLLBACK");
    } catch {
    }
    throw err;
  }
}
function purgeExpired(db2, retentionDays) {
  const cutoff = new Date(Date.now() - retentionDays * 864e5).toISOString();
  db2.prepare("DELETE FROM mutations WHERE created_at < ?").run(cutoff);
  db2.prepare("DELETE FROM sessions WHERE expires_at < ?").run((/* @__PURE__ */ new Date()).toISOString());
  db2.prepare("DELETE FROM changes WHERE committed_at < ?").run(cutoff);
}

// src/auth.ts
import { randomBytes, randomUUID, scryptSync, timingSafeEqual } from "node:crypto";
var KEY_LEN = 64;
function hashPassword(password) {
  const salt = randomBytes(16);
  const hash = scryptSync(password, salt, KEY_LEN);
  return `scrypt$${salt.toString("hex")}$${hash.toString("hex")}`;
}
function verifyPassword(password, stored) {
  const parts = stored.split("$");
  if (parts.length !== 3 || parts[0] !== "scrypt") return false;
  const saltHex = parts[1];
  const hashHex = parts[2];
  if (!saltHex || !hashHex) return false;
  const expected = Buffer.from(hashHex, "hex");
  const actual = scryptSync(password, Buffer.from(saltHex, "hex"), expected.length);
  return expected.length === actual.length && timingSafeEqual(expected, actual);
}
function rowToAccount(row) {
  return {
    id: String(row["id"]),
    username: String(row["username"]),
    status: String(row["status"]),
    createdAt: String(row["created_at"])
  };
}
function findAccountByUsername(db2, username) {
  const row = db2.prepare("SELECT * FROM accounts WHERE username = ?").get(username);
  if (!row) return null;
  return { ...rowToAccount(row), passwordHash: String(row["password_hash"]) };
}
function findAccountById(db2, id) {
  const row = db2.prepare("SELECT * FROM accounts WHERE id = ?").get(id);
  return row ? rowToAccount(row) : null;
}
function authenticate(db2, username, password) {
  const account = findAccountByUsername(db2, username);
  if (!account) {
    scryptSync(password, randomBytes(16), KEY_LEN);
    return null;
  }
  if (account.status !== "active") return null;
  if (!verifyPassword(password, account.passwordHash)) return null;
  return { id: account.id, username: account.username, status: account.status, createdAt: account.createdAt };
}
function createSession(db2, accountId) {
  const token = randomBytes(32).toString("base64url");
  const now = /* @__PURE__ */ new Date();
  const expiresAt = new Date(now.getTime() + CONFIG.sessionTtlDays * 864e5).toISOString();
  db2.prepare("INSERT INTO sessions (token, account_id, created_at, expires_at, last_seen_at) VALUES (?, ?, ?, ?, ?)").run(
    token,
    accountId,
    now.toISOString(),
    expiresAt,
    now.toISOString()
  );
  return { token, expiresAt };
}
function resolveSession(db2, token) {
  const row = db2.prepare("SELECT account_id, expires_at FROM sessions WHERE token = ?").get(token);
  if (!row) return null;
  if (String(row["expires_at"]) <= (/* @__PURE__ */ new Date()).toISOString()) {
    db2.prepare("DELETE FROM sessions WHERE token = ?").run(token);
    return null;
  }
  db2.prepare("UPDATE sessions SET last_seen_at = ? WHERE token = ?").run((/* @__PURE__ */ new Date()).toISOString(), token);
  return findAccountById(db2, String(row["account_id"]));
}
function revokeSession(db2, token) {
  db2.prepare("DELETE FROM sessions WHERE token = ?").run(token);
}
function ensureBootstrapAccount(db2) {
  const existing = db2.prepare("SELECT * FROM accounts LIMIT 1").get();
  if (existing) return null;
  const password = CONFIG.adminPassword || randomBytes(9).toString("base64url");
  const now = (/* @__PURE__ */ new Date()).toISOString();
  const id = randomUUID();
  db2.prepare("INSERT INTO accounts (id, username, password_hash, status, created_at) VALUES (?, ?, ?, ?, ?)").run(
    id,
    CONFIG.adminUser,
    hashPassword(password),
    "active",
    now
  );
  db2.prepare(
    "INSERT INTO profile_settings (account_id, glucose_unit, weight_unit, water_unit, timezone, version, updated_at) VALUES (?, ?, ?, ?, ?, 1, ?)"
  ).run(
    id,
    CONFIG.defaultUnits.glucose,
    CONFIG.defaultUnits.weight,
    CONFIG.defaultUnits.water,
    CONFIG.defaultTimezone,
    now
  );
  db2.prepare("INSERT INTO account_sync_state (account_id, last_seq) VALUES (?, 0)").run(id);
  return {
    account: { id, username: CONFIG.adminUser, status: "active", createdAt: now },
    generatedPassword: CONFIG.adminPassword ? void 0 : password
  };
}
function changePassword(db2, accountId, oldPassword, newPassword) {
  const row = db2.prepare("SELECT username, password_hash FROM accounts WHERE id = ?").get(accountId);
  if (!row) return false;
  if (!verifyPassword(oldPassword, String(row["password_hash"]))) return false;
  db2.prepare("UPDATE accounts SET password_hash = ? WHERE id = ?").run(hashPassword(newPassword), accountId);
  return true;
}

// src/routes.ts
import { createHash } from "node:crypto";

// ../../packages/domain/src/decimal.ts
function normalizeFullWidth(input) {
  return input.replace(/[０-９]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 65248)).replace(/．/g, ".").trim();
}
function validateDecimal(raw, opts = {}) {
  const { allowZero = false, maxSignificant = 12, maxDecimals = 4 } = opts;
  const s = normalizeFullWidth(raw);
  if (s === "") return { ok: false, error: "\u8BF7\u8F93\u5165\u6570\u503C" };
  if (/^-/.test(s)) return { ok: false, error: "\u4E0D\u80FD\u4E3A\u8D1F\u6570" };
  if (/[eE]/i.test(s)) return { ok: false, error: "\u4E0D\u652F\u6301\u79D1\u5B66\u8BA1\u6570\u6CD5" };
  if (Number.isNaN(Number(s))) return { ok: false, error: "\u8BF7\u8F93\u5165\u6709\u6548\u6570\u5B57" };
  if (!/^\d+(\.\d+)?$/.test(s)) return { ok: false, error: "\u8BF7\u8F93\u5165\u5341\u8FDB\u5236\u6570\u503C" };
  const [intPart, decPart = ""] = s.split(".");
  if (decPart.length > maxDecimals) {
    return { ok: false, error: `\u5C0F\u6570\u6700\u591A ${maxDecimals} \u4F4D` };
  }
  const significant = (intPart.replace(/^0+/, "") + decPart.replace(/0+$/, "")).replace(/\./g, "");
  const sigDigits = intPart.replace(/^0+/, "").length + decPart.replace(/0+$/, "").length;
  if (sigDigits > maxSignificant) {
    return { ok: false, error: `\u6700\u591A ${maxSignificant} \u4F4D\u6709\u6548\u6570\u5B57` };
  }
  const num = Number(s);
  if (!Number.isFinite(num)) return { ok: false, error: "\u6570\u503C\u8D85\u51FA\u8303\u56F4" };
  if (num === 0 && !allowZero) return { ok: false, error: "\u6570\u503C\u9700\u5927\u4E8E 0" };
  const normalized = s.replace(/^0+(?=\d)/, "");
  return { ok: true, value: normalized };
}
var TEXT_MAX_LENGTH = 4e3;
function validateText(raw, label, required) {
  if (required && raw.trim() === "") return `\u8BF7\u586B\u5199${label}`;
  if (raw.length > TEXT_MAX_LENGTH) return `${label}\u6700\u591A ${TEXT_MAX_LENGTH} \u5B57\uFF0C\u5F53\u524D ${raw.length} \u5B57`;
  return null;
}

// ../../packages/domain/src/fields.ts
var GLUCOSE_SLOTS = [
  { slot: "fasting", label: "\u7A7A\u8179" },
  { slot: "breakfast_2h", label: "\u65E9\u9910\u540E2\u5C0F\u65F6" },
  { slot: "lunch_pre", label: "\u5348\u9910\u524D" },
  { slot: "lunch_2h", label: "\u5348\u9910\u540E2\u5C0F\u65F6" },
  { slot: "dinner_pre", label: "\u665A\u9910\u524D" },
  { slot: "dinner_2h", label: "\u665A\u9910\u540E2\u5C0F\u65F6" },
  { slot: "bedtime", label: "\u7761\u524D" }
];
var FIELD_GROUPS = [
  {
    id: "glucose",
    label: "\u8840\u7CD6",
    slots: [
      ...GLUCOSE_SLOTS.map((s) => ({ kind: "glucose", slot: s.slot, label: s.label, multi: true })),
      { kind: "glucose", slot: "temporary", label: "\u4E34\u65F6\u6D4B\u91CF", multi: true }
    ]
  },
  {
    id: "blood_pressure",
    label: "\u8840\u538B",
    slots: [
      { kind: "blood_pressure", slot: "fasting", label: "\u7A7A\u8179", multi: true },
      { kind: "blood_pressure", slot: "bedtime", label: "\u7761\u524D", multi: true }
    ]
  },
  {
    id: "weight",
    label: "\u4F53\u91CD",
    slots: [
      { kind: "weight", slot: "morning", label: "\u65E9", multi: true },
      { kind: "weight", slot: "evening", label: "\u665A", multi: true }
    ]
  },
  {
    id: "food_water",
    label: "\u996E\u98DF\u4E0E\u996E\u6C34",
    slots: [
      { kind: "meal", slot: "breakfast", label: "\u65E9\u9910", multi: false },
      { kind: "meal", slot: "lunch", label: "\u5348\u9910", multi: false },
      { kind: "meal", slot: "dinner", label: "\u665A\u9910", multi: false },
      { kind: "water", slot: "daily", label: "\u5F53\u5929\u996E\u6C34\u91CF", multi: false }
    ]
  },
  {
    id: "exercise",
    label: "\u8FD0\u52A8",
    slots: [{ kind: "exercise", slot: "daily", label: "\u5F53\u65E5\u8FD0\u52A8", multi: true }]
  },
  {
    id: "insulin",
    label: "\u80F0\u5C9B\u7D20",
    slots: [{ kind: "insulin", slot: "daily", label: "\u5F53\u65E5\u80F0\u5C9B\u7D20", multi: true }]
  },
  {
    id: "day_note",
    label: "\u65E5\u7EAA\u8981",
    slots: [{ kind: "day_note", slot: "daily", label: "\u65E5\u7EAA\u8981", multi: false }]
  }
];
var UNIQUE_SLOT_KINDS = /* @__PURE__ */ new Set(["meal", "water", "day_note", "month_note"]);
function isUniqueSlot(kind) {
  return UNIQUE_SLOT_KINDS.has(kind);
}

// src/http.ts
import { randomUUID as randomUUID2 } from "node:crypto";
var ApiError = class extends Error {
  status;
  code;
  fieldErrors;
  retryable;
  constructor(status, code, message, opts = {}) {
    super(message);
    this.status = status;
    this.code = code;
    this.fieldErrors = opts.fieldErrors;
    this.retryable = opts.retryable ?? false;
  }
};
var errors = {
  sessionExpired: () => new ApiError(401, "SESSION_EXPIRED", "\u767B\u5F55\u5DF2\u8FC7\u671F\uFF0C\u8BF7\u91CD\u65B0\u767B\u5F55"),
  forbidden: (msg = "\u65E0\u6743\u8BBF\u95EE\u8BE5\u8D44\u6E90") => new ApiError(403, "FORBIDDEN", msg),
  notFound: (msg = "\u8D44\u6E90\u4E0D\u5B58\u5728") => new ApiError(404, "NOT_FOUND", msg),
  badRequest: (msg) => new ApiError(400, "BAD_REQUEST", msg),
  validation: (fieldErrors, msg = "\u63D0\u4EA4\u5185\u5BB9\u672A\u901A\u8FC7\u6821\u9A8C") => new ApiError(422, "VALIDATION_FAILED", msg, { fieldErrors }),
  versionConflict: (msg = "\u8BB0\u5F55\u5DF2\u5728\u5176\u5B83\u8BBE\u5907\u88AB\u4FEE\u6539") => new ApiError(409, "VERSION_CONFLICT", msg),
  slotExists: (msg = "\u8BE5\u6761\u76EE\u5DF2\u5B58\u5728\uFF0C\u4E0D\u80FD\u91CD\u590D\u521B\u5EFA") => new ApiError(409, "SLOT_EXISTS", msg),
  cursorExpired: () => new ApiError(410, "CURSOR_EXPIRED", "\u589E\u91CF\u6E38\u6807\u5DF2\u8FC7\u671F\uFF0C\u9700\u8981\u91CD\u65B0\u83B7\u53D6\u5168\u91CF\u5FEB\u7167"),
  rateLimited: () => new ApiError(429, "RATE_LIMITED", "\u8BF7\u6C42\u8FC7\u4E8E\u9891\u7E41\uFF0C\u8BF7\u7A0D\u540E\u91CD\u8BD5", { retryable: true }),
  unavailable: (msg = "\u670D\u52A1\u6682\u65F6\u4E0D\u53EF\u7528") => new ApiError(503, "TEMPORARILY_UNAVAILABLE", msg, { retryable: true }),
  payloadTooLarge: () => new ApiError(413, "PAYLOAD_TOO_LARGE", "\u8BF7\u6C42\u4F53\u8FC7\u5927")
};
function createRouter() {
  const routes = [];
  const add = (method, path, handler, auth = true) => {
    routes.push({ method, segments: path.split("/").filter(Boolean), handler, auth });
  };
  return {
    get: (p, h, auth = true) => add("GET", p, h, auth),
    post: (p, h, auth = true) => add("POST", p, h, auth),
    patch: (p, h, auth = true) => add("PATCH", p, h, auth),
    delete: (p, h, auth = true) => add("DELETE", p, h, auth),
    match(method, path) {
      const parts = path.split("/").filter(Boolean);
      for (const route of routes) {
        if (route.method !== method) continue;
        if (route.segments.length !== parts.length) continue;
        const params = {};
        let ok = true;
        for (let i = 0; i < route.segments.length; i += 1) {
          const seg = route.segments[i];
          const actual = parts[i];
          if (seg.startsWith(":")) {
            params[seg.slice(1)] = decodeURIComponent(actual);
          } else if (seg !== actual) {
            ok = false;
            break;
          }
        }
        if (ok) return { route, params };
      }
      return null;
    }
  };
}
async function readJsonBody(req, maxBytes) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    const buf = chunk;
    size += buf.length;
    if (size > maxBytes) throw errors.payloadTooLarge();
    chunks.push(buf);
  }
  if (size === 0) return {};
  const raw = Buffer.concat(chunks).toString("utf8");
  try {
    const parsed = JSON.parse(raw);
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      throw errors.badRequest("\u8BF7\u6C42\u4F53\u5FC5\u987B\u662F JSON \u5BF9\u8C61");
    }
    return parsed;
  } catch (err) {
    if (err instanceof ApiError) throw err;
    throw errors.badRequest("\u8BF7\u6C42\u4F53\u4E0D\u662F\u5408\u6CD5 JSON");
  }
}
var SECURITY_HEADERS = {
  "X-Content-Type-Options": "nosniff",
  "X-Frame-Options": "DENY",
  "Referrer-Policy": "no-referrer",
  // API 响应不进任何缓存；Service Worker 也不得缓存（架构 §2）
  "Cache-Control": "no-store, no-cache, must-revalidate, private"
};
function sendJson(res, status, payload, requestId) {
  const body = payload === void 0 ? "" : JSON.stringify(payload);
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "X-Request-Id": requestId,
    ...SECURITY_HEADERS
  });
  res.end(body);
}
function sendError(res, err, requestId) {
  sendJson(
    res,
    err.status,
    {
      requestId,
      code: err.code,
      message: err.message,
      ...err.fieldErrors ? { fieldErrors: err.fieldErrors } : {},
      retryable: err.retryable
    },
    requestId
  );
}
function clientIp(req) {
  const fwd = req.headers["x-forwarded-for"];
  if (typeof fwd === "string" && fwd.length > 0) return fwd.split(",")[0].trim();
  if (Array.isArray(fwd) && fwd.length > 0) return fwd[0].split(",")[0].trim();
  return req.socket.remoteAddress ?? "unknown";
}
function newRequestId() {
  return randomUUID2();
}
function bearerToken(req) {
  const raw = req.headers["authorization"];
  if (typeof raw !== "string") return null;
  const m = /^Bearer\s+(.+)$/i.exec(raw.trim());
  return m?.[1]?.trim() || null;
}
function logAccess(entry) {
  process.stdout.write(
    `${JSON.stringify({ at: (/* @__PURE__ */ new Date()).toISOString(), ...entry })}
`
  );
}

// src/validate.ts
var RECORD_KINDS = [
  "glucose",
  "blood_pressure",
  "weight",
  "meal",
  "water",
  "exercise",
  "insulin",
  "day_note",
  "month_note"
];
var ALLOWED_KEYS = {
  glucose: ["kind", "value", "unit", "note"],
  blood_pressure: ["kind", "systolic", "diastolic", "unit", "note"],
  weight: ["kind", "value", "unit"],
  meal: ["kind", "text"],
  water: ["kind", "total", "unit", "note"],
  exercise: ["kind", "text", "durationMinutes"],
  insulin: ["kind", "text", "name", "dose", "doseUnit"],
  day_note: ["kind", "text"],
  month_note: ["kind", "text"]
};
var ALLOWED_SLOTS = {
  glucose: ["fasting", "breakfast_2h", "lunch_pre", "lunch_2h", "dinner_pre", "dinner_2h", "bedtime", "temporary"],
  blood_pressure: ["fasting", "bedtime"],
  weight: ["morning", "evening"],
  meal: ["breakfast", "lunch", "dinner"],
  water: ["daily"],
  exercise: ["daily"],
  insulin: ["daily"],
  day_note: ["daily"],
  month_note: ["monthly"]
};
function isRecordKind(v) {
  return typeof v === "string" && RECORD_KINDS.includes(v);
}
function validatePayload(kind, raw) {
  const errors2 = [];
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    return { ok: false, errors: [{ field: "payload", message: "\u8BB0\u5F55\u5185\u5BB9\u7F3A\u5931\u6216\u683C\u5F0F\u4E0D\u6B63\u786E" }] };
  }
  const p = raw;
  for (const key of Object.keys(p)) {
    if (!ALLOWED_KEYS[kind].includes(key)) {
      errors2.push({ field: `payload.${key}`, message: "\u5305\u542B\u8BE5\u8BB0\u5F55\u7C7B\u578B\u4E0D\u5141\u8BB8\u7684\u5B57\u6BB5" });
    }
  }
  if (p["kind"] !== kind) {
    errors2.push({ field: "payload.kind", message: "\u8BB0\u5F55\u7C7B\u578B\u4E0E\u5185\u5BB9\u4E0D\u4E00\u81F4" });
  }
  const str = (key) => typeof p[key] === "string" ? p[key] : "";
  const optStr = (key) => {
    const v = str(key).trim();
    return v === "" ? void 0 : v;
  };
  const dec = (key, allowZero) => {
    const r = validateDecimal(str(key), { allowZero });
    if (!r.ok) errors2.push({ field: key, message: r.error });
    return r.ok ? r.value : "";
  };
  const text = (key, required, label) => {
    const v = str(key);
    const err = validateText(v, label, required);
    if (err) errors2.push({ field: key, message: err });
    return v;
  };
  const unitOf = (key, fallback) => optStr(key) ?? fallback;
  let payload;
  switch (kind) {
    case "glucose":
      payload = {
        kind,
        value: dec("value", false),
        unit: unitOf("unit", "mmol/L"),
        note: optStr("note")
      };
      break;
    case "blood_pressure":
      payload = {
        kind,
        systolic: dec("systolic", false),
        diastolic: dec("diastolic", false),
        unit: unitOf("unit", "mmHg"),
        note: optStr("note")
      };
      break;
    case "weight":
      payload = { kind, value: dec("value", false), unit: unitOf("unit", "kg") };
      break;
    case "meal":
      payload = { kind, text: text("text", true, "\u996E\u98DF\u5185\u5BB9") };
      break;
    case "water":
      payload = {
        kind,
        total: dec("total", true),
        unit: unitOf("unit", "mL"),
        note: optStr("note")
      };
      break;
    case "exercise": {
      const duration = p["durationMinutes"];
      let durationMinutes;
      if (duration !== void 0 && duration !== null) {
        if (typeof duration !== "number" || !Number.isInteger(duration) || duration < 0) {
          errors2.push({ field: "durationMinutes", message: "\u65F6\u957F\u9700\u4E3A\u975E\u8D1F\u6574\u6570\uFF08\u5206\u949F\uFF09" });
        } else {
          durationMinutes = duration;
        }
      }
      payload = { kind, text: text("text", true, "\u8FD0\u52A8\u5185\u5BB9"), durationMinutes };
      break;
    }
    case "insulin": {
      const dose = optStr("dose");
      const doseUnit = optStr("doseUnit");
      if (dose && !doseUnit) errors2.push({ field: "doseUnit", message: "\u586B\u5199\u5242\u91CF\u65F6\u5355\u4F4D\u5FC5\u586B" });
      if (dose) {
        const r = validateDecimal(dose, { allowZero: false });
        if (!r.ok) errors2.push({ field: "dose", message: r.error });
      }
      payload = { kind, text: text("text", true, "\u539F\u8868\u5185\u5BB9\u6587\u5B57"), name: optStr("name"), dose, doseUnit };
      break;
    }
    case "day_note":
      payload = { kind, text: text("text", false, "\u65E5\u7EAA\u8981") };
      break;
    case "month_note":
      payload = { kind, text: text("text", false, "\u672C\u6708\u7EAA\u8981") };
      break;
  }
  if (errors2.length > 0) return { ok: false, errors: errors2 };
  return { ok: true, payload };
}
function validateSlot(kind, slot) {
  if (typeof slot !== "string" || slot.trim() === "") return { field: "slot", message: "\u65F6\u70B9\u5FC5\u586B" };
  if (!ALLOWED_SLOTS[kind].includes(slot)) return { field: "slot", message: `\u8BE5\u8BB0\u5F55\u7C7B\u578B\u4E0D\u652F\u6301\u65F6\u70B9 ${slot}` };
  return null;
}
function validatePeriodKey(kind, periodKey) {
  if (typeof periodKey !== "string") return { field: "periodKey", message: "\u65E5\u671F\u5FC5\u586B" };
  const dayRe = /^\d{4}-\d{2}-\d{2}$/;
  const monthRe = /^\d{4}-\d{2}$/;
  const ok = kind === "month_note" ? monthRe.test(periodKey) : dayRe.test(periodKey);
  if (!ok) return { field: "periodKey", message: "\u65E5\u671F\u683C\u5F0F\u4E0D\u6B63\u786E" };
  const parsed = /* @__PURE__ */ new Date(kind === "month_note" ? `${periodKey}-01T00:00:00Z` : `${periodKey}T00:00:00Z`);
  if (Number.isNaN(parsed.getTime())) return { field: "periodKey", message: "\u65E5\u671F\u4E0D\u5B58\u5728" };
  return null;
}

// src/routes.ts
var MAX_PAGE = 200;
function rowToRecord(row) {
  return {
    id: String(row["id"]),
    accountId: String(row["account_id"]),
    kind: String(row["kind"]),
    periodKey: String(row["period_key"]),
    slot: String(row["slot"]),
    occurredAt: row["occurred_at"] === null || row["occurred_at"] === void 0 ? null : String(row["occurred_at"]),
    timePrecision: String(row["time_precision"]) === "minute" ? "minute" : "unknown",
    timezone: String(row["timezone"]),
    payload: JSON.parse(String(row["payload"])),
    version: Number(row["version"]),
    createdAt: String(row["created_at"]),
    updatedAt: String(row["updated_at"]),
    deletedAt: row["deleted_at"] === null || row["deleted_at"] === void 0 ? null : String(row["deleted_at"])
  };
}
function canonical(value) {
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null";
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  const obj = value;
  const keys = Object.keys(obj).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${canonical(obj[k])}`).join(",")}}`;
}
function requestHash(payload) {
  return createHash("sha256").update(canonical(payload)).digest("hex");
}
function bumpSeq(db2, accountId) {
  db2.prepare("UPDATE account_sync_state SET last_seq = last_seq + 1 WHERE account_id = ?").run(accountId);
  const row = db2.prepare("SELECT last_seq FROM account_sync_state WHERE account_id = ?").get(accountId);
  if (!row) {
    db2.prepare("INSERT INTO account_sync_state (account_id, last_seq) VALUES (?, 1)").run(accountId);
    return 1;
  }
  return Number(row["last_seq"]);
}
function getRecord(db2, accountId, recordId) {
  const row = db2.prepare("SELECT * FROM records WHERE id = ? AND account_id = ?").get(recordId, accountId);
  return row ? rowToRecord(row) : null;
}
var loginAttempts = /* @__PURE__ */ new Map();
var LOGIN_WINDOW_MS = 5 * 6e4;
var LOGIN_MAX = 10;
function throttleLogin(ip) {
  const now = Date.now();
  const entry = loginAttempts.get(ip);
  if (!entry || entry.resetAt < now) {
    loginAttempts.set(ip, { count: 1, resetAt: now + LOGIN_WINDOW_MS });
    return;
  }
  entry.count += 1;
  if (entry.count > LOGIN_MAX) throw errors.rateLimited();
}
function registerRoutes(db2) {
  const router2 = createRouter();
  router2.get("/healthz", () => ({ ok: true, time: (/* @__PURE__ */ new Date()).toISOString() }), false);
  router2.post(
    "/api/v1/auth/login",
    (ctx) => {
      throttleLogin(ctx.remoteIp);
      const username = typeof ctx.body["username"] === "string" ? ctx.body["username"].trim() : "";
      const password = typeof ctx.body["password"] === "string" ? ctx.body["password"] : "";
      if (!username || !password) {
        throw errors.validation([
          ...username ? [] : [{ field: "username", message: "\u8BF7\u8F93\u5165\u7528\u6237\u540D" }],
          ...password ? [] : [{ field: "password", message: "\u8BF7\u8F93\u5165\u5BC6\u7801" }]
        ]);
      }
      const account = authenticate(db2, username, password);
      if (!account) throw new ApiError(401, "INVALID_CREDENTIALS", "\u7528\u6237\u540D\u6216\u5BC6\u7801\u4E0D\u6B63\u786E");
      const session = createSession(db2, account.id);
      return {
        token: session.token,
        expiresAt: session.expiresAt,
        account: { id: account.id, username: account.username }
      };
    },
    false
  );
  router2.post("/api/v1/auth/logout", (ctx) => {
    if (ctx.token) revokeSession(db2, ctx.token);
    return { ok: true };
  });
  router2.get("/api/v1/auth/me", (ctx) => ({
    account: { id: ctx.account.id, username: ctx.account.username }
  }));
  router2.post("/api/v1/auth/password", (ctx) => {
    const oldPassword = typeof ctx.body["oldPassword"] === "string" ? ctx.body["oldPassword"] : "";
    const newPassword = typeof ctx.body["newPassword"] === "string" ? ctx.body["newPassword"] : "";
    if (newPassword.length < 8) {
      throw errors.validation([{ field: "newPassword", message: "\u65B0\u5BC6\u7801\u81F3\u5C11 8 \u4F4D" }]);
    }
    if (!changePassword(db2, ctx.account.id, oldPassword, newPassword)) {
      throw errors.validation([{ field: "oldPassword", message: "\u539F\u5BC6\u7801\u4E0D\u6B63\u786E" }]);
    }
    db2.prepare("DELETE FROM sessions WHERE account_id = ?").run(ctx.account.id);
    return { ok: true, reauthRequired: true };
  });
  router2.get("/api/v1/profile", (ctx) => {
    const row = db2.prepare("SELECT * FROM profile_settings WHERE account_id = ?").get(ctx.account.id);
    return {
      glucoseUnit: String(row["glucose_unit"]),
      weightUnit: String(row["weight_unit"]),
      waterUnit: String(row["water_unit"]),
      timezone: String(row["timezone"]),
      version: Number(row["version"])
    };
  });
  router2.patch("/api/v1/profile", (ctx) => {
    const accountId = ctx.account.id;
    const row = db2.prepare("SELECT * FROM profile_settings WHERE account_id = ?").get(accountId);
    const current = Number(row["version"]);
    const expected = Number(ctx.body["expectedVersion"]);
    if (!Number.isInteger(expected)) {
      throw errors.validation([{ field: "expectedVersion", message: "\u7F3A\u5C11\u7248\u672C\u53F7" }]);
    }
    if (expected !== current) throw errors.versionConflict("\u8D26\u6237\u914D\u7F6E\u5DF2\u5728\u5176\u5B83\u8BBE\u5907\u88AB\u4FEE\u6539");
    const fields = [];
    for (const [key, column] of [
      ["glucoseUnit", "glucose_unit"],
      ["weightUnit", "weight_unit"],
      ["waterUnit", "water_unit"],
      ["timezone", "timezone"]
    ]) {
      const v = ctx.body[key];
      if (v === void 0) continue;
      if (typeof v !== "string" || v.trim() === "") {
        throw errors.validation([{ field: key, message: "\u4E0D\u80FD\u4E3A\u7A7A" }]);
      }
      fields.push([column, v.trim()]);
    }
    if (fields.length === 0) throw errors.validation([{ field: "__form", message: "\u6CA1\u6709\u9700\u8981\u66F4\u65B0\u7684\u5B57\u6BB5" }]);
    const now = (/* @__PURE__ */ new Date()).toISOString();
    const sets = fields.map(([c]) => `${c} = ?`).join(", ");
    db2.prepare(`UPDATE profile_settings SET ${sets}, version = version + 1, updated_at = ? WHERE account_id = ?`).run(
      ...fields.map(([, v]) => v),
      now,
      accountId
    );
    const updated = db2.prepare("SELECT * FROM profile_settings WHERE account_id = ?").get(accountId);
    return {
      glucoseUnit: String(updated["glucose_unit"]),
      weightUnit: String(updated["weight_unit"]),
      waterUnit: String(updated["water_unit"]),
      timezone: String(updated["timezone"]),
      version: Number(updated["version"])
    };
  });
  router2.get("/api/v1/snapshot", (ctx) => {
    const accountId = ctx.account.id;
    const limit = Math.min(Number(ctx.query.get("limit") ?? 100) || 100, MAX_PAGE);
    const from = ctx.query.get("from");
    const to = ctx.query.get("to");
    const token = ctx.query.get("cursor");
    let snapshotSeq;
    let offset = 0;
    let snapshotAt;
    if (token) {
      const parsed = parseSnapshotToken(token, accountId);
      snapshotSeq = parsed.snapshotSeq;
      offset = parsed.offset;
      snapshotAt = parsed.snapshotAt;
    } else {
      const state = db2.prepare("SELECT last_seq FROM account_sync_state WHERE account_id = ?").get(accountId);
      snapshotSeq = state ? Number(state["last_seq"]) : 0;
      snapshotAt = (/* @__PURE__ */ new Date()).toISOString();
    }
    const conditions = ["account_id = ?", "created_at <= ?"];
    const params = [accountId, snapshotAt];
    if (from) {
      conditions.push("period_key >= ?");
      params.push(from);
    }
    if (to) {
      conditions.push("period_key <= ?");
      params.push(to);
    }
    const rows = db2.prepare(
      `SELECT * FROM records WHERE ${conditions.join(" AND ")} ORDER BY id ASC LIMIT ? OFFSET ?`
    ).all(...params, limit + 1, offset);
    const hasMore = rows.length > limit;
    const page = hasMore ? rows.slice(0, limit) : rows;
    const nextOffset = offset + page.length;
    return {
      snapshotSeq,
      snapshotAt,
      syncCursor: snapshotSeq,
      records: page.map(rowToRecord),
      hasMore,
      nextPageToken: hasMore ? formatSnapshotToken(accountId, snapshotSeq, snapshotAt, nextOffset) : null
    };
  });
  router2.get("/api/v1/changes", (ctx) => {
    const accountId = ctx.account.id;
    const limit = Math.min(Number(ctx.query.get("limit") ?? 200) || 200, MAX_PAGE);
    const cursorRaw = ctx.query.get("cursor");
    const cursor = cursorRaw ? Number(cursorRaw) : 0;
    if (!Number.isInteger(cursor) || cursor < 0) {
      throw errors.validation([{ field: "cursor", message: "\u6E38\u6807\u683C\u5F0F\u4E0D\u6B63\u786E" }]);
    }
    const minRow = db2.prepare("SELECT MIN(seq) AS m FROM changes WHERE account_id = ?").get(accountId);
    const minSeq = minRow["m"] === null || minRow["m"] === void 0 ? null : Number(minRow["m"]);
    if (minSeq !== null && cursor < minSeq - 1) throw errors.cursorExpired();
    const rows = db2.prepare(
      `SELECT c.seq, c.record_id, c.version, c.action, c.committed_at, r.snapshot
           FROM changes c
           LEFT JOIN record_revisions r
             ON r.record_id = c.record_id AND r.version = c.version
          WHERE c.account_id = ? AND c.seq > ?
          ORDER BY c.seq ASC
          LIMIT ?`
    ).all(accountId, cursor, limit + 1);
    const hasMore = rows.length > limit;
    const page = hasMore ? rows.slice(0, limit) : rows;
    const lastSeq = page.length > 0 ? Number(page[page.length - 1]["seq"]) : cursor;
    return {
      changes: page.map((r) => ({
        seq: Number(r["seq"]),
        recordId: String(r["record_id"]),
        version: Number(r["version"]),
        action: String(r["action"]),
        committedAt: String(r["committed_at"]),
        // 该 seq 对应的提交版本快照，而不是记录当前最新版本
        record: r["snapshot"] === null || r["snapshot"] === void 0 ? null : JSON.parse(String(r["snapshot"]))
      })),
      nextCursor: lastSeq,
      hasMore
    };
  });
  router2.get("/api/v1/records", (ctx) => {
    const accountId = ctx.account.id;
    const limit = Math.min(Number(ctx.query.get("limit") ?? 100) || 100, MAX_PAGE);
    const offset = Math.max(Number(ctx.query.get("offset") ?? 0) || 0, 0);
    const conditions = ["account_id = ?"];
    const params = [accountId];
    const periodKey = ctx.query.get("periodKey");
    const kind = ctx.query.get("kind");
    const slot = ctx.query.get("slot");
    if (periodKey) {
      conditions.push("period_key = ?");
      params.push(periodKey);
    }
    if (kind) {
      if (!isRecordKind(kind)) throw errors.validation([{ field: "kind", message: "\u8BB0\u5F55\u7C7B\u578B\u4E0D\u6B63\u786E" }]);
      conditions.push("kind = ?");
      params.push(kind);
    }
    if (slot) {
      conditions.push("slot = ?");
      params.push(slot);
    }
    if (ctx.query.get("includeDeleted") !== "1") conditions.push("deleted_at IS NULL");
    const rows = db2.prepare(`SELECT * FROM records WHERE ${conditions.join(" AND ")} ORDER BY period_key DESC, kind ASC, slot ASC LIMIT ? OFFSET ?`).all(...params, limit, offset);
    return { records: rows.map(rowToRecord) };
  });
  router2.get("/api/v1/records/:id", (ctx) => {
    const record = getRecord(db2, ctx.account.id, ctx.params["id"]);
    if (!record) throw errors.notFound("\u8BB0\u5F55\u4E0D\u5B58\u5728");
    return { record };
  });
  router2.get("/api/v1/records/:id/revisions", (ctx) => {
    const accountId = ctx.account.id;
    const recordId = ctx.params["id"];
    const record = getRecord(db2, accountId, recordId);
    if (!record) throw errors.notFound("\u8BB0\u5F55\u4E0D\u5B58\u5728");
    const rows = db2.prepare(
      `SELECT version, action, server_at, snapshot FROM record_revisions
          WHERE record_id = ? AND account_id = ? ORDER BY version DESC LIMIT 50`
    ).all(recordId, accountId);
    return {
      revisions: rows.map((r) => ({
        version: Number(r["version"]),
        action: String(r["action"]),
        serverAt: String(r["server_at"]),
        record: JSON.parse(String(r["snapshot"]))
      }))
    };
  });
  router2.post("/api/v1/mutations", (ctx) => {
    const accountId = ctx.account.id;
    const mutationId = ctx.body["mutationId"];
    const recordId = ctx.body["recordId"];
    const action = ctx.body["action"];
    if (typeof mutationId !== "string" || mutationId.trim() === "") {
      throw errors.validation([{ field: "mutationId", message: "\u7F3A\u5C11\u5E42\u7B49\u952E" }]);
    }
    if (typeof recordId !== "string" || recordId.trim() === "") {
      throw errors.validation([{ field: "recordId", message: "\u7F3A\u5C11\u8BB0\u5F55 ID" }]);
    }
    if (action !== "create" && action !== "update" && action !== "delete" && action !== "restore") {
      throw errors.validation([{ field: "action", message: "\u4E0D\u652F\u6301\u7684\u64CD\u4F5C\u7C7B\u578B" }]);
    }
    const expectedVersion = Number(ctx.body["expectedVersion"] ?? 0);
    if (!Number.isInteger(expectedVersion) || expectedVersion < 0) {
      throw errors.validation([{ field: "expectedVersion", message: "\u7248\u672C\u53F7\u4E0D\u6B63\u786E" }]);
    }
    const fingerprint = requestHash({ recordId, action, expectedVersion, record: ctx.body["record"] ?? null });
    return inTransaction(db2, () => {
      const seen = db2.prepare("SELECT request_hash, response FROM mutations WHERE account_id = ? AND mutation_id = ?").get(accountId, mutationId);
      if (seen) {
        if (String(seen["request_hash"]) !== fingerprint) {
          throw errors.validation([
            { field: "mutationId", message: "\u8BE5\u5E42\u7B49\u952E\u5DF2\u7528\u4E8E\u4E0D\u540C\u7684\u8BF7\u6C42\u5185\u5BB9\uFF0C\u8BF7\u66F4\u6362 mutationId" }
          ]);
        }
        return JSON.parse(String(seen["response"]));
      }
      const now = (/* @__PURE__ */ new Date()).toISOString();
      let result;
      if (action === "delete" || action === "restore") {
        const current = getRecord(db2, accountId, recordId);
        if (!current) throw errors.notFound("\u8BB0\u5F55\u4E0D\u5B58\u5728");
        if (current.version !== expectedVersion) throw errors.versionConflict();
        const next = {
          ...current,
          deletedAt: action === "delete" ? now : null,
          version: current.version + 1,
          updatedAt: now
        };
        try {
          db2.prepare("UPDATE records SET deleted_at = ?, version = ?, updated_at = ? WHERE id = ? AND account_id = ?").run(
            next.deletedAt,
            next.version,
            now,
            recordId,
            accountId
          );
        } catch (err) {
          if (isUniqueViolation(err)) throw errors.slotExists("\u8BE5\u6761\u76EE\u5DF2\u5B58\u5728\u6D3B\u52A8\u8BB0\u5F55\uFF0C\u65E0\u6CD5\u6062\u590D");
          throw err;
        }
        result = { record: next, version: next.version, commitSeq: 0 };
      } else {
        const raw = ctx.body["record"];
        if (typeof raw !== "object" || raw === null) {
          throw errors.validation([{ field: "record", message: "\u7F3A\u5C11\u8BB0\u5F55\u5185\u5BB9" }]);
        }
        const body = raw;
        const kind = body["kind"];
        if (!isRecordKind(kind)) {
          throw errors.validation([{ field: "kind", message: "\u8BB0\u5F55\u7C7B\u578B\u4E0D\u6B63\u786E" }]);
        }
        const fieldErrors = [
          validatePeriodKey(kind, body["periodKey"]),
          validateSlot(kind, body["slot"])
        ].filter((e) => e !== null);
        const payloadResult = validatePayload(kind, body["payload"]);
        let payloadText = "";
        if (payloadResult.ok) {
          payloadText = JSON.stringify(payloadResult.payload);
        } else {
          fieldErrors.push(...payloadResult.errors);
        }
        if (fieldErrors.length > 0) throw errors.validation(fieldErrors);
        const occurredAt = typeof body["occurredAt"] === "string" && body["occurredAt"].trim() !== "" ? body["occurredAt"].trim() : null;
        if (occurredAt !== null && !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/.test(occurredAt)) {
          throw errors.validation([{ field: "occurredAt", message: "\u65F6\u95F4\u683C\u5F0F\u4E0D\u6B63\u786E" }]);
        }
        const timePrecision = occurredAt === null ? "unknown" : "minute";
        const timezone = typeof body["timezone"] === "string" && body["timezone"].trim() !== "" ? body["timezone"].trim() : CONFIG.defaultTimezone;
        const existing = getRecord(db2, accountId, recordId);
        if (action === "create") {
          if (existing) {
            throw errors.versionConflict("\u8BE5\u8BB0\u5F55\u5DF2\u5B58\u5728\uFF0C\u8BF7\u5237\u65B0\u540E\u91CD\u8BD5");
          }
          if (isUniqueSlot(kind)) {
            const clash = db2.prepare(
              "SELECT id FROM records WHERE account_id = ? AND kind = ? AND period_key = ? AND slot = ? AND deleted_at IS NULL"
            ).get(accountId, kind, String(body["periodKey"]), String(body["slot"]));
            if (clash) throw errors.slotExists();
          }
          try {
            db2.prepare(
              `INSERT INTO records (id, account_id, kind, period_key, slot, occurred_at, time_precision, timezone, payload, version, created_at, updated_at, deleted_at)
               VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?, NULL)`
            ).run(
              recordId,
              accountId,
              kind,
              String(body["periodKey"]),
              String(body["slot"]),
              occurredAt,
              timePrecision,
              timezone,
              payloadText,
              now,
              now
            );
          } catch (err) {
            if (isUniqueViolation(err)) throw errors.slotExists();
            throw err;
          }
        } else {
          if (!existing) throw errors.notFound("\u8BB0\u5F55\u4E0D\u5B58\u5728");
          if (existing.version !== expectedVersion) throw errors.versionConflict();
          if (existing.kind !== kind) {
            throw errors.validation([{ field: "kind", message: "\u4E0D\u80FD\u4FEE\u6539\u8BB0\u5F55\u7C7B\u578B" }]);
          }
          try {
            db2.prepare(
              `UPDATE records SET period_key = ?, slot = ?, occurred_at = ?, time_precision = ?, timezone = ?, payload = ?, version = version + 1, updated_at = ?, deleted_at = NULL
                WHERE id = ? AND account_id = ?`
            ).run(
              String(body["periodKey"]),
              String(body["slot"]),
              occurredAt,
              timePrecision,
              timezone,
              payloadText,
              now,
              recordId,
              accountId
            );
          } catch (err) {
            if (isUniqueViolation(err)) throw errors.slotExists();
            throw err;
          }
        }
        const saved = getRecord(db2, accountId, recordId);
        if (!saved) throw errors.unavailable("\u5199\u5165\u540E\u672A\u80FD\u8BFB\u56DE\u8BB0\u5F55");
        result = { record: saved, version: saved.version, commitSeq: 0 };
      }
      db2.prepare(
        "INSERT INTO record_revisions (record_id, version, account_id, snapshot, action, actor_id, server_at) VALUES (?, ?, ?, ?, ?, ?, ?)"
      ).run(recordId, result.version, accountId, JSON.stringify(result.record), action, ctx.account.id, now);
      const seq = bumpSeq(db2, accountId);
      db2.prepare(
        "INSERT INTO changes (account_id, seq, record_id, version, action, committed_at) VALUES (?, ?, ?, ?, ?, ?)"
      ).run(accountId, seq, recordId, result.version, action, now);
      const response = { ...result, commitSeq: seq };
      db2.prepare(
        "INSERT INTO mutations (account_id, mutation_id, request_hash, response, created_at) VALUES (?, ?, ?, ?, ?)"
      ).run(accountId, mutationId, fingerprint, JSON.stringify(response), now);
      return response;
    });
  });
  return router2;
}
function formatSnapshotToken(accountId, snapshotSeq, snapshotAt, offset) {
  const body = `${snapshotSeq}|${snapshotAt}|${offset}`;
  const mac = createHash("sha256").update(`${accountId}|${body}`).digest("hex").slice(0, 16);
  return Buffer.from(`${body}|${mac}`).toString("base64url");
}
function parseSnapshotToken(token, accountId) {
  let decoded;
  try {
    decoded = Buffer.from(token, "base64url").toString("utf8");
  } catch {
    throw errors.validation([{ field: "cursor", message: "\u5206\u9875\u6E38\u6807\u683C\u5F0F\u4E0D\u6B63\u786E" }]);
  }
  const parts = decoded.split("|");
  if (parts.length !== 4) throw errors.validation([{ field: "cursor", message: "\u5206\u9875\u6E38\u6807\u683C\u5F0F\u4E0D\u6B63\u786E" }]);
  const [seqRaw, snapshotAt, offsetRaw, mac] = parts;
  const expected = createHash("sha256").update(`${accountId}|${seqRaw}|${snapshotAt}|${offsetRaw}`).digest("hex").slice(0, 16);
  if (mac !== expected) throw errors.validation([{ field: "cursor", message: "\u5206\u9875\u6E38\u6807\u65E0\u6548" }]);
  return { snapshotSeq: Number(seqRaw), snapshotAt, offset: Number(offsetRaw) };
}
function isUniqueViolation(err) {
  const msg = err instanceof Error ? err.message : String(err);
  return /UNIQUE constraint failed|SQLITE_CONSTRAINT_UNIQUE/i.test(msg);
}

// src/server.ts
var SERVER_VERSION = "1.0.0";
var db = openDb(CONFIG.dbPath);
var bootstrap = ensureBootstrapAccount(db);
if (bootstrap) {
  process3.stdout.write(
    `${JSON.stringify({
      at: (/* @__PURE__ */ new Date()).toISOString(),
      level: "info",
      msg: "\u5DF2\u521B\u5EFA\u521D\u59CB\u8D26\u6237",
      username: bootstrap.account.username,
      ...bootstrap.generatedPassword ? { password: bootstrap.generatedPassword, note: "\u6B64\u5BC6\u7801\u4EC5\u672C\u6B21\u6253\u5370\uFF0C\u8BF7\u7ACB\u5373\u4FDD\u5B58\u5E76\u4E8E\u767B\u5F55\u540E\u4FEE\u6539" } : {}
    })}
`
  );
}
purgeExpired(db, CONFIG.retentionDays);
var purgeTimer = setInterval(() => purgeExpired(db, CONFIG.retentionDays), 24 * 36e5);
purgeTimer.unref();
var router = registerRoutes(db);
var server = createServer((req, res) => {
  void handle(req, res);
});
async function handle(req, res) {
  const startedAt = Date.now();
  const requestId = newRequestId();
  const url = new URL(req.url ?? "/", "http://localhost");
  const method = (req.method ?? "GET").toUpperCase();
  let status = 500;
  let code;
  try {
    const matched = router.match(method, url.pathname);
    if (!matched) throw errors.notFound("\u63A5\u53E3\u4E0D\u5B58\u5728");
    const token = bearerToken(req);
    let account = null;
    if (matched.route.auth) {
      if (!token) throw errors.sessionExpired();
      account = resolveSession(db, token);
      if (!account) throw errors.sessionExpired();
    }
    const body = method === "POST" || method === "PATCH" || method === "PUT" ? await readJsonBody(req, CONFIG.maxBodyBytes) : {};
    const ctx = {
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
      remoteIp: clientIp(req)
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
      status = 500;
      code = "INTERNAL_ERROR";
      sendError(res, new ApiError(500, "INTERNAL_ERROR", "\u670D\u52A1\u5668\u5185\u90E8\u9519\u8BEF\uFF0C\u8BF7\u7A0D\u540E\u91CD\u8BD5", { retryable: true }), requestId);
      process3.stderr.write(
        `${JSON.stringify({
          at: (/* @__PURE__ */ new Date()).toISOString(),
          level: "error",
          requestId,
          msg: err instanceof Error ? err.message : String(err),
          stack: err instanceof Error ? err.stack : void 0
        })}
`
      );
    }
  } finally {
    logAccess({ requestId, method, path: url.pathname, status, ms: Date.now() - startedAt, ...code ? { code } : {} });
  }
}
server.listen(CONFIG.port, CONFIG.host, () => {
  process3.stdout.write(
    `${JSON.stringify({
      at: (/* @__PURE__ */ new Date()).toISOString(),
      level: "info",
      msg: "API \u5DF2\u542F\u52A8",
      version: SERVER_VERSION,
      host: CONFIG.host,
      port: CONFIG.port,
      db: CONFIG.dbPath,
      node: process3.version
    })}
`
  );
});
function shutdown(signal) {
  process3.stdout.write(`${JSON.stringify({ at: (/* @__PURE__ */ new Date()).toISOString(), level: "info", msg: "\u6536\u5230\u9000\u51FA\u4FE1\u53F7", signal })}
`);
  server.close(() => {
    try {
      db.close();
    } catch {
    }
    process3.exit(0);
  });
  setTimeout(() => process3.exit(0), 1e4).unref();
}
process3.on("SIGTERM", () => shutdown("SIGTERM"));
process3.on("SIGINT", () => shutdown("SIGINT"));
