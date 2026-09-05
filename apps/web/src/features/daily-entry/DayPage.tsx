import { useEffect, useMemo, useState } from 'react';
import type { LocalRecord, RecordKind } from '@gms/contracts';
import {
  FIELD_GROUPS,
  addDays,
  formatDateCn,
  isFutureDate,
  isValidDateKey,
  todayKey,
  weekdayCn,
} from '@gms/domain';
import type { EditorTarget } from '../../app/App';
import { recordsOfDate } from '../../data/local/repo';

type Props = {
  dateKey: string;
  records: LocalRecord[];
  onDateChange: (d: string) => void;
  onOpen: (t: EditorTarget) => void;
  onGotoHistory: () => void;
};

type SlotSummary = { text: string; count: number; hasDraft: boolean; flashKey?: string };

export function DayPage({ dateKey, records, onDateChange, onOpen, onGotoHistory }: Props) {
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  const [isWide, setIsWide] = useState(() => window.matchMedia('(min-width: 768px)').matches);
  const [lastSavedKey, setLastSavedKey] = useState<string | null>(null);

  useEffect(() => {
    const mq = window.matchMedia('(min-width: 768px)');
    const fn = (e: MediaQueryListEvent) => setIsWide(e.matches);
    mq.addEventListener('change', fn);
    return () => mq.removeEventListener('change', fn);
  }, []);

  const dayRecords = useMemo(() => recordsOfDate(records, dateKey), [records, dateKey]);
  const isFuture = isFutureDate(dateKey);
  const isToday = dateKey === todayKey();
  const isBackfill = dateKey < todayKey();

  const summarize = (kind: RecordKind, slot: string): SlotSummary => {
    const list = dayRecords.filter((r) => r.kind === kind && r.slot === slot);
    const active = list.filter((r) => !r.deletedAt);
    // 草稿标记由编辑页负责；此处只展示已保存内容
    if (active.length === 0) {
      if (list.some((r) => r.deletedAt)) return { text: '已删除', count: 0, hasDraft: false };
      return { text: '', count: 0, hasDraft: false };
    }
    const latest = active.reduce((a, b) => (a.updatedAt > b.updatedAt ? a : b));
    const p = latest.payload;
    let text: string;
    switch (p.kind) {
      case 'glucose':
        text = `${p.value} ${p.unit}`;
        break;
      case 'blood_pressure':
        text = `${p.systolic}/${p.diastolic} ${p.unit}`;
        break;
      case 'weight':
        text = `${p.value} ${p.unit}`;
        break;
      case 'meal':
        text = p.text.length > 14 ? `${p.text.slice(0, 14)}…` : p.text;
        break;
      case 'water':
        text = p.total === '0' ? `已记录 0 ${p.unit}` : `${p.total} ${p.unit}`;
        break;
      case 'exercise':
        text = p.durationMinutes != null ? `${p.text.slice(0, 10)}${p.text.length > 10 ? '…' : ''} ${p.durationMinutes}分钟` : p.text.slice(0, 16);
        break;
      case 'insulin':
        text = p.text.length > 16 ? `${p.text.slice(0, 16)}…` : p.text;
        break;
      case 'day_note':
        text = p.text.length > 16 ? `${p.text.slice(0, 16)}…` : p.text;
        break;
      default:
        text = '已记录';
    }
    return { text, count: active.length, hasDraft: false, flashKey: latest.id };
  };

  const groupSummary = (groupId: string): string => {
    const group = FIELD_GROUPS.find((g) => g.id === groupId)!;
    const filled = group.slots.filter((s) => summarize(s.kind, s.slot).count > 0).length;
    return filled === 0 ? '未记录' : `已记录 ${filled} 项`;
  };

  const toggleGroup = (id: string) => {
    setCollapsed((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const shiftDate = (delta: number) => {
    const next = addDays(dateKey, delta);
    if (isFutureDate(next)) return;
    onDateChange(next);
  };

  const pickDate = (value: string) => {
    if (isValidDateKey(value) && !isFutureDate(value)) onDateChange(value);
  };

  const openSlot = (kind: RecordKind, slot: string) => {
    setLastSavedKey(null);
    onOpen({ dateKey, kind, slot, entryId: null });
  };

  return (
    <div>
      <div className="date-nav">
        <button className="btn ghost" onClick={() => shiftDate(-1)} aria-label="上一天">
          ‹
        </button>
        <div className="date-title">
          {isToday ? `今天 ${formatDateCn(dateKey)}` : formatDateCn(dateKey)} {weekdayCn(dateKey)}
        </div>
        <button className="btn ghost" onClick={() => shiftDate(1)} disabled={isToday} aria-label="下一天">
          ›
        </button>
        <input type="date" value={dateKey} max={todayKey()} onChange={(e) => pickDate(e.target.value)} aria-label="选择日期" />
        {!isToday && (
          <button className="btn secondary" onClick={() => onDateChange(todayKey())}>
            回今天
          </button>
        )}
      </div>

      {isBackfill && (
        <div className="backfill-banner" role="status">
          <span>正在补记：{dateKey}（保存后不会自动切回今天）</span>
          <button className="btn ghost" onClick={() => onDateChange(todayKey())}>
            回今天
          </button>
        </div>
      )}
      {isFuture && <div className="future-banner" role="alert">不能选择未来日期，请返回今天或过去日期。</div>}

      {isWide ? (
        <table className="day-table">
          <thead>
            <tr>
              <th scope="col">项目</th>
              <th scope="col">时点</th>
              <th scope="col">已记录内容</th>
              <th scope="col">操作</th>
            </tr>
          </thead>
          <tbody>
            {FIELD_GROUPS.map((g) => (
              <GroupRows
                key={g.id}
                group={g}
                summarize={summarize}
                onOpen={openSlot}
                wide
              />
            ))}
          </tbody>
        </table>
      ) : (
        FIELD_GROUPS.map((g) => {
          const isCollapsed = g.id !== 'glucose' && collapsed.has(g.id);
          return (
            <section className="group" key={g.id}>
              <button
                className="group-header"
                onClick={() => toggleGroup(g.id)}
                aria-expanded={!isCollapsed}
              >
                <span>{g.label}</span>
                <span className="summary">{isCollapsed ? groupSummary(g.id) : ''}</span>
              </button>
              {!isCollapsed && (
                <GroupRows group={g} summarize={summarize} onOpen={openSlot} wide={false} />
              )}
            </section>
          );
        })
      )}

      <p className="hint" style={{ marginTop: '0.8rem' }}>
        点击任意项目即可填写；同一时点可“再记一次”；未填其他项目不影响保存。月纪要在
        <button className="btn ghost" style={{ minHeight: 32, padding: '0 0.4rem', marginLeft: 4 }} onClick={onGotoHistory}>
          回看 · 月表
        </button>
        中编辑。
      </p>
      {lastSavedKey && <span hidden>{lastSavedKey}</span>}
    </div>
  );
}

type GroupDef = (typeof FIELD_GROUPS)[number];

function GroupRows({
  group,
  summarize,
  onOpen,
  wide,
}: {
  group: GroupDef;
  summarize: (kind: RecordKind, slot: string) => SlotSummary;
  onOpen: (kind: RecordKind, slot: string) => void;
  wide: boolean;
}) {
  return (
    <>
      {wide && (
        <tr className="group-row">
          <td colSpan={4}>{group.label}</td>
        </tr>
      )}
      {group.slots.map((s) => {
        const sum = summarize(s.kind, s.slot);
        const valueNode = sum.count > 0 ? (
          <span className="value">
            {sum.text}
            {s.multi && sum.count > 1 && <span className="count">共 {sum.count} 条</span>}
          </span>
        ) : (
          <span className="fill-hint">填写</span>
        );
        return wide ? (
          <tr key={`${s.kind}:${s.slot}`} className="data-row" onClick={() => onOpen(s.kind, s.slot)}>
            <td>{group.label}</td>
            <td>{s.label}</td>
            <td>{sum.count > 0 ? valueNode : <span className="fill-hint">未记录</span>}</td>
            <td>
              <button className="btn secondary" style={{ minHeight: 40, padding: '0.2rem 0.7rem' }} onClick={(e) => { e.stopPropagation(); onOpen(s.kind, s.slot); }}>
                {sum.count > 0 ? '查看' : '填写'}
              </button>
            </td>
          </tr>
        ) : (
          <button key={`${s.kind}:${s.slot}`} className="slot-row" onClick={() => onOpen(s.kind, s.slot)}>
            <span>{s.label}</span>
            {valueNode}
          </button>
        );
      })}
    </>
  );
}
