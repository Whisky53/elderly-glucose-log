import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { FieldError, LocalRecord, RecordKind } from '@gms/contracts';
import {
  formatDateCn,
  findSlotDef,
  formFieldsFromPayload,
  formSpecFor,
  monthKeyOf,
} from '@gms/domain';
import type { EditorTarget, SaveResult, Units } from '../../app/App';
import { deleteDraft, draftKeyFor, getDraft, putDraft } from '../../data/local/repo';
import { ConfirmDialog } from '../../components/ConfirmDialog';
import { IconCheck } from '../../components/Icons';

type Props = {
  target: EditorTarget;
  records: LocalRecord[];
  units: Units;
  variant: 'page' | 'modal';
  onSave: (target: EditorTarget, fields: Record<string, string>, confirmAbnormalBP: boolean) => Promise<SaveResult>;
  onSaveNext?: (target: EditorTarget, fields: Record<string, string>, confirmAbnormalBP: boolean) => Promise<SaveResult>;
  onDelete: (id: string) => Promise<void>;
  onSwitchTarget?: (t: EditorTarget) => void;
  /** 保存成功后回调：inline 收起输入区，page 关闭编辑页 */
  onDone: () => void;
  onClose?: () => void;
};

const UNIT_KEY_BY_KIND: Partial<Record<RecordKind, keyof Units>> = {
  glucose: 'glucose',
  weight: 'weight',
  water: 'water',
};

export function EntryForm({
  target,
  records,
  units,
  variant,
  onSave,
  onSaveNext,
  onDelete,
  onSwitchTarget,
  onDone,
  onClose,
}: Props) {
  const slotDef = findSlotDef(target.kind, target.slot);
  const periodKey = target.kind === 'month_note' ? monthKeyOf(target.dateKey) : target.dateKey;
  const dKey = draftKeyFor(periodKey, target.kind, target.slot, target.entryId);

  const editingRecord = useMemo(
    () => (target.entryId != null ? records.find((r) => r.id === target.entryId) : undefined),
    [records, target.entryId],
  );

  const slotRecords = useMemo(
    () =>
      records
        .filter((r) => r.kind === target.kind && r.slot === target.slot && r.periodKey === periodKey)
        .sort((a, b) => a.updatedAt.localeCompare(b.updatedAt)),
    [records, target.kind, target.slot, periodKey],
  );

  const initialFields = useMemo(() => {
    if (editingRecord && !editingRecord.deletedAt) {
      const f = formFieldsFromPayload(editingRecord.payload);
      if (editingRecord.occurredAt) f['occurredAt'] = editingRecord.occurredAt.slice(0, 16);
      return f;
    }
    const f: Record<string, string> = {};
    const unitKey = UNIT_KEY_BY_KIND[target.kind];
    if (unitKey) {
      const hasUnit = formSpecFor(target.kind).some((s) => s.key === 'unit');
      if (hasUnit) f['unit'] = units[unitKey];
    }
    // 实际测量时间默认当前时间（补记日则默认当天此刻），可手动清空
    const hasTime = formSpecFor(target.kind).some((s) => s.key === 'occurredAt');
    if (hasTime) f['occurredAt'] = defaultOccurredAt(target.dateKey);
    return f;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [target.entryId]);

  const [fields, setFields] = useState<Record<string, string>>(initialFields);
  const [errors, setErrors] = useState<FieldError[]>([]);
  const [confirmAbnormalBP, setConfirmAbnormalBP] = useState(false);
  const [confirmDeleteId, setConfirmDeleteId] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const dirtyRef = useRef(false);
  const initialJson = JSON.stringify(initialFields);

  // 载入既有草稿（刷新恢复）
  useEffect(() => {
    let alive = true;
    void getDraft(dKey).then((d) => {
      if (alive && d && !dirtyRef.current) {
        setFields((prev) => ({ ...d.fields, ...prev }));
      }
    });
    return () => {
      alive = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // 草稿自动保存
  useEffect(() => {
    if (JSON.stringify(fields) === initialJson && !dirtyRef.current) return;
    dirtyRef.current = true;
    const timer = window.setTimeout(() => {
      void putDraft({
        key: dKey,
        accountId: 'local-user',
        kind: target.kind,
        periodKey,
        slot: target.slot,
        entryId: target.entryId,
        fields,
        updatedAt: new Date().toISOString(),
      }).catch(() => undefined);
    }, 400);
    return () => window.clearTimeout(timer);
  }, [fields, dKey, initialJson, periodKey, target.entryId, target.kind, target.slot]);

  const setValue = (key: string, value: string) => {
    setFields((prev) => ({ ...prev, [key]: value }));
    setErrors((prev) => prev.filter((e) => e.field !== key && e.field !== '__form'));
  };

  const doSave = useCallback(
    async (andNext: boolean) => {
      setSaving(true);
      const r = andNext && onSaveNext
        ? await onSaveNext(target, fields, confirmAbnormalBP)
        : await onSave(target, fields, confirmAbnormalBP);
      setSaving(false);
      if (!r.ok) {
        setErrors(r.errors ?? []);
        return;
      }
      dirtyRef.current = false;
      void deleteDraft(dKey).catch(() => undefined);
      onDone();
    },
    [confirmAbnormalBP, dKey, fields, onDone, onSave, onSaveNext, target],
  );

  const pendingDelete = confirmDeleteId != null ? records.find((r) => r.id === confirmDeleteId) : undefined;
  const spec = formSpecFor(target.kind);
  const formError = errors.find((e) => e.field === '__form');

  const errorFor = (field: string) => errors.find((e) => e.field === field);

  const renderField = (f: (typeof spec)[number]) => {
    const err = errorFor(f.key);
    const common = { id: `f-${variant}-${target.kind}-${target.slot}-${f.key}`, 'aria-invalid': err ? true : undefined } as const;
    if (f.type === 'select') {
      return (
        <div key={f.key} className="field">
          <label htmlFor={common.id}>{f.label}</label>
          <select {...common} value={fields[f.key] ?? ''} onChange={(e) => setValue(f.key, e.target.value)}>
            {f.options.map((o) => (
              <option key={o} value={o}>
                {o}
              </option>
            ))}
          </select>
          {err && <div className="field-error">{err.message}</div>}
        </div>
      );
    }
    if (f.type === 'time') {
      return (
        <div key={f.key} className="field">
          <label htmlFor={common.id}>{f.label}</label>
          <input {...common} type="datetime-local" value={fields[f.key] ?? ''} onChange={(e) => setValue(f.key, e.target.value)} />
          {err && <div className="field-error">{err.message}</div>}
        </div>
      );
    }
    if (f.type === 'decimal') {
      return (
        <div key={f.key} className="field">
          <label htmlFor={common.id}>{f.label}</label>
          <input
            {...common}
            type="text"
            inputMode="decimal"
            value={fields[f.key] ?? ''}
            onChange={(e) => setValue(f.key, e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                e.preventDefault();
                void doSave(false);
              }
            }}
          />
          {err && <div className="field-error">{err.message}</div>}
        </div>
      );
    }
    if (f.multiline) {
      return (
        <div key={f.key} className="field">
          <label htmlFor={common.id}>
            {f.label} <span className="hint">（{(fields[f.key] ?? '').length}/4000）</span>
          </label>
          <textarea {...common} value={fields[f.key] ?? ''} onChange={(e) => setValue(f.key, e.target.value)} />
          {err && <div className="field-error">{err.message}</div>}
        </div>
      );
    }
    return (
      <div key={f.key} className="field">
        <label htmlFor={common.id}>{f.label}</label>
        <input {...common} type="text" value={fields[f.key] ?? ''} onChange={(e) => setValue(f.key, e.target.value)} />
        {err && <div className="field-error">{err.message}</div>}
      </div>
    );
  };

  const renderEntryValue = (r: LocalRecord): string => {
    const p = r.payload;
    switch (p.kind) {
      case 'glucose':
        return `${p.value} ${p.unit}${p.note ? `（${p.note}）` : ''}`;
      case 'blood_pressure':
        return `${p.systolic}/${p.diastolic} ${p.unit}`;
      case 'weight':
        return `${p.value} ${p.unit}`;
      case 'meal':
      case 'exercise':
      case 'insulin':
      case 'day_note':
        return p.text.length > 60 ? `${p.text.slice(0, 60)}…` : p.text;
      case 'water':
        return p.total === '0' ? `已记录 0 ${p.unit}` : `${p.total} ${p.unit}`;
      default:
        return '已记录';
    }
  };

  const showList = variant === 'page' || slotRecords.filter((r) => !r.deletedAt).length > 0;

  return (
    <div className="entry-form">
      {variant === 'modal' && (
        <div className="modal-head">
          <span className="modal-title">
            {target.kind === 'month_note'
              ? `${monthKeyOf(target.dateKey)} · 本月纪要`
              : `${formatDateCn(target.dateKey)} · ${slotDef?.label ?? target.slot}${editingRecord ? ' · 修改' : ''}`}
          </span>
          <button type="button" className="modal-close" onClick={onClose} aria-label="关闭">
            ✕
          </button>
        </div>
      )}
      {formError && <div className="field-error" role="alert">{formError.message}</div>}

      {slotDef?.multi && showList && (
        <div className="entries-list">
          {variant === 'page' && <h3>本时点已有记录（{slotRecords.filter((r) => !r.deletedAt).length} 条）</h3>}
          {slotRecords.map((r) => (
            <div key={r.id} className={r.deletedAt ? 'entry-item deleted' : 'entry-item'}>
              <div>
                <div className="entry-value">{renderEntryValue(r)}</div>
                <div className="entry-meta">
                  v{r.version}
                  {r.occurredAt ? ` · ${r.occurredAt.slice(5, 16).replace('T', ' ')}` : ' · 时间未记录'}
                  {r.deletedAt ? ' · 已删除' : ''}
                </div>
              </div>
              {!r.deletedAt && (
                <div className="entry-actions">
                  <button
                    className="btn small"
                    onClick={() => onSwitchTarget?.({ ...target, entryId: r.id })}
                  >
                    {target.entryId === r.id ? '正在修改' : '修改'}
                  </button>
                  {variant === 'page' && !editingRecord && (
                    <button className="btn small secondary" onClick={() => onSwitchTarget?.({ ...target, entryId: null })}>
                      再记一次
                    </button>
                  )}
                  <button className="btn small danger" onClick={() => setConfirmDeleteId(r.id)}>
                    删除
                  </button>
                </div>
              )}
            </div>
          ))}
        </div>
      )}

      {!editingRecord && slotDef?.multi && slotRecords.some((r) => !r.deletedAt) && (
        <div className="new-entry-label">{variant === 'page' ? '再记一条' : '记一笔'}</div>
      )}

      {spec.map(renderField)}

      {target.kind === 'blood_pressure' && errorFor('diastolic')?.message.includes('确认') && (
        <div className="checkline">
          <input
            id={`bp-confirm-${variant}-${target.slot}`}
            type="checkbox"
            checked={confirmAbnormalBP}
            onChange={(e) => {
              setConfirmAbnormalBP(e.target.checked);
              setErrors((prev) => prev.filter((x) => x.field !== 'diastolic'));
            }}
          />
          <label htmlFor={`bp-confirm-${variant}-${target.slot}`} style={{ margin: 0 }}>
            数值正确（收缩压小于舒张压），确认保存
          </label>
        </div>
      )}

      <div className="editor-actions">
        <button className="btn big" disabled={saving} onClick={() => void doSave(false)}>
          保存
        </button>
        {variant === 'page' && onSaveNext && (
          <button className="btn big secondary" disabled={saving} onClick={() => void doSave(true)}>
            保存并填下一项
          </button>
        )}
        {variant === 'modal' && dirtyRef.current && <span className="badge warn">草稿，仅此设备</span>}
      </div>

      {pendingDelete && (
        <ConfirmDialog
          title="确认删除"
          message={`将删除 ${formatDateCn(periodKey)} · ${slotDef?.label ?? ''}：「${renderEntryValue(pendingDelete)}」。删除后 30 天内可在日明细恢复。`}
          confirmLabel="删除"
          onConfirm={() => {
            const id = confirmDeleteId!;
            setConfirmDeleteId(null);
            if (target.entryId === id) onSwitchTarget?.({ ...target, entryId: null });
            void onDelete(id);
          }}
          onCancel={() => setConfirmDeleteId(null)}
        />
      )}
    </div>
  );
}

/** 大号完成对勾（卡片右上角状态） */
export function DoneCheck() {
  return (
    <span className="done-check" aria-label="已记录">
      <IconCheck size={34} />
    </span>
  );
}

/** 测量时间默认值：所选日期 + 当前时分 */
function defaultOccurredAt(dateKey: string): string {
  const d = new Date();
  const pad = (n: number) => String(n).padStart(2, '0');
  return dateKey + 'T' + pad(d.getHours()) + ':' + pad(d.getMinutes());
}
