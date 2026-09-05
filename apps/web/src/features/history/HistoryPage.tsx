import { useMemo, useState } from 'react';
import type { LocalRecord } from '@gms/contracts';
import {
  GLUCOSE_SLOTS,
  daysInMonth,
  firstWeekdayOfMonth,
  formatDateCn,
  monthKeyOf,
  todayKey,
} from '@gms/domain';
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

type SubTab = 'day' | 'month' | 'trend';

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
  const [sub, setSub] = useState<SubTab>('day');

  return (
    <div>
      <div className="subtabs" role="tablist">
        {(
          [
            ['day', '日明细'],
            ['month', '月表'],
            ['trend', '血糖趋势'],
          ] as const
        ).map(([id, label]) => (
          <button key={id} role="tab" aria-selected={sub === id} onClick={() => setSub(id)}>
            {label}
          </button>
        ))}
      </div>
      {sub === 'day' && <DayDetail dateKey={dateKey} records={records} onOpenEditor={onOpenEditor} onRestore={onRestore} />}
      {sub === 'month' && <MonthTable dateKey={dateKey} records={records} onOpenDay={onOpenDay} onEditMonthNote={onEditMonthNote} />}
      {sub === 'trend' && <Trend records={records} />}
    </div>
  );
}

function DayDetail({
  dateKey,
  records,
  onOpenEditor,
  onRestore,
}: Pick<Props, 'dateKey' | 'records'> & Pick<Props, 'onOpenEditor' | 'onRestore'>) {
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
              <strong>{KIND_LABELS[r.kind] ?? r.kind} · {slotLabel(r.kind, r.slot)}</strong>：{payloadText(r)}
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
                className="btn secondary"
                style={{ minHeight: 40 }}
                onClick={() => onOpenEditor({ dateKey, kind: r.kind, slot: r.slot, entryId: r.id })}
              >
                修改
              </button>
            ) : (
              <button className="btn secondary" style={{ minHeight: 40 }} onClick={() => void onRestore(r.id)}>
                恢复
              </button>
            )}
          </div>
        </div>
      ))}
    </div>
  );
}

function MonthTable({
  dateKey,
  records,
  onOpenDay,
  onEditMonthNote,
}: Pick<Props, 'dateKey' | 'records' | 'onOpenDay' | 'onEditMonthNote'>) {
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

  const monthNote = records.find(
    (r) => r.kind === 'month_note' && r.periodKey === monthKey && !r.deletedAt,
  );

  const weekdays = ['日', '一', '二', '三', '四', '五', '六'];

  return (
    <div>
      <div className="card">
        <h2>{monthKey} 月表（{total} 天）</h2>
        <div className="month-grid" role="grid" aria-label={`${monthKey} 月表`}>
          {weekdays.map((w) => (
            <div key={w} className="wd">
              周{w}
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
                {hasData && <span className="n">血糖 {c!.glucose} · 共{c!.total}</span>}
              </button>
            );
          })}
        </div>
        <p className="hint">点击任意一天进入当日日表查看与修改；空白表示当天无记录，不表示未测量。</p>
      </div>
      <div className="card">
        <h2>本月纪要</h2>
        <p style={{ fontSize: '0.95rem', whiteSpace: 'pre-wrap' }}>
          {monthNote ? (monthNote.payload.kind === 'month_note' ? monthNote.payload.text : '') : '（未填写）'}
        </p>
        <button className="btn secondary" onClick={onEditMonthNote}>
          {monthNote ? '修改本月纪要' : '填写本月纪要'}
        </button>
      </div>
    </div>
  );
}

function Trend({ records }: Pick<Props, 'records'>) {
  const [slot, setSlot] = useState('fasting');
  const [range, setRange] = useState<'7' | '30' | 'custom'>('7');
  const [from, setFrom] = useState(() => shift(todayKey(), -6));
  const [to, setTo] = useState(todayKey());

  const effectiveFrom = range === '7' ? shift(todayKey(), -6) : range === '30' ? shift(todayKey(), -29) : from;
  const effectiveTo = range === 'custom' ? to : todayKey();

  const days = useMemo(() => {
    const list: string[] = [];
    let d = effectiveFrom;
    let guard = 0;
    while (d <= effectiveTo && guard < 400) {
      list.push(d);
      d = shift(d, 1);
      guard += 1;
    }
    return list;
  }, [effectiveFrom, effectiveTo]);

  // 仅同时点、同单位绘制为一组（A27）；缺失不补零、不跨缺失连线
  const series = useMemo(() => {
    const byUnit = new Map<string, Array<LocalRecord>>();
    for (const r of records) {
      if (r.kind !== 'glucose' || r.slot !== slot || r.deletedAt) continue;
      if (r.periodKey < effectiveFrom || r.periodKey > effectiveTo) continue;
      const unit = r.payload.kind === 'glucose' ? r.payload.unit : '';
      const arr = byUnit.get(unit) ?? [];
      arr.push(r);
      byUnit.set(unit, arr);
    }
    for (const arr of byUnit.values()) arr.sort((a, b) => a.periodKey.localeCompare(b.periodKey));
    return [...byUnit.entries()].sort((a, b) => b[1].length - a[1].length);
  }, [records, slot, effectiveFrom, effectiveTo]);

  const slotNames = [...GLUCOSE_SLOTS.map((s) => ({ slot: s.slot, label: s.label })), { slot: 'temporary', label: '临时测量' }];
  const W = 640;
  const H = 220;
  const PAD = { l: 44, r: 12, t: 12, b: 26 };

  const chartFor = (unit: string, pts: LocalRecord[]) => {
    const values = pts.map((r) => Number((r.payload as { value: string }).value));
    const min = Math.min(...values);
    const max = Math.max(...values);
    const lo = Math.floor(min - 0.5);
    const hi = Math.ceil(max + 0.5);
    const x = (i: number) => PAD.l + (i * (W - PAD.l - PAD.r)) / Math.max(days.length - 1, 1);
    const y = (v: number) => PAD.t + (1 - (v - lo) / Math.max(hi - lo, 1)) * (H - PAD.t - PAD.b);
    const idxOf = (r: LocalRecord) => days.indexOf(r.periodKey);

    // 缺失天不连线：仅在相邻日期都有点时连线
    const segs: string[] = [];
    let path = '';
    let prevIdx = -2;
    for (const r of pts) {
      const i = idxOf(r);
      if (i < 0) continue;
      const cmd = prevIdx === i - 1 ? 'L' : 'M';
      path += `${cmd}${x(i).toFixed(1)},${y(Number((r.payload as { value: string }).value)).toFixed(1)} `;
      prevIdx = i;
    }
    if (path) segs.push(path);
    return (
      <svg viewBox={`0 0 ${W} ${H}`} width="100%" role="img" aria-label={`血糖趋势 ${unit}`}>
        {[lo, (lo + hi) / 2, hi].map((v, i) => (
          <g key={i}>
            <line x1={PAD.l} x2={W - PAD.r} y1={y(v)} y2={y(v)} stroke="#d9dfe8" strokeWidth="1" />
            <text x={4} y={y(v) + 4} fontSize="11" fill="#4a5568">
              {v}
            </text>
          </g>
        ))}
        <path d={segs.join(' ')} fill="none" stroke="#0b5fff" strokeWidth="2" />
        {pts.map((r) => {
          const i = idxOf(r);
          if (i < 0) return null;
          const v = Number((r.payload as { value: string }).value);
          return (
            <circle key={r.id} cx={x(i)} cy={y(v)} r="4" fill="#0b5fff">
              <title>{`${r.periodKey} ${v} ${unit}${r.occurredAt ? ` ${r.occurredAt.slice(11, 16)}` : ''}`}</title>
            </circle>
          );
        })}
        {days.map((d, i) =>
          i % Math.ceil(days.length / 8) === 0 ? (
            <text key={d} x={x(i)} y={H - 6} fontSize="10" fill="#4a5568" textAnchor="middle">
              {d.slice(5)}
            </text>
          ) : null,
        )}
      </svg>
    );
  };

  return (
    <div className="card">
      <h2>血糖趋势</h2>
      <div className="subtabs">
        <label className="hint" htmlFor="trend-slot" style={{ alignSelf: 'center' }}>
          时点
        </label>
        <select id="trend-slot" value={slot} onChange={(e) => setSlot(e.target.value)} style={{ width: 'auto' }}>
          {slotNames.map((s) => (
            <option key={s.slot} value={s.slot}>
              {s.label}
            </option>
          ))}
        </select>
        {(
          [
            ['7', '近7天'],
            ['30', '近30天'],
            ['custom', '自选'],
          ] as const
        ).map(([id, label]) => (
          <button key={id} aria-selected={range === id} onClick={() => setRange(id)}>
            {label}
          </button>
        ))}
        {range === 'custom' && (
          <>
            <input type="date" value={from} max={todayKey()} onChange={(e) => setFrom(e.target.value)} style={{ width: 'auto' }} />
            <input type="date" value={to} max={todayKey()} onChange={(e) => setTo(e.target.value)} style={{ width: 'auto' }} />
          </>
        )}
      </div>
      <p className="hint">仅绘制相同时点、相同单位的数据；缺失日期不补零、不连线；多次测量均显示。R1 不提供医疗达标区间或结论。</p>
      {series.length === 0 && <p className="hint">所选范围与时间点暂无血糖数据。</p>}
      {series.map(([unit, pts]) => (
        <div key={unit}>
          <div className="trend-legend">
            单位 {unit} · {pts.length} 条
          </div>
          <div className="trend-wrap">{chartFor(unit, pts)}</div>
          <table className="day-table" style={{ marginTop: '0.5rem' }}>
            <thead>
              <tr>
                <th>日期</th>
                <th>时间</th>
                <th>数值</th>
                <th>备注</th>
              </tr>
            </thead>
            <tbody>
              {pts.map((r) => (
                <tr key={r.id}>
                  <td>{r.periodKey}</td>
                  <td>{r.occurredAt ? r.occurredAt.slice(11, 16) : '未记录'}</td>
                  <td>{(r.payload as { value: string }).value} {unit}</td>
                  <td>{r.payload.kind === 'glucose' ? (r.payload.note ?? '') : ''}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ))}
      {series.length > 1 && <p className="hint">存在多个单位的数据，已分组展示，不混画在同一图中。</p>}
    </div>
  );
}

function shift(dateKey: string, delta: number): string {
  const d = new Date(dateKey + 'T12:00:00');
  d.setDate(d.getDate() + delta);
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}
