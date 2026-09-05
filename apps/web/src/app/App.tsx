import { useCallback, useEffect, useRef, useState } from 'react';
import type { FieldError, LocalRecord, RecordKind } from '@gms/contracts';
import { isFutureDate, monthKeyOf, todayKey, validateForm } from '@gms/domain';
import { LOCAL_ACCOUNT, clearAllLocal, draftKeyFor, listAllRecords, saveRecordAndClearDraft, softDeleteRecord, uuid } from '../data/local/repo';
import { buildFictionalSeed } from '../data/local/seed';
import { DayPage } from '../features/daily-entry/DayPage';
import { EntryForm } from '../features/daily-entry/EntryForm';
import { HistoryPage } from '../features/history/HistoryPage';
import { TrendPage } from '../features/history/TrendPage';
import { SettingsPage } from '../features/settings/SettingsPage';
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

export default function App() {
  const [tab, setTab] = useState<Tab>('fill');
  const [dateKey, setDateKey] = useState(todayKey());
  const [records, setRecords] = useState<LocalRecord[] | null>(null);
  const [editor, setEditor] = useState<EditorTarget | null>(null);
  const [fontSize, setFontSize] = useState(() => localStorage.getItem('gms-fontSize') ?? '22');
  const [units, setUnits] = useState<Units>(loadUnits);
  const [toast, setToast] = useState<{ text: string; error?: boolean } | null>(null);
  const scrollMemo = useRef(0);

  const refresh = useCallback(async () => {
    setRecords(await listAllRecords());
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

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

  /** 保存正式记录（本机持久化成功才提示；失败保留内容不显示成功） */
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
            accountId: LOCAL_ACCOUNT,
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

      try {
        await saveRecordAndClearDraft(record, draftKey);
      } catch {
        showToast('保存失败：本机存储未完成，内容仍在表单中', true);
        return { ok: false, hardFail: true };
      }
      await refresh();
      showToast('已保存到此设备，待同步');
      return { ok: true };
    },
    [records, refresh, showToast],
  );

  const handleDelete = useCallback(
    async (id: string) => {
      const updated = await softDeleteRecord(id);
      if (updated) showToast('已删除（30 天内可在日明细恢复）');
      await refresh();
    },
    [refresh, showToast],
  );

  const handleRestore = useCallback(
    async (id: string) => {
      const all = await listAllRecords();
      const rec = all.find((r) => r.id === id);
      if (!rec) return;
      const restored: LocalRecord = { ...rec, deletedAt: null, version: rec.version + 1, updatedAt: nowIso() };
      await saveRecordAndClearDraft(restored, null);
      showToast('已恢复为新版本');
      await refresh();
    },
    [refresh, showToast],
  );

  const seedFictional = useCallback(async () => {
    const existing = await listAllRecords();
    if (existing.length > 0 && !window.confirm('本地已有数据，虚构示例将一并加入，确定继续？')) return;
    const seeds = buildFictionalSeed();
    for (const s of seeds) await saveRecordAndClearDraft(s, null);
    await refresh();
    showToast('已载入虚构示例数据（仅用于评审）');
  }, [refresh, showToast]);

  const clearLocal = useCallback(async () => {
    if (!window.confirm('将删除本机全部草稿与记录，且无法恢复（本地版无云端备份）。确定？')) return;
    await clearAllLocal();
    await refresh();
    showToast('本地数据已清空');
  }, [refresh, showToast]);

  if (records === null) return <div className="loading">正在加载…</div>;

  const monthNoteTarget: EditorTarget = { dateKey: monthKeyOf(dateKey), kind: 'month_note', slot: 'monthly', entryId: null };

  return (
    <div className="app">
      <header className="app-header">
        <h1>血糖记录</h1>
        <div className="sync-status">本地版 · 数据仅存于此设备</div>
      </header>
      <main>
        {editor ? (
          <EntryForm
            target={editor}
            records={records}
            units={units}
            variant="page"
            onSave={handleSave}
            onDelete={handleDelete}
            onSwitchTarget={setEditor}
            onDone={closeEditor}
            onClose={closeEditor}
          />
        ) : tab === 'fill' ? (
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
          />
        )}
      </main>
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
