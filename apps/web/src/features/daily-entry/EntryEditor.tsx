import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { FieldError, LocalRecord, RecordKind } from '@gms/contracts';
import {
  formatDateCn,
  findGroupOfKind,
  findSlotDef,
  formFieldsFromPayload,
  formSpecFor,
  monthKeyOf,
  weekdayCn,
} from '@gms/domain';
import type { EditorTarget, SaveResult, Units } from '../../app/App';
import { deleteDraft, draftKeyFor, getDraft, putDraft } from '../../data/local/repo';
import { ConfirmDialog } from '../../components/ConfirmDialog';

type Props = {
  target: EditorTarget;
  records: LocalRecord[];
  units: Units;
  onSave: (target: EditorTarget, fields: Record<string, string>, confirmAbnormalBP: boolean) => Promise<SaveResult>;
  onSaveNext: (target: EditorTarget, fields: Record<string, string>, confirmAbnormalBP: boolean) => Promise<SaveResult>;
  onDelete: (id: string) => Promise<void>;
  onClose: () => void;
  onSwitchTarget: (t: EditorTarget) => void;
};

const UNIT_KEY_BY_KIND: Partial<Record<RecordKind, keyof Units>> = {
  glucose: 'glucose',
  weight: 'weight',
  water: 'water',
};

export function EntryEditor({ target, records, units, onSave, onSaveNext, onDelete, onClose, onSwitchTarget }: Props) {
  const slotDef = findSlotDef(target.kind, target.slot);
  const group = findGroupOfKind(target.kind);
  const periodKey = target.kind === 'month_note' ? monthKeyOf(target.dateKey) : target.dateKey;
  const dKey = draftKeyFor(periodKey, target.kind, target.slot, target.entryId);

  const targetRecord = useMemo(
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
    if (targetRecord && !targetRecord.deletedAt) {
      const f = formFieldsFromPayload(targetRecord.payload);
      if (targetRecord.occurredAt) f['occurredAt'] = targetRecord.occurredAt.slice(0, 16);
      return f;
    }
    const f: Record<string, string> = {};
    const unitKey = UNIT_KEY_BY_KIND[target.kind];
    if (unitKey) {
      const spec = formSpecFor(target.kind).find((s) => s.key === 'unit');
      if (spec) f['unit'] = units[unitKey];
    }
    return f;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [target.entryId]);

  const [fields, setFields] = useState<Record<string, string>>(initialFields);
  const [errors, setErrors] = useState<FieldError[]>([]);
  const [confirmAbnormalBP, setConfirmAbnormalBP] = useState(false);
  const [isDraft, setIsDraft] = useState(false);
  const [confirmDeleteId, setConfirmDeleteId] = useState<string | null>(null);
  const [escapeAsk, setEscapeAsk] = useState(false);
  const [saving, setSaving] = useState(false);
  const dirtyRef = useRef(false);
  const firstInputRef = useRef<HTMLInputElement>(null);
  const initialJson = JSON.stringify(initialFields);

  // 载入既有草稿（刷新恢复）
  useEffect(() => {
    let alive = true;
    void getDraft(dKey).then((d) => {
      if (alive && d && !dirtyRef.current) {
        setFields((prev) => ({ ...d.fields, ...prev }));
        setIsDraft(true);
      }
    });
    return () => {
      alive = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // 草稿自动保存（输入即存本机，标为“草稿，仅此设备”）
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
      })
        .then(() => setIsDraft(true))
        .catch(() => {
          /* 草稿写入失败不打断输入；正式保存时仍有原子写兜底 */
        });
    }, 400);
    return () => window.clearTimeout(timer);
  }, [fields, dKey, initialJson, periodKey, target.entryId, target.kind, target.slot]);

  // 直接聚焦数值输入
  useEffect(() => {
    firstInputRef.current?.focus();
  }, []);

  const setValue = (key: string, value: string) => {
    setFields((prev) => ({ ...prev, [key]: value }));
    setErrors((prev) => prev.filter((e) => e.field !== key && e.field !== '__form'));
  };

  const doSave = useCallback(
    async (andNext: boolean) => {
      setSaving(true);
      const r = andNext
        ? await onSaveNext(target, fields, confirmAbnormalBP)
        : await onSave(target, fields, confirmAbnormalBP);
      setSaving(false);
      if (!r.ok) {
        setErrors(r.errors ?? []);
        return;
      }
      void deleteDraft(dKey).catch(() => undefined);
      if (!andNext) onClose();
    },
    [confirmAbnormalBP, dKey, fields, onClose, onSave, onSaveNext, target],
  );

  // 桌面：Escape 退出——未修改直接关闭，有修改先询问
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && !confirmDeleteId) {
        if (dirtyRef.current) setEscapeAsk(true);
        else onClose();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [confirmDeleteId, onClose]);

  const pendingDelete = confirmDeleteId != null ? records.find((r) => r.id === confirmDeleteId) : undefined;
  const spec = formSpecFor(target.kind);
  const title = `${formatDateCn(target.dateKey)} · ${slotDef?.label ?? target.slot}`;

  const errorFor = (field: string) => errors.find((e) => e.field === field);
  const formError = errors.find((e) => e.field === '__form');

  const renderField = (f: (typeof spec)[number]) => {
    const err = errorFor(f.key);
    const common = { id: `f-${f.key}`, 'aria-invalid': err ? true : undefined } as const;
    if (f.type === 'select') {
      return (
        <div key={f.key}>
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
        <div key={f.key}>
          <label htmlFor={common.id}>{f.label}</label>
          <input
            {...common}
            type="datetime-local"
            value={fields[f.key] ?? ''}
            onChange={(e) => setValue(f.key, e.target.value)}
          />
          {err && <div className="field-error">{err.message}</div>}
        </div>
      );
    }
    if (f.type === 'decimal') {
      return (
        <div key={f.key}>
          <label htmlFor={common.id}>{f.label}</label>
          <input
            {...common}
            ref={f.key === 'value' || f.key === 'systolic' ? firstInputRef : undefined}
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
        <div key={f.key}>
          <label htmlFor={common.id}>
            {f.label} <span className="hint">（{(fields[f.key] ?? '').length}/4000）</span>
          </label>
          <textarea
            {...common}
            value={fields[f.key] ?? ''}
            onChange={(e) => setValue(f.key, e.target.value)}
          />
          {err && <div className="field-error">{err.message}</div>}
        </div>
      );
    }
    return (
      <div key={f.key}>
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
        return p.text.length > 40 ? `${p.text.slice(0, 40)}…` : p.text;
      case 'water':
        return `${p.total} ${p.unit}`;
      default:
        return '已记录';
    }
  };

  return (
    <div className="card">
      <div className="editor-head">
        <button className="btn ghost" onClick={() => (dirtyRef.current ? setEscapeAsk(true) : onClose())} aria-label="返回">
          ‹ 返回
        </button>
        <span className="editor-title">
          {target.kind === 'month_note' ? `${monthKeyOf(target.dateKey)} · 本月纪要` : `${title} ${target.dateKey === periodKey ? weekdayCn(target.dateKey) : ''}`}
        </span>
        {isDraft && <span className="badge warn">草稿，仅此设备</span>}
      </div>
      {group && <div className="hint">所属分组：{group.label}</div>}
      {formError && <div className="field-error" role="alert">{formError.message}</div>}

      {slotDef?.multi && (
        <div className="entries-list">
          <h3>本时点已有记录（{slotRecords.filter((r) => !r.deletedAt).length} 条）</h3>
          {slotRecords.length === 0 && <div className="hint">暂无记录。</div>}
          {slotRecords.map((r) => (
            <div key={r.id} className={r.deletedAt ? 'entry-item deleted' : 'entry-item'}>
              <div>
                <div className="detail-main">{renderEntryValue(r)}</div>
                <div className="detail-meta">
                  版本 v{r.version}
                  {r.occurredAt ? ` · ${r.occurredAt.slice(5, 16).replace('T', ' ')}` : ' · 时间未记录'}
                  {r.deletedAt ? ' · 已删除' : ''}
                </div>
              </div>
              {!r.deletedAt && (
                <div className="entry-actions">
                  <button className="btn secondary" onClick={() => onOpenEntry(r.id)}>
                    修改
                  </button>
                  {!targetRecord && (
                    <button className="btn secondary" onClick={() => onNewEntry()}>
                      再记一次
                    </button>
                  )}
                  <button className="btn danger" onClick={() => setConfirmDeleteId(r.id)}>
                    删除
                  </button>
                </div>
              )}
            </div>
          ))}
        </div>
      )}

      {!targetRecord && slotDef?.multi && slotRecords.some((r) => !r.deletedAt) && (
        <h3>新记录</h3>
      )}

      {spec.map(renderField)}

      {target.kind === 'blood_pressure' && errorFor('diastolic')?.message.includes('确认') && (
        <div className="checkline">
          <input
            id="bp-confirm"
            type="checkbox"
            checked={confirmAbnormalBP}
            onChange={(e) => {
              setConfirmAbnormalBP(e.target.checked);
              setErrors((prev) => prev.filter((x) => x.field !== 'diastolic'));
            }}
          />
          <label htmlFor="bp-confirm" style={{ margin: 0 }}>
            数值正确（收缩压小于舒张压），确认保存
          </label>
        </div>
      )}

      <div className="editor-actions">
        <button className="btn" disabled={saving} onClick={() => void doSave(false)}>
          保存
        </button>
        <button className="btn secondary" disabled={saving} onClick={() => void doSave(true)}>
          保存并填下一项
        </button>
      </div>
      <p className="hint">保存后返回原位置；草稿仅存本机，明确点击保存才进入待同步记录。</p>

      {pendingDelete && (
        <ConfirmDialog
          title="确认删除"
          message={`将删除 ${formatDateCn(periodKey)} · ${slotDef?.label ?? ''}：「${renderEntryValue(pendingDelete)}」。删除后 30 天内可在日明细恢复。`}
          confirmLabel="删除"
          onConfirm={() => {
            const id = confirmDeleteId!;
            setConfirmDeleteId(null);
            void onDelete(id);
            if (target.entryId === id) onClose();
          }}
          onCancel={() => setConfirmDeleteId(null)}
        />
      )}
      {escapeAsk && (
        <ConfirmDialog
          title="有未保存修改"
          message="返回将保留草稿（仅此设备），下次打开可恢复。"
          confirmLabel="保留草稿并返回"
          cancelLabel="继续填写"
          onConfirm={() => {
            setEscapeAsk(false);
            onClose();
          }}
          onCancel={() => setEscapeAsk(false)}
        />
      )}
    </div>
  );

  function onOpenEntry(id: string) {
    // 通过 URL 不适用（单页状态导航）；直接替换编辑目标
    window.dispatchEvent(new CustomEvent('gms-open-entry', { detail: { ...target, entryId: id } }));
  }
  function onNewEntry() {
    window.dispatchEvent(new CustomEvent('gms-open-entry', { detail: { ...target, entryId: null } }));
  }
}
