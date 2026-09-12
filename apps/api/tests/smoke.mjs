/**
 * 端到端冒烟测试：启动真实服务，用真实 HTTP 请求验证契约。
 * 运行：node tests/smoke.mjs
 *
 * 覆盖：健康检查、登录、幂等重放、版本冲突、唯一槽位、字段校验、
 * 删除墓碑、增量游标、快照分页、修订历史、账户配置、跨账户越权隔离。
 */
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomBytes, randomUUID, scryptSync } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';

const here = dirname(fileURLToPath(import.meta.url));
const PORT = 8199;
const workDir = mkdtempSync(join(tmpdir(), 'gms-smoke-'));
const DB = join(workDir, 'test.sqlite');
const BASE = `http://127.0.0.1:${PORT}`;
const USER = 'smoke-user';
const PASS = 'smoke-password-123';
const NEW_PASS = 'smoke-password-456';

let passed = 0;
const failures = [];

function check(name, condition, detail) {
  if (condition) {
    passed += 1;
    console.log(`  ok   ${name}`);
  } else {
    failures.push({ name, detail });
    console.log(`  FAIL ${name}${detail === undefined ? '' : ` -> ${JSON.stringify(detail)}`}`);
  }
}

const server = spawn(process.execPath, [join(here, '..', 'dist', 'server.mjs')], {
  env: {
    ...process.env,
    GMS_API_PORT: String(PORT),
    GMS_DB_PATH: DB,
    GMS_ADMIN_USER: USER,
    GMS_ADMIN_PASSWORD: PASS,
    GMS_API_HOST: '127.0.0.1',
  },
  stdio: ['ignore', 'pipe', 'pipe'],
});
server.stdout.on('data', (d) => process.stdout.write(`[api] ${d}`));
server.stderr.on('data', (d) => process.stderr.write(`[api:err] ${d}`));

async function waitForHealth() {
  for (let i = 0; i < 100; i += 1) {
    try {
      const res = await fetch(`${BASE}/healthz`);
      if (res.ok) return true;
    } catch {
      /* 还没起来 */
    }
    await new Promise((r) => setTimeout(r, 100));
  }
  return false;
}

async function call(method, path, { token, body } = {}) {
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: {
      ...(body ? { 'Content-Type': 'application/json' } : {}),
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  const text = await res.text();
  let json = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    json = text;
  }
  return { status: res.status, json };
}

function glucoseRecord(periodKey, value, slot = 'fasting') {
  return {
    kind: 'glucose',
    periodKey,
    slot,
    occurredAt: `${periodKey}T07:30`,
    timezone: 'Asia/Shanghai',
    payload: { kind: 'glucose', value, unit: 'mmol/L' },
  };
}

function insertSecondAccount(db, username, password) {
  const salt = randomBytes(16);
  const hash = scryptSync(password, salt, 64);
  const stored = `scrypt$${salt.toString('hex')}$${hash.toString('hex')}`;
  const now = new Date().toISOString();
  const id = randomUUID();
  db.prepare('INSERT INTO accounts (id, username, password_hash, status, created_at) VALUES (?, ?, ?, ?, ?)').run(
    id,
    username,
    stored,
    'active',
    now,
  );
  db.prepare(
    'INSERT INTO profile_settings (account_id, glucose_unit, weight_unit, water_unit, timezone, version, updated_at) VALUES (?, ?, ?, ?, ?, 1, ?)',
  ).run(id, 'mmol/L', 'kg', 'mL', 'Asia/Shanghai', now);
  db.prepare('INSERT INTO account_sync_state (account_id, last_seq) VALUES (?, 0)').run(id);
  return id;
}

async function main() {
  const healthy = await waitForHealth();
  if (!healthy) {
    console.error('服务未能在 10 秒内就绪，中止');
    server.kill('SIGKILL');
    process.exit(1);
  }

  console.log('\n[1] 健康检查与鉴权');
  {
    const health = await call('GET', '/healthz');
    check('GET /healthz 返回 200', health.status === 200, health);
    const noToken = await call('GET', '/api/v1/profile');
    check('未带令牌访问 /profile 返回 401 SESSION_EXPIRED', noToken.status === 401 && noToken.json?.code === 'SESSION_EXPIRED', noToken);
    const badToken = await call('GET', '/api/v1/profile', { token: 'not-a-real-token' });
    check('伪造令牌返回 401', badToken.status === 401, badToken);
    const badLogin = await call('POST', '/api/v1/auth/login', { body: { username: USER, password: 'wrong' } });
    check('错误口令返回 401 INVALID_CREDENTIALS', badLogin.status === 401 && badLogin.json?.code === 'INVALID_CREDENTIALS', badLogin);
    const unknownUser = await call('POST', '/api/v1/auth/login', { body: { username: 'nobody', password: 'whatever' } });
    check('不存在用户同样返回 401（不泄露账户存在性）', unknownUser.status === 401, unknownUser);
  }

  console.log('\n[2] 登录');
  const login = await call('POST', '/api/v1/auth/login', { body: { username: USER, password: PASS } });
  check('正确口令登录成功', login.status === 200 && typeof login.json?.token === 'string', login.json);
  const token = login.json?.token;
  const accountId = login.json?.account?.id;
  check('返回账户 id', typeof accountId === 'string' && accountId.length > 0, login.json);

  const me = await call('GET', '/api/v1/auth/me', { token });
  check('GET /auth/me 返回当前账户', me.status === 200 && me.json?.account?.username === USER, me.json);

  console.log('\n[3] 创建记录与幂等');
  const recId = randomUUID();
  const mutationId = randomUUID();
  const createBody = {
    mutationId,
    recordId: recId,
    action: 'create',
    expectedVersion: 0,
    record: glucoseRecord('2026-09-10', '6.1'),
  };
  const created = await call('POST', '/api/v1/mutations', { token, body: createBody });
  check('创建血糖记录成功', created.status === 200 && created.json?.version === 1, created.json);
  check('返回提交游标 commitSeq = 1', created.json?.commitSeq === 1, created.json);
  check('服务端回写 accountId', created.json?.record?.accountId === accountId, created.json?.record);

  const replay = await call('POST', '/api/v1/mutations', { token, body: createBody });
  check('相同幂等键重放返回 200 且版本不变', replay.status === 200 && replay.json?.version === 1, replay.json);
  check('重放返回相同 commitSeq', replay.json?.commitSeq === created.json?.commitSeq, replay.json);

  const reused = await call('POST', '/api/v1/mutations', {
    token,
    body: { ...createBody, record: glucoseRecord('2026-09-10', '9.9') },
  });
  check('同一幂等键换内容返回 422', reused.status === 422 && reused.json?.code === 'VALIDATION_FAILED', reused.json);

  const dupId = await call('POST', '/api/v1/mutations', {
    token,
    body: { ...createBody, mutationId: randomUUID() },
  });
  check('新幂等键复用已存在 recordId 返回 409', dupId.status === 409, dupId.json);

  console.log('\n[4] 字段校验（服务端与前端同规则）');
  {
    const bad = await call('POST', '/api/v1/mutations', {
      token,
      body: {
        mutationId: randomUUID(),
        recordId: randomUUID(),
        action: 'create',
        expectedVersion: 0,
        record: glucoseRecord('2026-09-11', 'abc'),
      },
    });
    check('非法数值返回 422 且定位字段', bad.status === 422 && Array.isArray(bad.json?.fieldErrors) && bad.json.fieldErrors.some((e) => e.field === 'value'), bad.json);

    const zero = await call('POST', '/api/v1/mutations', {
      token,
      body: {
        mutationId: randomUUID(),
        recordId: randomUUID(),
        action: 'create',
        expectedVersion: 0,
        record: glucoseRecord('2026-09-11', '0'),
      },
    });
    check('血糖为 0 被拒（要求大于 0）', zero.status === 422, zero.json);

    const future = await call('POST', '/api/v1/mutations', {
      token,
      body: {
        mutationId: randomUUID(),
        recordId: randomUUID(),
        action: 'create',
        expectedVersion: 0,
        record: glucoseRecord('2026-13-45', '6.1'),
      },
    });
    check('非法日期返回 422', future.status === 422, future.json);

    const extra = await call('POST', '/api/v1/mutations', {
      token,
      body: {
        mutationId: randomUUID(),
        recordId: randomUUID(),
        action: 'create',
        expectedVersion: 0,
        record: {
          ...glucoseRecord('2026-09-11', '6.1'),
          payload: { kind: 'glucose', value: '6.1', unit: 'mmol/L', smuggled: 'x' },
        },
      },
    });
    check('payload 夹带未定义字段被拒', extra.status === 422, extra.json);

    const badSlot = await call('POST', '/api/v1/mutations', {
      token,
      body: {
        mutationId: randomUUID(),
        recordId: randomUUID(),
        action: 'create',
        expectedVersion: 0,
        record: glucoseRecord('2026-09-11', '6.1', 'lunch_2h_typo'),
      },
    });
    check('非法时点返回 422', badSlot.status === 422, badSlot.json);
  }

  console.log('\n[5] 唯一槽位（饮食每餐）');
  {
    const meal = (text) => ({
      kind: 'meal',
      periodKey: '2026-09-12',
      slot: 'breakfast',
      timezone: 'Asia/Shanghai',
      payload: { kind: 'meal', text },
    });
    const first = await call('POST', '/api/v1/mutations', {
      token,
      body: { mutationId: randomUUID(), recordId: randomUUID(), action: 'create', expectedVersion: 0, record: meal('牛奶鸡蛋') },
    });
    check('创建早餐成功', first.status === 200, first.json);
    const second = await call('POST', '/api/v1/mutations', {
      token,
      body: { mutationId: randomUUID(), recordId: randomUUID(), action: 'create', expectedVersion: 0, record: meal('包子') },
    });
    check('同日同餐重复创建返回 409 SLOT_EXISTS', second.status === 409 && second.json?.code === 'SLOT_EXISTS', second.json);
  }

  console.log('\n[6] 版本冲突');
  {
    const conflict = await call('POST', '/api/v1/mutations', {
      token,
      body: {
        mutationId: randomUUID(),
        recordId: recId,
        action: 'update',
        expectedVersion: 99,
        record: glucoseRecord('2026-09-10', '7.2'),
      },
    });
    check('过期 expectedVersion 返回 409 VERSION_CONFLICT', conflict.status === 409 && conflict.json?.code === 'VERSION_CONFLICT', conflict.json);

    const ok = await call('POST', '/api/v1/mutations', {
      token,
      body: {
        mutationId: randomUUID(),
        recordId: recId,
        action: 'update',
        expectedVersion: 1,
        record: glucoseRecord('2026-09-10', '7.2'),
      },
    });
    check('正确 expectedVersion 更新成功且版本 +1', ok.status === 200 && ok.json?.version === 2, ok.json);
  }

  console.log('\n[7] 删除墓碑与恢复');
  {
    const del = await call('POST', '/api/v1/mutations', {
      token,
      body: { mutationId: randomUUID(), recordId: recId, action: 'delete', expectedVersion: 2 },
    });
    check('删除成功并写入 deletedAt', del.status === 200 && typeof del.json?.record?.deletedAt === 'string', del.json);

    const restore = await call('POST', '/api/v1/mutations', {
      token,
      body: { mutationId: randomUUID(), recordId: recId, action: 'restore', expectedVersion: 3 },
    });
    check('恢复成功且 deletedAt 清空', restore.status === 200 && restore.json?.record?.deletedAt === null, restore.json);
  }

  console.log('\n[8] 增量变更流水');
  const changesAll = await call('GET', '/api/v1/changes?cursor=0', { token });
  // 成功提交 5 次：建血糖、建早餐、改血糖、删血糖、恢复血糖
  check('游标 0 拉到全部变更（5 条成功提交）', changesAll.status === 200 && changesAll.json?.changes?.length === 5, changesAll.json?.changes?.map((c) => c.seq));
  check('变更按 seq 升序且连续', (() => {
    const seqs = (changesAll.json?.changes ?? []).map((c) => c.seq);
    return seqs.every((s, i) => i === 0 || s === seqs[i - 1] + 1);
  })(), changesAll.json?.changes?.map((c) => c.seq));
  check('按提交版本关联快照而非最新版本', (() => {
    const first = changesAll.json?.changes?.find((c) => c.recordId === recId && c.version === 1);
    return first?.record?.payload?.value === '6.1';
  })(), changesAll.json?.changes?.filter((c) => c.recordId === recId));
  check('包含删除与恢复动作', (() => {
    const actions = (changesAll.json?.changes ?? []).filter((c) => c.recordId === recId).map((c) => c.action);
    return actions.includes('delete') && actions.includes('restore');
  })());

  {
    const next = changesAll.json?.nextCursor;
    const tail = await call('GET', `/api/v1/changes?cursor=${next}`, { token });
    check('用 nextCursor 拉取无新变更', tail.status === 200 && tail.json?.changes?.length === 0, tail.json);
    const badCursor = await call('GET', '/api/v1/changes?cursor=abc', { token });
    check('非法游标返回 422', badCursor.status === 422, badCursor.json);
  }

  console.log('\n[9] 全量快照与分页');
  {
    // 当前账户共 2 条记录，用 limit=1 才能验证跨页锚定
    const snap = await call('GET', '/api/v1/snapshot?limit=1', { token });
    check('快照返回记录与 syncCursor', snap.status === 200 && Array.isArray(snap.json?.records) && typeof snap.json?.syncCursor === 'number', snap.json);
    check('快照分页 hasMore 与令牌齐全', snap.json?.hasMore === true && typeof snap.json?.nextPageToken === 'string', snap.json);
    if (typeof snap.json?.nextPageToken === 'string') {
      const page2 = await call('GET', `/api/v1/snapshot?limit=1&cursor=${encodeURIComponent(snap.json.nextPageToken)}`, { token });
      check('第二页可用且锚定同一 snapshotSeq', page2.json?.snapshotSeq === snap.json?.snapshotSeq && page2.json?.records?.length === 1, page2.json);
      check('两页记录不重复', page2.json?.records?.[0]?.id !== snap.json?.records?.[0]?.id, {
        p1: snap.json?.records?.[0]?.id,
        p2: page2.json?.records?.[0]?.id,
      });
      const tampered = await call('GET', `/api/v1/snapshot?limit=1&cursor=${encodeURIComponent(snap.json.nextPageToken.slice(0, -4) + 'aaaa')}`, { token });
      check('篡改分页令牌返回 422', tampered.status === 422, tampered.json);
    }
    const filtered = await call('GET', '/api/v1/snapshot?from=2026-09-12&to=2026-09-12', { token });
    check('快照支持日期范围过滤', filtered.status === 200 && filtered.json?.records?.every((r) => r.periodKey === '2026-09-12'), filtered.json?.records?.map((r) => r.periodKey));
  }

  console.log('\n[10] 修订历史与账户配置');
  {
    const revs = await call('GET', `/api/v1/records/${recId}/revisions`, { token });
    check('修订历史返回多个版本且倒序', revs.status === 200 && revs.json?.revisions?.length === 4 && revs.json.revisions[0].version === 4, revs.json?.revisions?.map((r) => r.version));

    const profile = await call('GET', '/api/v1/profile', { token });
    check('读取账户配置', profile.status === 200 && profile.json?.glucoseUnit === 'mmol/L', profile.json);

    const patchBad = await call('PATCH', '/api/v1/profile', { token, body: { expectedVersion: 99, glucoseUnit: 'mg/dL' } });
    check('配置版本冲突返回 409', patchBad.status === 409, patchBad.json);

    const patchOk = await call('PATCH', '/api/v1/profile', {
      token,
      body: { expectedVersion: profile.json?.version, glucoseUnit: 'mg/dL' },
    });
    check('配置更新成功且版本 +1', patchOk.status === 200 && patchOk.json?.version === profile.json?.version + 1, patchOk.json);
  }

  console.log('\n[11] 跨账户越权隔离');
  {
    const db = new DatabaseSync(DB);
    const otherId = insertSecondAccount(db, 'other-user', 'other-password-123');
    db.close();
    check('已插入第二个账户', otherId !== accountId);

    const otherLogin = await call('POST', '/api/v1/auth/login', { body: { username: 'other-user', password: 'other-password-123' } });
    check('第二账户登录成功', otherLogin.status === 200, otherLogin.json);
    const otherToken = otherLogin.json?.token;

    const steal = await call('GET', `/api/v1/records/${recId}/revisions`, { token: otherToken });
    check('第二账户读取他人记录修订返回 404', steal.status === 404, steal.json);

    const otherChanges = await call('GET', '/api/v1/changes?cursor=0', { token: otherToken });
    check('第二账户变更流水为空（未串数据）', otherChanges.status === 200 && otherChanges.json?.changes?.length === 0, otherChanges.json);

    const otherSnap = await call('GET', '/api/v1/snapshot', { token: otherToken });
    check('第二账户快照不包含他人记录', otherSnap.status === 200 && otherSnap.json?.records?.length === 0, otherSnap.json);

    const otherDelete = await call('POST', '/api/v1/mutations', {
      token: otherToken,
      body: { mutationId: randomUUID(), recordId: recId, action: 'delete', expectedVersion: 4 },
    });
    check('第二账户删除他人记录返回 404', otherDelete.status === 404, otherDelete.json);

    const spoof = await call('POST', '/api/v1/mutations', {
      token: otherToken,
      body: {
        mutationId: randomUUID(),
        recordId: randomUUID(),
        action: 'create',
        expectedVersion: 0,
        accountId,
        record: glucoseRecord('2026-09-13', '5.5'),
      },
    });
    check('请求体伪造 accountId 被忽略（记录归属仍为第二账户）', spoof.status === 200 && spoof.json?.record?.accountId === otherId, spoof.json?.record);
  }

  console.log('\n[12] 登出');
  {
    const logout = await call('POST', '/api/v1/auth/logout', { token });
    check('登出返回 200', logout.status === 200, logout.json);
    const after = await call('GET', '/api/v1/auth/me', { token });
    check('登出后旧令牌失效', after.status === 401, after.json);
  }

  // 放在最后：改密会作废该账户全部会话并改掉口令，会影响后续用例
  console.log('\n[13] 修改密码');
  {
    const fresh = await call('POST', '/api/v1/auth/login', { body: { username: USER, password: PASS } });
    const pwToken = fresh.json?.token;
    check('改密前重新登录成功', typeof pwToken === 'string', fresh.json);

    const tooShort = await call('POST', '/api/v1/auth/password', {
      token: pwToken,
      body: { oldPassword: PASS, newPassword: 'short' },
    });
    check('新密码过短返回 422', tooShort.status === 422, tooShort.json);

    const wrongOld = await call('POST', '/api/v1/auth/password', {
      token: pwToken,
      body: { oldPassword: 'not-the-real-password', newPassword: NEW_PASS },
    });
    check(
      '原密码不正确返回 422 且定位到 oldPassword 字段',
      wrongOld.status === 422 && wrongOld.json?.fieldErrors?.[0]?.field === 'oldPassword',
      wrongOld.json,
    );

    const changed = await call('POST', '/api/v1/auth/password', {
      token: pwToken,
      body: { oldPassword: PASS, newPassword: NEW_PASS },
    });
    check('修改成功并要求重新登录', changed.status === 200 && changed.json?.reauthRequired === true, changed.json);

    const revoked = await call('GET', '/api/v1/auth/me', { token: pwToken });
    check('改密后旧令牌立即失效', revoked.status === 401, revoked.json);

    const oldLogin = await call('POST', '/api/v1/auth/login', { body: { username: USER, password: PASS } });
    check('旧密码不能再登录', oldLogin.status === 401, oldLogin.json);

    const newLogin = await call('POST', '/api/v1/auth/login', { body: { username: USER, password: NEW_PASS } });
    check('新密码可以登录', newLogin.status === 200 && typeof newLogin.json?.token === 'string', newLogin.json);
  }
}

try {
  await main();
} catch (err) {
  console.error('\n测试执行异常：', err);
  failures.push({ name: '测试脚本异常', detail: String(err) });
} finally {
  server.kill('SIGKILL');
  await new Promise((r) => setTimeout(r, 200));
  rmSync(workDir, { recursive: true, force: true });
}

console.log(`\n===== 结果：通过 ${passed} 项，失败 ${failures.length} 项 =====`);
if (failures.length > 0) {
  for (const f of failures) console.log(`  失败：${f.name} -> ${JSON.stringify(f.detail)}`);
  process.exit(1);
}
console.log('全部通过');
