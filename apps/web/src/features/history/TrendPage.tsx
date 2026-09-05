import { useMemo, useState } from 'react';
import type { LocalRecord } from '@gms/contracts';
import { GLUCOSE_SLOTS, todayKey } from '@gms/domain';

type Props = { records: LocalRecord[] };

/** 血糖趋势：同时点、同单位一组；缺失日不补零、不连线（A27） */
export function TrendPage({ records }: Props) {
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

  const series = useMemo(() => {
    const byUnit = new Map<string, LocalRecord[]>();
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
  const H = 240;
  const PAD = { l: 46, r: 14, t: 14, b: 28 };

  const chartFor = (unit: string, pts: LocalRecord[]) => {
    const values = pts.map((r) => Number((r.payload as { value: string }).value));
    const min = Math.min(...values);
    const max = Math.max(...values);
    const lo = Math.floor(min - 0.5);
    const hi = Math.ceil(max + 0.5);
    const x = (i: number) => PAD.l + (i * (W - PAD.l - PAD.r)) / Math.max(days.length - 1, 1);
    const y = (v: number) => PAD.t + (1 - (v - lo) / Math.max(hi - lo, 1)) * (H - PAD.t - PAD.b);
    const idxOf = (r: LocalRecord) => days.indexOf(r.periodKey);

    let path = '';
    let prevIdx = -2;
    for (const r of pts) {
      const i = idxOf(r);
      if (i < 0) continue;
      const cmd = prevIdx === i - 1 ? 'L' : 'M';
      path += `${cmd}${x(i).toFixed(1)},${y(Number((r.payload as { value: string }).value)).toFixed(1)} `;
      prevIdx = i;
    }
    return (
      <svg viewBox={`0 0 ${W} ${H}`} width="100%" role="img" aria-label={`血糖趋势 ${unit}`} className="trend-svg">
        {[lo, (lo + hi) / 2, hi].map((v, i) => (
          <g key={i}>
            <line x1={PAD.l} x2={W - PAD.r} y1={y(v)} y2={y(v)} stroke="#c9d2de" strokeWidth="1.5" />
            <text x={4} y={y(v) + 5} fontSize="14" fill="#141414" fontWeight="600">
              {v}
            </text>
          </g>
        ))}
        {path && <path d={path} fill="none" stroke="#141414" strokeWidth="3.5" strokeLinecap="round" strokeLinejoin="round" />}
        {pts.map((r) => {
          const i = idxOf(r);
          if (i < 0) return null;
          const v = Number((r.payload as { value: string }).value);
          return (
            <g key={r.id}>
              <circle cx={x(i)} cy={y(v)} r="6" fill="#ffffff" stroke="#141414" strokeWidth="3" />
              <circle cx={x(i)} cy={y(v)} r="10" fill="transparent">
                <title>{`${r.periodKey} ${v} ${unit}${r.occurredAt ? ` ${r.occurredAt.slice(11, 16)}` : ''}`}</title>
              </circle>
            </g>
          );
        })}
        {days.map((d, i) =>
          i % Math.ceil(days.length / 8) === 0 ? (
            <text key={d} x={x(i)} y={H - 6} fontSize="12" fill="#141414" fontWeight="600" textAnchor="middle">
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
          <table className="day-table" style={{ marginTop: '0.6rem' }}>
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
                  <td>
                    {(r.payload as { value: string }).value} {unit}
                  </td>
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
