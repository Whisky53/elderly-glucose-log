import type { FieldError, RecordKind, RecordPayload } from '@gms/contracts';
import { validateDecimal, validateDuration, validateText } from './decimal';
import { DEFAULT_UNITS, UNIT_OPTIONS } from './fields';

/**
 * 编辑表单字段统一为字符串（草稿可直接序列化），校验在此统一完成。
 * 与 PRD §5 字段规格一一对应；单位默认值为待确认设计默认，不由系统静默决定真实单位。
 */
export type FormSpecField =
  | { key: string; label: string; type: 'decimal'; allowZero?: boolean }
  | { key: string; label: string; type: 'text'; required: boolean; multiline?: boolean }
  | { key: string; label: string; type: 'select'; options: readonly string[] }
  | { key: string; label: string; type: 'time' };

export function formSpecFor(kind: RecordKind): FormSpecField[] {
  switch (kind) {
    case 'glucose':
      return [
        { key: 'value', label: '血糖值', type: 'decimal' },
        { key: 'unit', label: '单位', type: 'select', options: UNIT_OPTIONS.glucose },
        { key: 'occurredAt', label: '实际测量时间（可空）', type: 'time' },
        { key: 'note', label: '备注（可空）', type: 'text', required: false, multiline: true },
      ];
    case 'blood_pressure':
      return [
        { key: 'systolic', label: '收缩压', type: 'decimal' },
        { key: 'diastolic', label: '舒张压', type: 'decimal' },
        { key: 'unit', label: '单位', type: 'select', options: ['mmHg'] },
        { key: 'note', label: '备注（可空）', type: 'text', required: false, multiline: true },
      ];
    case 'weight':
      return [
        { key: 'value', label: '体重', type: 'decimal' },
        { key: 'unit', label: '单位', type: 'select', options: ['kg'] },
      ];
    case 'meal':
      return [{ key: 'text', label: '饮食内容', type: 'text', required: true, multiline: true }];
    case 'water':
      return [
        { key: 'total', label: '当天累计饮水量（允许 0）', type: 'decimal', allowZero: true },
        { key: 'unit', label: '单位', type: 'select', options: ['mL'] },
        { key: 'note', label: '备注（可空）', type: 'text', required: false, multiline: true },
      ];
    case 'exercise':
      return [
        { key: 'text', label: '运动内容', type: 'text', required: true, multiline: true },
        { key: 'durationMinutes', label: '时长（分钟，可空）', type: 'text', required: false },
      ];
    case 'insulin':
      return [
        { key: 'text', label: '原表内容文字', type: 'text', required: true, multiline: true },
        { key: 'name', label: '胰岛素名称（可空）', type: 'text', required: false },
        { key: 'occurredAt', label: '实际使用时间（可空）', type: 'time' },
        { key: 'dose', label: '剂量（可空）', type: 'text', required: false },
        { key: 'doseUnit', label: '剂量单位（填写剂量时必填）', type: 'text', required: false },
      ];
    case 'day_note':
      return [{ key: 'text', label: '一日纪要', type: 'text', required: false, multiline: true }];
    case 'month_note':
      return [{ key: 'text', label: '本月纪要', type: 'text', required: false, multiline: true }];
  }
}

/** 血压收缩压 < 舒张压：要求检查并允许确认保存，不诊断（PRD F02） */
export function bloodPressureNeedsConfirm(systolic: string, diastolic: string): boolean {
  const s = Number(systolic);
  const d = Number(diastolic);
  return Number.isFinite(s) && Number.isFinite(d) && s > 0 && d > 0 && s < d;
}

export type ValidateOutcome =
  | { ok: true; payload: RecordPayload; occurredAt: string | null }
  | { ok: false; errors: FieldError[] };

/** 校验表单字段并生成 payload；错误定位字段且不截断输入 */
export function validateForm(
  kind: RecordKind,
  fields: Record<string, string>,
  opts: { confirmAbnormalBP?: boolean } = {},
): ValidateOutcome {
  const errors: FieldError[] = [];
  const occurredAt = fields['occurredAt']?.trim() ? fields['occurredAt']!.trim() : null;
  if (occurredAt !== null && !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/.test(occurredAt)) {
    errors.push({ field: 'occurredAt', message: '时间格式不正确' });
  }

  const dec = (key: string, allowZero: boolean) => {
    const r = validateDecimal(fields[key] ?? '', { allowZero });
    if (!r.ok) errors.push({ field: key, message: r.error });
    return r.ok ? r.value : '';
  };
  const text = (key: string, required: boolean, label: string) => {
    const v = fields[key] ?? '';
    const err = validateText(v, label, required);
    if (err) errors.push({ field: key, message: err });
    return v;
  };

  let payload: RecordPayload;
  switch (kind) {
    case 'glucose': {
      const value = dec('value', false);
      const unit = (fields['unit'] ?? '').trim() || DEFAULT_UNITS.glucose;
      if (!unit) errors.push({ field: 'unit', message: '单位必填' });
      payload = { kind, value, unit, note: text('note', false, '备注') || undefined };
      break;
    }
    case 'blood_pressure': {
      const systolic = dec('systolic', false);
      const diastolic = dec('diastolic', false);
      const unit = (fields['unit'] ?? '').trim() || DEFAULT_UNITS.bloodPressure;
      if (
        systolic && diastolic && bloodPressureNeedsConfirm(systolic, diastolic) && !opts.confirmAbnormalBP
      ) {
        errors.push({ field: 'diastolic', message: '收缩压小于舒张压，请检查；确认无误可勾选确认保存' });
      }
      payload = { kind, systolic, diastolic, unit, note: text('note', false, '备注') || undefined };
      break;
    }
    case 'weight': {
      payload = { kind, value: dec('value', false), unit: (fields['unit'] ?? '').trim() || DEFAULT_UNITS.weight };
      break;
    }
    case 'meal': {
      payload = { kind, text: text('text', true, '饮食内容') };
      break;
    }
    case 'water': {
      payload = {
        kind,
        total: dec('total', true),
        unit: (fields['unit'] ?? '').trim() || DEFAULT_UNITS.water,
        note: text('note', false, '备注') || undefined,
      };
      break;
    }
    case 'exercise': {
      const t = text('text', true, '运动内容');
      const dur = validateDuration(fields['durationMinutes'] ?? '');
      if (typeof dur === 'string') errors.push({ field: 'durationMinutes', message: dur });
      payload = { kind, text: t, durationMinutes: typeof dur === 'number' ? dur : undefined };
      break;
    }
    case 'insulin': {
      const t = text('text', true, '原表内容文字');
      const dose = (fields['dose'] ?? '').trim();
      const doseUnit = (fields['doseUnit'] ?? '').trim();
      if (dose && !doseUnit) errors.push({ field: 'doseUnit', message: '填写剂量时单位必填' });
      if (dose) {
        const r = validateDecimal(dose, { allowZero: false });
        if (!r.ok) errors.push({ field: 'dose', message: r.error });
      }
      payload = {
        kind,
        text: t,
        name: (fields['name'] ?? '').trim() || undefined,
        dose: dose || undefined,
        doseUnit: doseUnit || undefined,
      };
      break;
    }
    case 'day_note':
      payload = { kind, text: text('text', false, '一日纪要') };
      break;
    case 'month_note':
      payload = { kind, text: text('text', false, '本月纪要') };
      break;
  }

  if (errors.length > 0) return { ok: false, errors };
  return { ok: true, payload, occurredAt };
}

/** 从 payload 还原表单字段（修改已有记录时用） */
export function formFieldsFromPayload(p: RecordPayload): Record<string, string> {
  const f: Record<string, string> = {};
  switch (p.kind) {
    case 'glucose':
      f['value'] = p.value;
      f['unit'] = p.unit;
      f['note'] = p.note ?? '';
      break;
    case 'blood_pressure':
      f['systolic'] = p.systolic;
      f['diastolic'] = p.diastolic;
      f['unit'] = p.unit;
      f['note'] = p.note ?? '';
      break;
    case 'weight':
      f['value'] = p.value;
      f['unit'] = p.unit;
      break;
    case 'meal':
    case 'day_note':
    case 'month_note':
      f['text'] = p.text;
      break;
    case 'water':
      f['total'] = p.total;
      f['unit'] = p.unit;
      f['note'] = p.note ?? '';
      break;
    case 'exercise':
      f['text'] = p.text;
      f['durationMinutes'] = p.durationMinutes != null ? String(p.durationMinutes) : '';
      break;
    case 'insulin':
      f['text'] = p.text;
      f['name'] = p.name ?? '';
      f['dose'] = p.dose ?? '';
      f['doseUnit'] = p.doseUnit ?? '';
      break;
  }
  return f;
}
