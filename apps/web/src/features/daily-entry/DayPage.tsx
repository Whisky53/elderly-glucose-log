import { useEffect, useMemo, useState } from 'react';
import type { LocalRecord, RecordKind } from '@gms/contracts';
import { GLUCOSE_SLOTS, addDays, formatDateCn, isFutureDate, isValidDateKey, todayKey } from '@gms/domain';
import type { EditorTarget, SaveResult, Units } from '../../app/App';
import { recordsOfDate } from '../../data/local/repo';
import { EntryForm, DoneCheck } from './EntryForm';
import {
  IconGlucose,
  IconBloodPressure,
  IconWeight,
  IconMeal,
  IconWater,
  IconExercise,
  IconInsulin,
  IconNote,
  IconPen,
} from '../../components/Icons';

type Props = {
  dateKey: string;
  records: LocalRecord[];
  units: Units;
  onDateChange: (d: string) => void;
  onSave: (t: EditorTarget, fields: Record<string, string>, confirm: boolean) => Promise<SaveResult>;
  onDelete: (id: string) => Promise<void>;
  onGotoHistory: () => void;
};

type SlotRow = { kind: RecordKind; slot: string; label: string };

type TileDef = {
  id: string;
  label: string;
  icon: (p: { size?: number }) => React.ReactElement;
  color: string;
  /** 多时点卡片：逐行展开；否则整卡一个表单 */
  rows?: SlotRow[];
  single?: SlotRow;
};

const TILES: TileDef[] = [
  {
    id: 'glucose',
    label: '血糖',
    icon: IconGlucose,
    color: '#E8F1FF',
    rows: [
      ...GLUCOSE_SLOTS.map((s) => ({ kind: 'glucose' as RecordKind, slot: s.slot, label: s.label })),
      { kind: 'glucose', slot: 'temporary', label: '临时测量' },
    ],
  },
  {
    id: 'bp',
    label: '血压',
    icon: IconBloodPressure,
    color: '#E7F6EC',
    rows: [
      { kind: 'blood_pressure', slot: 'fasting', label: '空腹' },
      { kind: 'blood_pressure', slot: 'bedtime', label: '睡前' },
    ],
  },
  {
    id: 'weight',
    label: '体重',
    icon: IconWeight,
    color: '#FFF1E0',
    rows: [
      { kind: 'weight', slot: 'morning', label: '早' },
      { kind: 'weight', slot: 'evening', label: '晚' },
    ],
  },
  { id: 'meal-b', label: '早餐', icon: IconMeal, color: '#FDEFF2', single: { kind: 'meal', slot: 'breakfast', label: '早餐' } },
  { id: 'meal-l', label: '午餐', icon: IconMeal, color: '#FDEFF2', single: { kind: 'meal', slot: 'lunch', label: '午餐' } },
  { id: 'meal-d', label: '晚餐', icon: IconMeal, color: '#FDEFF2', single: { kind: 'meal', slot: 'dinner', label: '晚餐' } },
  { id: 'water', label: '饮水', icon: IconWater, color: '#E4F5F7', single: { kind: 'water', slot: 'daily', label: '当天累计' } },
  { id: 'exercise', label: '运动', icon: IconExercise, color: '#EFEDFB', single: { kind: 'exercise', slot: 'daily', label: '当日运动' } },
  { id: 'insulin', label: '胰岛素', icon: IconInsulin, color: '#FFF8E1', single: { kind: 'insulin', slot: 'daily', label: '当日记录' } },
  { id: 'day_note', label: '一日纪要', icon: IconNote, color: '#F3F4F6', single: { kind: 'day_note', slot: 'daily', label: '一日纪要' } },
];

export function DayPage({ dateKey, records, units, onDateChange, onSave, onDelete, onGotoHistory }: Props) {
  const [weekAnchor, setWeekAnchor] = useState(todayKey());
  const [expanded, setExpanded] = useState<EditorTarget | null>(null);
  const today = todayKey();
  const isFuture = isFutureDate(dateKey);

  const dayRecords = useMemo(() => recordsOfDate(records, dateKey), [records, dateKey]);

  // 展开状态不跨日期残留
  useEffect(() => setExpanded(null), [dateKey]);

  const weekDays = useMemo(() => {
    const base = new Date(weekAnchor + 'T12:00:00');
    const dow = base.getDay();
    const monday = addDays(weekAnchor, dow === 0 ? -6 : 1 - dow);
    return Array.from({ length: 7 }, (_, i) => addDays(monday, i));
  }, [weekAnchor]);

  const activeOf = (kind: RecordKind, slot: string) =>
    dayRecords.filter((r) => r.kind === kind && r.slot === slot && !r.deletedAt);

  const summaryOf = (row: SlotRow): string => {
    const list = activeOf(row.kind, row.slot);
    if (list.length === 0) return '';
    const latest = list.reduce((a, b) => (a.updatedAt > b.updatedAt ? a : b));
    const p = latest.payload;
    switch (p.kind) {
      case 'glucose':
        return `${p.value} ${p.unit}${list.length > 1 ? `（${list.length}条）` : ''}`;
      case 'blood_pressure':
        return `${p.systolic}/${p.diastolic}${list.length > 1 ? `（${list.length}条）` : ''}`;
      case 'weight':
        return `${p.value} ${p.unit}`;
      case 'meal':
        return p.text.length > 12 ? `${p.text.slice(0, 12)}…` : p.text;
      case 'water':
        return p.total === '0' ? `已记录 0 ${p.unit}` : `${p.total} ${p.unit}`;
      case 'exercise':
        return p.durationMinutes != null ? `${p.durationMinutes}分钟` : p.text.slice(0, 10);
      case 'insulin':
        return p.text.length > 12 ? `${p.text.slice(0, 12)}…` : p.text;
      case 'day_note':
        return p.text.length > 12 ? `${p.text.slice(0, 12)}…` : p.text;
      default:
        return '已记录';
    }
  };

  const tileDone = (t: TileDef): boolean => {
    if (t.single) return activeOf(t.single.kind, t.single.slot).length > 0;
    return (t.rows ?? []).every((r) => activeOf(r.kind, r.slot).length > 0);
  };

  const shiftWeek = (delta: number) => setWeekAnchor((w) => addDays(w, delta * 7));

  const pickDate = (value: string) => {
    if (isValidDateKey(value) && !isFutureDate(value)) {
      onDateChange(value);
      setWeekAnchor(value);
    }
  };

  // Esc 关闭弹窗；弹窗打开时锁定背景滚动
  useEffect(() => {
    if (!expanded) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setExpanded(null);
    };
    window.addEventListener('keydown', onKey);
    document.body.style.overflow = 'hidden';
    return () => {
      window.removeEventListener('keydown', onKey);
      document.body.style.overflow = '';
    };
  }, [expanded]);

  return (
    <div>
      {/* 周横向日期选择栏 */}
      <div className="week-bar card">
        <div className="week-head">
          <button className="btn ghost week-nav" onClick={() => shiftWeek(-1)} aria-label="上一周">
            ‹
          </button>
          <div className="week-month">{formatDateCn(dateKey)}</div>
          <button className="btn ghost week-nav" onClick={() => shiftWeek(1)} aria-label="下一周">
            ›
          </button>
          <input
            type="date"
            value={dateKey}
            max={today}
            onChange={(e) => pickDate(e.target.value)}
            className="week-date-input"
            aria-label="选择日期"
          />
        </div>
        <div className="week-days">
          {weekDays.map((d) => {
            const selected = d === dateKey;
            const isToday = d === today;
            return (
              <button
                key={d}
                className={selected ? 'week-day selected' : isToday ? 'week-day today' : 'week-day'}
                onClick={() => {
                  onDateChange(d);
                  setWeekAnchor(d);
                }}
              >
                <span className="wd-label">{weekdayShort(d)}</span>
                <span className="wd-num">{Number(d.slice(8, 10))}</span>
                {isToday && <span className="wd-today">今</span>}
              </button>
            );
          })}
        </div>
        {dateKey !== today && !isFuture && (
          <div className="backfill-banner" role="status">
            <span>正在补记：{dateKey}</span>
            <button
              className="btn small secondary"
              onClick={() => {
                onDateChange(today);
                setWeekAnchor(today);
              }}
            >
              回今天
            </button>
          </div>
        )}
        {isFuture && <div className="future-banner" role="alert">不能选择未来日期。</div>}
      </div>

      {/* 棋盘网格卡片：血糖占 2/3 宽，血压/体重在右列上下堆叠，其余卡片流式排列；点击弹窗填写 */}
      {(() => {
        const glucoseTile = TILES.find((t) => t.id === 'glucose')!;
        const sideTiles = TILES.filter((t) => t.id === 'bp' || t.id === 'weight' || t.id === 'insulin');
        const restTiles = TILES.filter((t) => t.id !== 'glucose' && t.id !== 'bp' && t.id !== 'weight' && t.id !== 'insulin');
        const renderTile = (t: TileDef) => {
          const done = tileDone(t);
          const Icon = t.icon;
          return (
            <div key={t.id} className="tile" style={{ background: t.color }}>
              <div className="tile-head">
                <span className="tile-icon">
                  <Icon size={44} />
                </span>
                <span className="tile-label">{t.label}</span>
                {done ? <DoneCheck /> : <span className="tile-todo">未记</span>}
              </div>

              {t.rows && (
                <div className="tile-rows">
                  {t.rows.map((r) => {
                    const s = summaryOf(r);
                    return (
                      <button
                        key={`${r.kind}:${r.slot}`}
                        className={s ? 'tile-row filled' : 'tile-row'}
                        onClick={() => setExpanded({ dateKey, kind: r.kind, slot: r.slot, entryId: null })}
                      >
                        <span className="tile-row-label">{r.label}</span>
                        <span className="tile-row-value">{s || '＋'}</span>
                      </button>
                    );
                  })}
                </div>
              )}

              {t.single && (
                <div className="tile-body">
                  <button
                    className="btn big tile-open"
                    onClick={() => setExpanded({ dateKey, kind: t.single!.kind, slot: t.single!.slot, entryId: null })}
                  >
                    <IconPen size={26} />
                    {summaryOf(t.single) || '填写'}
                  </button>
                </div>
              )}
            </div>
          );
        };
        return (
          <>
            <div className="board-top">
              {renderTile(glucoseTile)}
              <div className="board-side">{sideTiles.map(renderTile)}</div>
            </div>
            <div className="board">{restTiles.map(renderTile)}</div>
          </>
        );
      })()}

      <p className="hint board-hint">
        点卡片弹出填写窗口，不用跳转页面；血糖、血压、体重同一格可再记一次。月纪要在
        <button className="btn small ghost" onClick={onGotoHistory}>
          回看 · 月表
        </button>
        中编辑。
      </p>

      {/* 填写弹窗 */}
      {expanded && !isFuture && (
        <div
          className="modal-overlay"
          onClick={() => setExpanded(null)}
        >
          <div
            className="modal-card"
            role="dialog"
            aria-modal="true"
            aria-label="填写记录"
            onClick={(e) => e.stopPropagation()}
          >
            <EntryForm
              target={expanded}
              records={records}
              units={units}
              variant="modal"
              onSave={onSave}
              onDelete={onDelete}
              onSwitchTarget={setExpanded}
              onDone={() => setExpanded(null)}
              onClose={() => setExpanded(null)}
            />
          </div>
        </div>
      )}
    </div>
  );
}

function weekdayShort(dateKey: string): string {
  const dow = new Date(dateKey + 'T12:00:00').getDay();
  return ['日', '一', '二', '三', '四', '五', '六'][dow]!;
}
