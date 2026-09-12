/**
 * 服务端记录校验。规则与前端 packages/domain 共用同一套函数，
 * 避免“前端能填、后端拒收”的分裂；payload 采用 kind 判别联合，
 * 并逐 kind 限定允许字段，JSONB/JSON 列不成为任意字段垃圾桶（架构 §4.1）。
 */
import type { FieldError, RecordKind, RecordPayload } from '@gms/contracts';
import { TEXT_MAX_LENGTH, isUniqueSlot, validateDecimal, validateText } from '@gms/domain';

export const RECORD_KINDS: readonly RecordKind[] = [
  'glucose',
  'blood_pressure',
  'weight',
  'meal',
  'water',
  'exercise',
  'insulin',
  'day_note',
  'month_note',
];

/** 每个 kind 允许出现的 payload 字段；多一个即拒收 */
const ALLOWED_KEYS: Record<RecordKind, readonly string[]> = {
  glucose: ['kind', 'value', 'unit', 'note'],
  blood_pressure: ['kind', 'systolic', 'diastolic', 'unit', 'note'],
  weight: ['kind', 'value', 'unit'],
  meal: ['kind', 'text'],
  water: ['kind', 'total', 'unit', 'note'],
  exercise: ['kind', 'text', 'durationMinutes'],
  insulin: ['kind', 'text', 'name', 'dose', 'doseUnit'],
  day_note: ['kind', 'text'],
  month_note: ['kind', 'text'],
};

/** 每个 kind 允许的时点；month_note 为月级，不在日表分组内 */
const ALLOWED_SLOTS: Record<RecordKind, readonly string[]> = {
  glucose: ['fasting', 'breakfast_2h', 'lunch_pre', 'lunch_2h', 'dinner_pre', 'dinner_2h', 'bedtime', 'temporary'],
  blood_pressure: ['fasting', 'bedtime'],
  weight: ['morning', 'evening'],
  meal: ['breakfast', 'lunch', 'dinner'],
  water: ['daily'],
  exercise: ['daily'],
  insulin: ['daily'],
  day_note: ['daily'],
  month_note: ['monthly'],
};

export function isRecordKind(v: unknown): v is RecordKind {
  return typeof v === 'string' && (RECORD_KINDS as readonly string[]).includes(v);
}

export type PayloadOutcome =
  | { ok: true; payload: RecordPayload }
  | { ok: false; errors: FieldError[] };

/** 校验并规范化 payload；数值按十进制字符串处理，禁止二进制浮点改变原始精度 */
export function validatePayload(kind: RecordKind, raw: unknown): PayloadOutcome {
  const errors: FieldError[] = [];
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    return { ok: false, errors: [{ field: 'payload', message: '记录内容缺失或格式不正确' }] };
  }
  const p = raw as Record<string, unknown>;

  for (const key of Object.keys(p)) {
    if (!ALLOWED_KEYS[kind].includes(key)) {
      errors.push({ field: `payload.${key}`, message: '包含该记录类型不允许的字段' });
    }
  }
  if (p['kind'] !== kind) {
    errors.push({ field: 'payload.kind', message: '记录类型与内容不一致' });
  }

  const str = (key: string): string => (typeof p[key] === 'string' ? (p[key] as string) : '');
  const optStr = (key: string): string | undefined => {
    const v = str(key).trim();
    return v === '' ? undefined : v;
  };
  const dec = (key: string, allowZero: boolean): string => {
    const r = validateDecimal(str(key), { allowZero });
    if (!r.ok) errors.push({ field: key, message: r.error });
    return r.ok ? r.value : '';
  };
  const text = (key: string, required: boolean, label: string): string => {
    const v = str(key);
    const err = validateText(v, label, required);
    if (err) errors.push({ field: key, message: err });
    return v;
  };
  const unitOf = (key: string, fallback: string): string => optStr(key) ?? fallback;

  let payload: RecordPayload;
  switch (kind) {
    case 'glucose':
      payload = {
        kind,
        value: dec('value', false),
        unit: unitOf('unit', 'mmol/L'),
        note: optStr('note'),
      };
      break;
    case 'blood_pressure':
      payload = {
        kind,
        systolic: dec('systolic', false),
        diastolic: dec('diastolic', false),
        unit: unitOf('unit', 'mmHg'),
        note: optStr('note'),
      };
      break;
    case 'weight':
      payload = { kind, value: dec('value', false), unit: unitOf('unit', 'kg') };
      break;
    case 'meal':
      payload = { kind, text: text('text', true, '饮食内容') };
      break;
    case 'water':
      payload = {
        kind,
        total: dec('total', true),
        unit: unitOf('unit', 'mL'),
        note: optStr('note'),
      };
      break;
    case 'exercise': {
      const duration = p['durationMinutes'];
      let durationMinutes: number | undefined;
      if (duration !== undefined && duration !== null) {
        if (typeof duration !== 'number' || !Number.isInteger(duration) || duration < 0) {
          errors.push({ field: 'durationMinutes', message: '时长需为非负整数（分钟）' });
        } else {
          durationMinutes = duration;
        }
      }
      payload = { kind, text: text('text', true, '运动内容'), durationMinutes };
      break;
    }
    case 'insulin': {
      const dose = optStr('dose');
      const doseUnit = optStr('doseUnit');
      if (dose && !doseUnit) errors.push({ field: 'doseUnit', message: '填写剂量时单位必填' });
      if (dose) {
        const r = validateDecimal(dose, { allowZero: false });
        if (!r.ok) errors.push({ field: 'dose', message: r.error });
      }
      payload = { kind, text: text('text', true, '原表内容文字'), name: optStr('name'), dose, doseUnit };
      break;
    }
    case 'day_note':
      payload = { kind, text: text('text', false, '日纪要') };
      break;
    case 'month_note':
      payload = { kind, text: text('text', false, '本月纪要') };
      break;
  }

  if (errors.length > 0) return { ok: false, errors };
  return { ok: true, payload };
}

/** 时点合法性；月纪要使用 monthly */
export function validateSlot(kind: RecordKind, slot: unknown): FieldError | null {
  if (typeof slot !== 'string' || slot.trim() === '') return { field: 'slot', message: '时点必填' };
  if (!ALLOWED_SLOTS[kind].includes(slot)) return { field: 'slot', message: `该记录类型不支持时点 ${slot}` };
  return null;
}

/** 周期键：日级 YYYY-MM-DD，月纪要 YYYY-MM */
export function validatePeriodKey(kind: RecordKind, periodKey: unknown): FieldError | null {
  if (typeof periodKey !== 'string') return { field: 'periodKey', message: '日期必填' };
  const dayRe = /^\d{4}-\d{2}-\d{2}$/;
  const monthRe = /^\d{4}-\d{2}$/;
  const ok = kind === 'month_note' ? monthRe.test(periodKey) : dayRe.test(periodKey);
  if (!ok) return { field: 'periodKey', message: '日期格式不正确' };
  const parsed = new Date(kind === 'month_note' ? `${periodKey}-01T00:00:00Z` : `${periodKey}T00:00:00Z`);
  if (Number.isNaN(parsed.getTime())) return { field: 'periodKey', message: '日期不存在' };
  return null;
}

export const TEXT_LIMIT = TEXT_MAX_LENGTH;
export { isUniqueSlot };
