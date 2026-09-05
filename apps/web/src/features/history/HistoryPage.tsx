import { useMemo } from 'react';
import type { LocalRecord } from '@gms/contracts';
import { GLUCOSE_SLOTS, daysInMonth, firstWeekdayOfMonth, formatDateCn, monthKeyOf, todayKey } from '@gms/domain';
import type { EditorTarget } from '../../app/App';
import { recordsOfDate } from '../../data/local/repo';

type Props = {
  dateKey: string;
  records: LocalRecord[];
  onOpenDay: (dateKey: string) => void;
  onOpenEditor: (t: EditorTarget) => void;
  onEditMonthNote: () => void;
  onRestore: (id: string) => Promise<void>;
};

const KIND_LABELS: Record<string, string> = {
  glucose: '血糖',
  blood_pressure: '血压',
  weight: '体重',
  meal: '饮食',
  water: '饮水',
  exercise: '运动',
  insulin: '胰岛素',
  day_note: '一日纪要',
  month_note: '本月纪要',
};

function slotLabel(kind: string, slot: string): string {
  const g = GLUCOSE_SLOTS.find((s) => s.slot === slot);
  if (kind === 'glucose') return g?.label ?? (slot === 'temporary' ? '临时测量' : slot);
  switch (slot) {
    case 'fasting':
      return '空腹';
    case 'bedtime':
      return kind === 'weight' ? '晚' : '睡前';
    case 'morning':
      return '早';
    case 'evening':
      return '晚';
    case 'breakfast':
      return '早餐';
    case 'lunch':
      return '午餐';
    case 'dinner':
      return '晚餐';
    case 'daily':
      return '当日';
    case 'monthly':
      return '整月';
    default:
      return slot;
  }
}

function payloadText(r: LocalRecord): string {
  const p = r.payload;
  switch (p.kind) {
    case 'glucose':
      return `${p.value} ${p.unit}${p.note ? ` · ${p.note}` : ''}`;
    case 'blood_pressure':
      return `${p.systolic}/${p.diastolic} ${p.unit}`;
    case 'weight':
      return `${p.value} ${p.unit}`;
    case 'meal':
      return p.text;
    case 'water':
      return p.total === '0' ? `已记录 0 ${p.unit}` : `${p.total} ${p.unit}`;
    case 'exercise':
      return p.durationMinutes != null ? `${p.text}（${p.durationMinutes} 分钟）` : p.text;
    case 'insulin':
      return p.text;
    default:
      return p.text;
  }
}

export function HistoryPage({ dateKey, records, onOpenDay, onOpenEditor, onEditMonthNote, onRestore }: Props) {
  return (
    <div>
      <MonthTable dateKey={dateKey} records={records} onOpenDay={onOpenDay} onEditMonthNote={onEditMonthNote} />
      <DayDetail dateKey={dateKey} records={records} onOpenEditor={onOpenEditor} onRestore={onRestore} />
    </div>
  );
}

function DayDetail({ dateKey, records, onOpenEditor, onRestore }: Omit<Props, 'onOpenDay' | 'onEditMonthNote'>) {
  const dayRecords = useMemo(
    () => recordsOfDate(records, dateKey).sort((a, b) => a.createdAt.localeCompare(b.createdAt)),
    [records, dateKey],
  );
  return (
    <div className="card">
      <h2>{formatDateCn(dateKey)} 全部明细</h2>
      {dayRecords.length === 0 && <p className="hint">当天暂无记录。空白不表示未测量、未用药或未运动。</p>}
      {dayRecords.map((r) => (
        <div key={r.id} className="detail-item">
          <div>
            <div className="detail-main" style={r.deletedAt ? { textDecoration: 'line-through' } : undefined}>
              <strong>
                {KIND_LABELS[r.kind] ?? r.kind} · {slotLabel(r.kind, r.slot)}
              </strong>
              ：{payloadText(r)}
            </div>
            <div className="detail-meta">
              v{r.version} · 记录于 {r.createdAt.slice(5, 16).replace('T', ' ')}
              {r.occurredAt ? ` · 测量 ${r.occurredAt.slice(5, 16).replace('T', ' ')}` : ' · 测量时间未记录'}
              {r.deletedAt ? ` · 已删除（${r.deletedAt.slice(0, 10)}）` : ''}
            </div>
          </div>
          <div className="entry-actions">
            {!r.deletedAt ? (
              <button
                className="btn small secondary"
                onClick={() => onOpenEditor({ dateKey, kind: r.kind, slot: r.slot, entryId: r.id })}
              >
                修改
              </button>
            ) : (
              <button className="btn small secondary" onClick={() => void onRestore(r.id)}>
                恢复
              </button>
            )}
          </div>
        </div>
      ))}
    </div>
  );
}

function MonthTable({ dateKey, records, onOpenDay, onEditMonthNote }: Pick<Props, 'dateKey' | 'records' | 'onOpenDay' | 'onEditMonthNote'>) {
  const monthKey = monthKeyOf(dateKey);
  const total = daysInMonth(monthKey);
  const lead = firstWeekdayOfMonth(monthKey);
  const today = todayKey();

  const countsByDay = useMemo(() => {
    const map = new Map<string, { glucose: number; total: number }>();
    for (const r of records) {
      if (r.kind === 'month_note') continue;
      if (!r.periodKey.startsWith(monthKey)) continue;
      const day = r.periodKey.slice(8, 10);
      const entry = map.get(day) ?? { glucose: 0, total: 0 };
      if (!r.deletedAt) {
        entry.total += 1;
        if (r.kind === 'glucose') entry.glucose += 1;
      }
      map.set(day, entry);
    }
    return map;
  }, [records, monthKey]);

  const monthNote = records.find((r) => r.kind === 'month_note' && r.periodKey === monthKey && !r.deletedAt);
  const weekdays = ['日', '一', '二', '三', '四', '五', '六'];

  return (
    <div className="card">
      <h2>
        {monthKey} 月表（{total} 天）
      </h2>
      <div className="month-grid" role="grid" aria-label={`${monthKey} 月表`}>
        {weekdays.map((w) => (
          <div key={w} className="wd">
            {w}
          </div>
        ))}
        {Array.from({ length: lead }, (_, i) => (
          <div key={`lead-${i}`} />
        ))}
        {Array.from({ length: total }, (_, i) => {
          const day = String(i + 1).padStart(2, '0');
          const key = `${monthKey}-${day}`;
          const c = countsByDay.get(day);
          const hasData = (c?.total ?? 0) > 0;
          return (
            <button
              key={key}
              className={key === today ? 'month-cell today' : 'month-cell'}
              onClick={() => onOpenDay(key)}
              aria-label={`${key}，${hasData ? `已记录 ${c!.total} 项` : '无记录'}`}
            >
              <span className="d">{i + 1}</span>
              {hasData && (
                <span className="n">
                  {c!.glucose} / {c!.total}
                </span>
              )}
            </button>
          );
        })}
      </div>
      <p className="hint">点击任意一天回到填写页；空白表示当天无记录，不表示未测量。</p>
      <div className="month-note">
        <h2>本月纪要</h2>
        <p className="month-note-text">
          {monthNote ? (monthNote.payload.kind === 'month_note' ? monthNote.payload.text : '') : '（未填写）'}
        </p>
        <button className="btn big secondary" onClick={onEditMonthNote}>
          {monthNote ? '修改本月纪要' : '填写本月纪要'}
        </button>
      </div>
    </div>
  );
}
