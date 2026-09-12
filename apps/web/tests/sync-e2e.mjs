/**
 * 前端同步链路端到端验证。
 *
 * 用真实的 repo.ts / engine.ts / client.ts（由 esbuild 打包为 .build/harness.mjs），
 * 配一个最小 IndexedDB 替身，直连本地运行的同步后端。
 * 覆盖：登录 → 本机写入入队 → 推送 → 服务端可见 → 幂等 → 版本冲突挂起与两种解决 →
 *       删除墓碑 → 全量对账 → 退出登录保留数据 → 重新登录续传。
 *
 * 前置：后端已在 GMS_API_BASE（默认 http://127.0.0.1:8100）运行，
 *       且已存在账号 GMS_E2E_USER / GMS_E2E_PASSWORD。
 */

const API_BASE = process.env['GMS_API_BASE'] ?? 'http://127.0.0.1:8100';
const USER = process.env['GMS_E2E_USER'] ?? 'e2e';
const PASSWORD = process.env['GMS_E2E_PASSWORD'] ?? 'e2e-pass-12345';

// ---- 浏览器环境替身（必须在导入业务模块之前装好） ----
const { createFakeIndexedDB } = await import('./fake-idb.mjs');

globalThis.indexedDB = createFakeIndexedDB();
const noop = () => {};
globalThis.window = {
  setInterval: () => 0,
  clearInterval: noop,
  addEventListener: noop,
  removeEventListener: noop,
  setTimeout: (fn, ms) => setTimeout(fn, ms),
  scrollTo: noop,
  confirm: () => true,
};
globalThis.document = { hidden: false, addEventListener: noop, removeEventListener: noop };

// client.ts 用相对路径 /api/v1 请求，Node 里没有 origin，这里补上
const realFetch = globalThis.fetch;
globalThis.fetch = (input, init) => {
  const url = typeof input === 'string' && input.startsWith('/') ? API_BASE + input : input;
  return realFetch(url, init);
};

const H = await import('./.build/harness.mjs');

// ---- 断言工具 ----
let passed = 0;
const failures = [];
function check(name, ok, detail) {
  if (ok) {
    passed += 1;
    process.stdout.write(`  ok   ${name}\n`);
  } else {
    failures.push(name);
    process.stdout.write(`  FAIL ${name}${detail === undefined ? '' : ` ${JSON.stringify(detail)}`}\n`);
  }
}

const nowIso = () => new Date().toISOString();
const recordId = () => crypto.randomUUID();

function makeGlucose(id, accountId, periodKey, slot, value, version) {
  return {
    id,
    accountId,
    kind: 'glucose',
    periodKey,
    slot,
    occurredAt: `${periodKey}T07:00:00.000Z`,
    timePrecision: 'minute',
    timezone: 'Asia/Shanghai',
    payload: { kind: 'glucose', value, unit: 'mmol/L' },
    version,
    createdAt: nowIso(),
    updatedAt: nowIso(),
    deletedAt: null,
  };
}

async function expectApiError(fn, code) {
  try {
    await fn();
    return null;
  } catch (err) {
    return err.code === code || err.status ? err : null;
  }
}

// ---- 场景 ----
const DAY_1 = '2026-03-01';
const DAY_2 = '2026-03-02';

process.stdout.write('\n[1] 未登录状态下初始化\n');
await H.sync.init();
check('初始为未登录', H.sync.status().signedIn === false, H.sync.status());
check('待同步队列为空', (await H.listOutbox()).length === 0);

process.stdout.write('\n[2] 登录云端\n');
await H.sync.login(USER, PASSWORD);
const status = H.sync.status();
check('登录成功', status.signedIn === true, status);
check('拿到账户 id', typeof status.accountId === 'string' && status.accountId.length > 0, status.accountId);
const accountId = status.accountId;

process.stdout.write('\n[3] 本机写入 + 入队 + 推送\n');
const recA = makeGlucose(recordId(), accountId, DAY_1, 'fasting', '6.2', 1);
await H.saveRecordAndClearDraft(recA, 'draft-key-1', await H.planSaveMutation(recA, false));
check('记录已落本机', (await H.listAllRecords()).some((r) => r.id === recA.id));
check('写入时同时入队', (await H.listOutbox()).length === 1);
await H.sync.syncNow();
check('推送后队列清空', (await H.listOutbox()).length === 0, await H.listOutbox());
const remoteA = await H.api.getRecord(recA.id);
check('服务端已存在该记录', remoteA.record.id === recA.id, remoteA.record?.id);
check('服务端版本由服务端判定为 1', remoteA.record.version === 1, remoteA.record.version);
check('服务端按会话归属账户', remoteA.record.accountId === accountId);
check('同步游标已推进', Number(await H.getMeta(H.META_KEYS.cursor)) > 0, await H.getMeta(H.META_KEYS.cursor));
const localA = (await H.listAllRecords()).find((r) => r.id === recA.id);
check('本机版本回写为服务端版本', localA.version === 1, localA.version);

process.stdout.write('\n[4] 修改后推送（正常路径）\n');
const recA2 = { ...localA, payload: { kind: 'glucose', value: '5.8', unit: 'mmol/L' }, version: localA.version + 1, updatedAt: nowIso() };
await H.saveRecordAndClearDraft(recA2, null, await H.planSaveMutation(recA2, true));
await H.sync.syncNow();
const remoteA2 = await H.api.getRecord(recA.id);
check('服务端版本递增到 2', remoteA2.record.version === 2, remoteA2.record.version);
check('服务端保存了新数值', remoteA2.record.payload.value === '5.8', remoteA2.record.payload);

process.stdout.write('\n[5] 版本冲突：挂起而不自动覆盖\n');
// 模拟“另一台设备先改了这条记录”
const otherDevice = await H.api.mutate({
  mutationId: recordId(),
  recordId: recA.id,
  action: 'update',
  expectedVersion: 2,
  record: {
    kind: 'glucose',
    periodKey: DAY_1,
    slot: 'fasting',
    occurredAt: `${DAY_1}T07:00:00.000Z`,
    timePrecision: 'minute',
    timezone: 'Asia/Shanghai',
    payload: { kind: 'glucose', value: '7.1', unit: 'mmol/L' },
  },
});
check('另一台设备改成功（版本 3）', otherDevice.record.version === 3, otherDevice.record.version);

const stale = (await H.listAllRecords()).find((r) => r.id === recA.id);
const recA3 = { ...stale, payload: { kind: 'glucose', value: '5.1', unit: 'mmol/L' }, version: stale.version + 1, updatedAt: nowIso() };
await H.saveRecordAndClearDraft(recA3, null, await H.planSaveMutation(recA3, true));
await H.sync.syncNow();
const problems = await H.sync.listProblemEntries();
const conflictEntry = problems.find((e) => e.recordId === recA.id);
check('冲突被挂起而非自动覆盖', conflictEntry?.conflict === true, conflictEntry);
check('服务端仍是别的设备那一版', (await H.api.getRecord(recA.id)).record.payload.value === '7.1');
check('本机仍保留自己那一版', (await H.listAllRecords()).find((r) => r.id === recA.id).payload.value === '5.1');

process.stdout.write('\n[6] 冲突解决：以本机为准\n');
await H.sync.resolveTakeLocal(recA.id);
const afterTakeLocal = await H.api.getRecord(recA.id);
check('本机版本被提交到服务端', afterTakeLocal.record.payload.value === '5.1', afterTakeLocal.record.payload);
check('冲突条目已清除', (await H.sync.listProblemEntries()).filter((e) => e.recordId === recA.id).length === 0);
check('本机版本与服务端一致', (await H.listAllRecords()).find((r) => r.id === recA.id).version === afterTakeLocal.record.version);

process.stdout.write('\n[7] 冲突解决：以云端为准\n');
// 再制造一次冲突
const other2 = await H.api.mutate({
  mutationId: recordId(),
  recordId: recA.id,
  action: 'update',
  expectedVersion: afterTakeLocal.record.version,
  record: {
    kind: 'glucose',
    periodKey: DAY_1,
    slot: 'fasting',
    occurredAt: `${DAY_1}T07:00:00.000Z`,
    timePrecision: 'minute',
    timezone: 'Asia/Shanghai',
    payload: { kind: 'glucose', value: '8.3', unit: 'mmol/L' },
  },
});
const staleB = (await H.listAllRecords()).find((r) => r.id === recA.id);
const recA4 = { ...staleB, payload: { kind: 'glucose', value: '4.9', unit: 'mmol/L' }, version: staleB.version + 1, updatedAt: nowIso() };
await H.saveRecordAndClearDraft(recA4, null, await H.planSaveMutation(recA4, true));
await H.sync.syncNow();
check('第二次冲突同样被挂起', (await H.sync.listProblemEntries()).some((e) => e.recordId === recA.id && e.conflict));
await H.sync.resolveTakeRemote(recA.id);
const finalRemote = await H.api.getRecord(recA.id);
check('服务端保持云端版本', finalRemote.record.payload.value === '8.3', finalRemote.record.payload.value);
check('本机被云端版本覆盖', (await H.listAllRecords()).find((r) => r.id === recA.id).payload.value === '8.3');
check('本机版本对齐服务端', (await H.listAllRecords()).find((r) => r.id === recA.id).version === other2.record.version);

process.stdout.write('\n[8] 幂等：同一 mutationId 重复提交\n');
const recB = makeGlucose(recordId(), accountId, DAY_2, 'fasting', '6.6', 1);
const mutationB = await H.planSaveMutation(recB, false);
const firstB = await H.api.mutate({ ...mutationB, record: mutationB.record });
const secondB = await H.api.mutate({ ...mutationB, record: mutationB.record });
check('重复提交返回同一版本', firstB.record.version === secondB.record.version, [firstB.record.version, secondB.record.version]);
check('重复提交不产生新变更流水', firstB.commitSeq === secondB.commitSeq, [firstB.commitSeq, secondB.commitSeq]);

process.stdout.write('\n[9] 删除产生墓碑并可从增量看到\n');
const recBDeleted = { ...recB, deletedAt: nowIso(), version: 2, updatedAt: nowIso() };
await H.saveRecordAndClearDraft(recBDeleted, null, await H.planDeleteMutation(firstB.record));
await H.sync.syncNow();
// 从 0 起读全量流水再筛出这条记录，避免依赖游标恰好停在哪一格
const changes = await H.api.changes(0);
const bChanges = changes.changes.filter((c) => c.recordId === recB.id);
const deleteChange = bChanges.find((c) => c.action === 'delete');
check('增量流水中出现该记录的删除', deleteChange !== undefined, bChanges.map((c) => c.action));
check('删除动作携带墓碑（含删除时间与递增版本）',
  deleteChange?.record?.deletedAt !== null && deleteChange?.record?.version === 2,
  deleteChange?.record);
// 另一台尚未见过这条删除的设备，从任意早期游标拉增量都应取到墓碑（而不是空手而归）
const freshPull = await H.api.changes(0);
const freshTombstone = freshPull.changes.find((c) => c.recordId === recB.id && c.action === 'delete');
check('未见过该删除的设备能从增量流水取到墓碑',
  freshTombstone !== undefined && freshTombstone.record !== null,
  freshPull.changes.filter((c) => c.recordId === recB.id).map((c) => c.action));
const stillThere = await H.api.getRecord(recB.id);
check('服务端记录已标记删除', stillThere.record.deletedAt !== null, stillThere.record.deletedAt);
check('删除动作使版本递增到 2', stillThere.record.version === 2, stillThere.record.version);

process.stdout.write('\n[9b] 恢复：取消删除\n');
// 版本基准取改写前的记录（此时它已是服务端确认过的 version 2）
const recBRestored = { ...stillThere.record, deletedAt: null, version: 3, updatedAt: nowIso() };
await H.saveRecordAndClearDraft(recBRestored, null, await H.planRestoreMutation(stillThere.record));
await H.sync.syncNow();
const restoredRemote = await H.api.getRecord(recB.id);
check('恢复后服务端不再标记删除', restoredRemote.record.deletedAt === null, restoredRemote.record.deletedAt);
check('恢复后版本递增到 3', restoredRemote.record.version === 3, restoredRemote.record.version);
check('恢复的队列条目已清空', (await H.listOutbox()).length === 0, await H.listOutbox());

const liveCount = 2; // recA + recB

process.stdout.write('\n[10] 全量对账：本机多余记录被清理\n');
const ghost = makeGlucose(recordId(), accountId, '2026-03-05', 'fasting', '9.9', 1);
await H.saveRecordAndClearDraft(ghost, null); // 只在本机、不入队，模拟脏数据
check('脏数据已写入本机', (await H.listAllRecords()).some((r) => r.id === ghost.id));
await H.sync.fullResync();
check('对账后脏数据被清理', !(await H.listAllRecords()).some((r) => r.id === ghost.id));
check('对账后本机记录与云端一致', (await H.listAllRecords()).length === liveCount, (await H.listAllRecords()).length);

process.stdout.write('\n[11] 退出登录：保留本机数据，令牌失效\n');
await H.sync.logout();
check('状态回到未登录', H.sync.status().signedIn === false, H.sync.status());
check('本机记录未被删除', (await H.listAllRecords()).length === liveCount, (await H.listAllRecords()).length);
check('令牌与游标已清除', (await H.getMeta(H.META_KEYS.token)) === null && (await H.getMeta(H.META_KEYS.cursor)) === null);
check('客户端已丢弃令牌', H.api.hasToken() === false);

process.stdout.write('\n[12] 重新登录：退出期间的改动会被续传\n');
// 未登录时改一条（记录已归属云端账户 → 应当入队，登录后自动上传）
const offlineBase = (await H.listAllRecords()).find((r) => r.id === recA.id);
const offlineEdit = { ...offlineBase, payload: { kind: 'glucose', value: '5.5', unit: 'mmol/L' }, version: offlineBase.version + 1, updatedAt: nowIso() };
await H.saveRecordAndClearDraft(offlineEdit, null, await H.planSaveMutation(offlineEdit, true));
check('退出期间的改动已入队', (await H.listOutbox()).length === 1, await H.listOutbox());
await H.sync.login(USER, PASSWORD);
check('重新登录后队列已清空', (await H.listOutbox()).length === 0, await H.listOutbox());
check('退出期间的改动已上传', (await H.api.getRecord(recA.id)).record.payload.value === '5.5');

process.stdout.write('\n[13] 越权：令牌失效后的行为\n');
await H.api.logout().catch(() => undefined);
const expired = await expectApiError(() => H.api.getRecord(recA.id), 'SESSION_EXPIRED');
check('旧令牌访问被拒', expired !== null);

process.stdout.write(`\n===== 结果：通过 ${passed} 项，失败 ${failures.length} 项 =====\n`);
if (failures.length > 0) {
  process.stdout.write(`失败项：${failures.join(' / ')}\n`);
  process.exitCode = 1;
} else {
  process.stdout.write('全部通过\n');
}
