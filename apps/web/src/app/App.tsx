import { useCallback, useEffect, useRef, useState } from 'react';
import type { FieldError, LocalRecord, RecordKind } from '@gms/contracts';
import { isFutureDate, monthKeyOf, todayKey, validateForm } from '@gms/domain';
import {
  LOCAL_ACCOUNT,
  META_KEYS,
  clearLocalCache,
  deleteOutbox,
  draftKeyFor,
  findOutboxByRecord,
  getMeta,
  listAllRecords,
  saveRecordAndClearDraft,
  setMeta,
  uuid,
  type OutboxEntry,
} from '../data/local/repo';
import {
  planDeleteMutation,
  planRestoreMutation,
  planSaveMutation,
  sync,
  type SyncStatus,
} from '../data/sync/engine';
import { buildFictionalSeed } from '../data/local/seed';
import { api } from '../data/api/client';
import { DayPage } from '../features/daily-entry/DayPage';
import { EntryForm } from '../features/daily-entry/EntryForm';
import { HistoryPage } from '../features/history/HistoryPage';
import { TrendPage } from '../features/history/TrendPage';
import { SettingsPage } from '../features/settings/SettingsPage';
import { LoginPage } from '../features/auth/LoginPage';
import { IconPen, IconHistory, IconTrend, IconSettings } from '../components/Icons';

export type Units = { glucose: string; weight: string; water: string };
export type Tab = 'fill' | 'history' | 'trend' | 'settings';
export type EditorTarget = { dateKey: string; kind: RecordKind; slot: string; entryId: string | null };

export type SaveResult = { ok: true } | { ok: false; errors?: FieldError[]; hardFail?: boolean };

const DEFAULT_UNITS: Units = { glucose: 'mmol/L', weight: 'kg', water: 'mL' };

function loadUnits(): Units {
  try {
    const raw = localStorage.getItem('gms-units');
    if (raw) return { ...DEFAULT_UNITS, ...(JSON.parse(raw) as Partial<Units>) };
  } catch {
    /* 忽略损坏配置 */
  }
  return DEFAULT_UNITS;
}

function nowIso(): string {
  return new Date().toISOString();
}

/** 顶栏的一句话状态：老人只需要知道“存上了没有” */
function headerStatusText(status: SyncStatus): string {
  if (!status.signedIn) return '仅本机 · 未连接云端';
  if (status.phase === 'syncing') return '正在同步…';
  if (status.conflicts > 0) return `有 ${status.conflicts} 条待你确认`;
  if (status.pending > 0) return `待同步 ${status.pending} 条`;
  if (status.phase === 'offline') return '当前离线 · 稍后自动重试';
  return '已同步到云端';
}

export default function App() {
  const [tab, setTab] = useState<Tab>('fill');
  const [dateKey, setDateKey] = useState(todayKey());
  const [records, setRecords] = useState<LocalRecord[] | null>(null);
  const [editor, setEditor] = useState<EditorTarget | null>(null);
  const [fontSize, setFontSize] = useState(() => localStorage.getItem('gms-fontSize') ?? '22');
  const [units, setUnits] = useState<Units>(loadUnits);
  const [toast, setToast] = useState<{ text: string; error?: boolean } | null>(null);
  const [syncStatus, setSyncStatus] = useState<SyncStatus>(sync.status());
  const [problems, setProblems] = useState<OutboxEntry[]>([]);
  /** 首次进入：null 表示尚未决定「登录云端 / 只在本机」 */
  const [askLogin, setAskLogin] = useState<boolean | null>(null);
  const scrollMemo = useRef(0);

  const refresh = useCallback(async () => {
    setRecords(await listAllRecords());
  }, []);

  const refreshProblems = useCallback(async () => {
    setProblems(await sync.listProblemEntries());
  }, []);

  // 启动：恢复会话 → 决定是否弹登录页 → 首次同步
  useEffect(() => {
    const unsubscribe = sync.subscribe(setSyncStatus);
    void (async () => {
      const decided = await getMeta(META_KEYS.localOnly);
      await sync.init();
      if (!sync.status().signedIn && decided === null) setAskLogin(true);
      else setAskLogin(false);
      await refresh();
      await refreshProblems();
    })();
    return unsubscribe;
  }, [refresh, refreshProblems]);

  // 队列条数变化后重读问题清单
  useEffect(() => {
    void refreshProblems();
  }, [syncStatus.pending, syncStatus.conflicts, syncStatus.failed, refreshProblems]);

  useEffect(() => {
    document.documentElement.style.fontSize = `${fontSize}px`;
    localStorage.setItem('gms-fontSize', fontSize);
  }, [fontSize]);

  const showToast = useCallback((text: string, error = false) => {
    setToast({ text, error });
    window.setTimeout(() => setToast(null), 2600);
  }, []);

  const openEditor = useCallback((target: EditorTarget) => {
    scrollMemo.current = window.scrollY;
    setEditor(target);
  }, []);

  const closeEditor = useCallback(() => {
    setEditor(null);
    void refresh().then(() => window.scrollTo(0, scrollMemo.current));
  }, [refresh]);

  /**
   * 保存正式记录。写入顺序遵循架构 §6：
   * 「记录版本 + 清草稿 + 待同步入队」同一事务落盘，同步交给引擎异步做。
   * 本机不成功就不提示成功。
   */
  const handleSave = useCallback(
    async (target: EditorTarget, fields: Record<string, string>, confirmAbnormalBP: boolean): Promise<SaveResult> => {
      if (target.kind !== 'month_note' && isFutureDate(target.dateKey)) {
        return { ok: false, errors: [{ field: '__form', message: '不能保存未来日期，请先修正日期' }] };
      }
      const result = validateForm(target.kind, fields, { confirmAbnormalBP });
      if (!result.ok) return { ok: false, errors: result.errors };

      const periodKey = target.kind === 'month_note' ? monthKeyOf(target.dateKey) : target.dateKey;
      const draftKey = draftKeyFor(periodKey, target.kind, target.slot, target.entryId);
      const base = target.entryId != null ? (records ?? []).find((r) => r.id === target.entryId) : undefined;
      const uniqueBase =
        !base && (target.kind === 'meal' || target.kind === 'water' || target.kind === 'day_note' || target.kind === 'month_note')
          ? (records ?? []).find(
              (r) => r.kind === target.kind && r.periodKey === periodKey && r.slot === target.slot && !r.deletedAt,
            )
          : undefined;
      const anchor = base ?? uniqueBase;
      // 服务端已知的记录：改它是 update；从未上传过的本机记录在登录时统一按新增上传
      const anchorOnServer = anchor !== undefined && anchor.accountId !== LOCAL_ACCOUNT;
      const occurredAt = result.occurredAt;
      const record: LocalRecord = anchor
        ? {
            ...anchor,
            payload: result.payload,
            occurredAt,
            timePrecision: occurredAt ? 'minute' : 'unknown',
            version: anchor.version + 1,
            updatedAt: nowIso(),
          }
        : {
            id: uuid(),
            accountId: sync.status().accountId ?? LOCAL_ACCOUNT,
            kind: target.kind,
            periodKey,
            slot: target.slot,
            occurredAt,
            timePrecision: occurredAt ? 'minute' : 'unknown',
            timezone: 'Asia/Shanghai',
            payload: result.payload,
            version: 1,
            createdAt: nowIso(),
            updatedAt: nowIso(),
            deletedAt: null,
          };

      const enqueue = sync.status().signedIn || anchorOnServer;
      const outbox = enqueue ? await planSaveMutation(record, anchorOnServer) : undefined;

      try {
        await saveRecordAndClearDraft(record, draftKey, outbox);
      } catch {
        showToast('保存失败：本机存储未完成，内容仍在表单中', true);
        return { ok: false, hardFail: true };
      }
      await refresh();
      await sync.refreshCounts();
      if (sync.status().signedIn) void sync.syncNow();
      showToast(sync.status().signedIn ? '已保存，正在同步' : '已保存到此设备');
      return { ok: true };
    },
    [records, refresh, showToast],
  );

  const handleDelete = useCallback(
    async (id: string) => {
      const all = await listAllRecords();
      const rec = all.find((r) => r.id === id);
      if (!rec) return;
      const updated: LocalRecord = { ...rec, deletedAt: nowIso(), version: rec.version + 1, updatedAt: nowIso() };
      const enqueue = sync.status().signedIn || rec.accountId !== LOCAL_ACCOUNT;
      const entry = enqueue ? await planDeleteMutation(rec) : null;
      if (entry) {
        await saveRecordAndClearDraft(updated, null, entry);
      } else {
        // 从未上传过的记录：删掉可能残留的待发新增，避免下次同步又把已删内容建回去
        const stale = await findOutboxByRecord(id);
        if (stale) await deleteOutbox(stale.mutationId);
        await saveRecordAndClearDraft(updated, null);
      }
      if (sync.status().signedIn) void sync.syncNow();
      showToast('已删除（30 天内可在日明细恢复）');
      await refresh();
      await sync.refreshCounts();
    },
    [refresh, showToast],
  );

  const handleRestore = useCallback(
    async (id: string) => {
      const all = await listAllRecords();
      const rec = all.find((r) => r.id === id);
      if (!rec) return;
      const restored: LocalRecord = { ...rec, deletedAt: null, version: rec.version + 1, updatedAt: nowIso() };
      const enqueue = sync.status().signedIn || rec.accountId !== LOCAL_ACCOUNT;
      // 版本基准取改写前的 rec（见 planDeleteMutation 的版本基准约定）
      const entry = enqueue ? await planRestoreMutation(rec) : undefined;
      await saveRecordAndClearDraft(restored, null, entry);
      if (sync.status().signedIn) void sync.syncNow();
      showToast('已恢复为新版本');
      await refresh();
      await sync.refreshCounts();
    },
    [refresh, showToast],
  );

  const seedFictional = useCallback(async () => {
    const existing = await listAllRecords();
    if (existing.length > 0 && !window.confirm('本地已有数据，虚构示例将一并加入，确定继续？')) return;
    const seeds = buildFictionalSeed();
    const owner = sync.status().accountId ?? LOCAL_ACCOUNT;
    for (const s of seeds) {
      const record: LocalRecord = { ...s, accountId: owner };
      const outbox = sync.status().signedIn ? await planSaveMutation(record, false) : undefined;
      await saveRecordAndClearDraft(record, null, outbox);
    }
    if (sync.status().signedIn) void sync.syncNow();
    await refresh();
    await sync.refreshCounts();
    showToast('已载入虚构示例数据（仅用于评审）');
  }, [refresh, showToast]);

  const clearLocal = useCallback(async () => {
    if (!window.confirm('将删除本机缓存与未上传的修改，且无法恢复。云端已同步的记录会在下次同步时重新拉回。确定？')) return;
    await clearLocalCache();
    await sync.fullResync().catch(() => undefined);
    await refresh();
    await sync.refreshCounts();
    showToast('本机缓存已清空');
  }, [refresh, showToast]);

  const handleLogin = useCallback(async () => {
    setAskLogin(true);
  }, []);

  const handleLogout = useCallback(async () => {
    await sync.logout();
    await refreshProblems();
    showToast('已退出登录，本机记录仍保留');
  }, [refreshProblems, showToast]);

  if (askLogin === null || records === null) return <div className="loading">正在加载…</div>;

  if (askLogin) {
    return (
      <LoginPage
        onLogin={async (username, password) => {
          await sync.login(username, password);
          await setMeta(META_KEYS.localOnly, '0');
          setAskLogin(false);
          await refresh();
          showToast('已登录，正在同步');
        }}
        onUseLocalOnly={() => {
          void setMeta(META_KEYS.localOnly, '1');
          setAskLogin(false);
          showToast('可以先只在本机记录，随时可在设置里登录');
        }}
      />
    );
  }

  const monthNoteTarget: EditorTarget = { dateKey: monthKeyOf(dateKey), kind: 'month_note', slot: 'monthly', entryId: null };

  return (
    <div className="app">
      <header className="app-header">
        <h1>血糖记录</h1>
        <button className="sync-status" type="button" onClick={() => setTab('settings')}>
          {headerStatusText(syncStatus)}
        </button>
      </header>
      <main>
        {tab === 'fill' ? (
          <DayPage
            dateKey={dateKey}
            records={records}
            units={units}
            onDateChange={setDateKey}
            onSave={handleSave}
            onDelete={handleDelete}
            onGotoHistory={() => setTab('history')}
          />
        ) : tab === 'history' ? (
          <HistoryPage
            dateKey={dateKey}
            records={records}
            onOpenDay={(d) => {
              setDateKey(d);
              setTab('fill');
            }}
            onOpenEditor={openEditor}
            onEditMonthNote={() => openEditor(monthNoteTarget)}
            onRestore={handleRestore}
          />
        ) : tab === 'trend' ? (
          <TrendPage records={records} />
        ) : (
          <SettingsPage
            fontSize={fontSize}
            onFontSize={setFontSize}
            units={units}
            onUnits={(u) => {
              setUnits(u);
              localStorage.setItem('gms-units', JSON.stringify(u));
              showToast('单位配置已保存（只影响之后记录的默认单位，历史记录单位不变）');
            }}
            onSeed={seedFictional}
            onClear={clearLocal}
            syncStatus={syncStatus}
            syncEntries={problems}
            records={records}
            onLogin={handleLogin}
            onLogout={handleLogout}
            onSyncNow={() => void sync.syncNow()}
            onFullResync={() => {
              void sync
                .fullResync()
                .then(() => refresh())
                .then(() => showToast('已从云端重新拉取'))
                .catch((err: unknown) => showToast(err instanceof Error ? err.message : '拉取失败', true));
            }}
            onTakeLocal={(recordId) => {
              void sync
                .resolveTakeLocal(recordId)
                .then(() => refresh())
                .catch((err: unknown) => showToast(err instanceof Error ? err.message : '处理失败', true));
            }}
            onTakeRemote={(recordId) => {
              void sync
                .resolveTakeRemote(recordId)
                .then(() => refresh())
                .catch((err: unknown) => showToast(err instanceof Error ? err.message : '处理失败', true));
            }}
            onDiscard={(recordId) => {
              void sync.discardFailed(recordId).then(() => refreshProblems());
            }}
            onChangePassword={async (oldPassword, newPassword) => {
              // 服务端改密成功后会作废该账户全部会话，因此这里主动切回未登录态
              await api.changePassword(oldPassword, newPassword);
              await sync.logout();
              await refreshProblems();
              showToast('密码已修改，请用新密码重新登录');
            }}
          />
        )}
      </main>
      {/* 编辑弹窗（历史明细、月纪要等入口） */}
      {editor && (
        <div className="modal-overlay" onClick={closeEditor}>
          <div
            className="modal-card"
            role="dialog"
            aria-modal="true"
            aria-label="编辑记录"
            onClick={(e) => e.stopPropagation()}
          >
            <EntryForm
              target={editor}
              records={records}
              units={units}
              variant="modal"
              onSave={handleSave}
              onDelete={handleDelete}
              onSwitchTarget={setEditor}
              onDone={closeEditor}
              onClose={closeEditor}
            />
          </div>
        </div>
      )}
      <nav className="tab-bar" aria-label="主导航">
        {(
          [
            ['fill', '填写', IconPen],
            ['history', '回看', IconHistory],
            ['trend', '趋势', IconTrend],
            ['settings', '设置', IconSettings],
          ] as const
        ).map(([id, label, Icon]) => (
          <button key={id} aria-current={tab === id ? 'page' : undefined} onClick={() => setTab(id)}>
            <Icon size={30} />
            <span>{label}</span>
          </button>
        ))}
      </nav>
      {toast && (
        <div className={toast.error ? 'toast error' : 'toast'} role="status">
          {toast.text}
        </div>
      )}
    </div>
  );
}
