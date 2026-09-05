/**
 * API 与数据契约（02-工程架构设计 §4.1 records.payload 判别联合）。
 * 一期本地版仅使用其中的本地持久化部分；云端 API 契约在 T07 落地。
 */

/** 数值传输一律为十进制字符串，禁止二进制浮点改变原始精度 */
export type DecimalString = string;

export type GlucoseSlot =
  | 'fasting'
  | 'breakfast_2h'
  | 'lunch_pre'
  | 'lunch_2h'
  | 'dinner_pre'
  | 'dinner_2h'
  | 'bedtime';

export type BloodPressureSlot = 'fasting' | 'bedtime';
export type WeightSlot = 'morning' | 'evening';
export type MealSlot = 'breakfast' | 'lunch' | 'dinner';

export type RecordKind =
  | 'glucose'
  | 'blood_pressure'
  | 'weight'
  | 'meal'
  | 'water'
  | 'exercise'
  | 'insulin'
  | 'day_note'
  | 'month_note';

export type GlucosePayload = {
  kind: 'glucose';
  value: DecimalString;
  unit: string;
  note?: string;
};
export type BloodPressurePayload = {
  kind: 'blood_pressure';
  systolic: DecimalString;
  diastolic: DecimalString;
  unit: string;
  note?: string;
};
export type WeightPayload = { kind: 'weight'; value: DecimalString; unit: string };
export type MealPayload = { kind: 'meal'; text: string };
export type WaterPayload = { kind: 'water'; total: DecimalString; unit: string; note?: string };
export type ExercisePayload = { kind: 'exercise'; text: string; durationMinutes?: number };
export type InsulinPayload = {
  kind: 'insulin';
  text: string;
  name?: string;
  dose?: DecimalString;
  doseUnit?: string;
};
export type DayNotePayload = { kind: 'day_note'; text: string };
export type MonthNotePayload = { kind: 'month_note'; text: string };

export type RecordPayload =
  | GlucosePayload
  | BloodPressurePayload
  | WeightPayload
  | MealPayload
  | WaterPayload
  | ExercisePayload
  | InsulinPayload
  | DayNotePayload
  | MonthNotePayload;

export type TimePrecision = 'minute' | 'unknown';

/** 本地正式记录（与 records 表字段对齐；accountId 在云端版来自服务端身份） */
export type LocalRecord = {
  id: string;
  accountId: string;
  kind: RecordKind;
  /** 日级 YYYY-MM-DD；月纪要 YYYY-MM */
  periodKey: string;
  slot: string;
  occurredAt: string | null;
  timePrecision: TimePrecision;
  timezone: string;
  payload: RecordPayload;
  version: number;
  createdAt: string;
  updatedAt: string;
  deletedAt: string | null;
};

/** 同步状态：本地版只有 draft/pending（已保存到此设备，待同步）；synced 在云端接入后出现 */
export type SyncState = 'draft' | 'pending' | 'sending' | 'synced' | 'pending_retry' | 'conflict';

/** 本机草稿：编辑输入自动保存，仅此设备，不进入趋势/导出 */
export type LocalDraft = {
  /** 唯一键：periodKey:kind:slot[:entryId] */
  key: string;
  accountId: string;
  kind: RecordKind;
  periodKey: string;
  slot: string;
  /** 编辑已有记录时指向该记录 id；新建为空 */
  entryId: string | null;
  fields: Record<string, string>;
  updatedAt: string;
};

/** 字段级校验错误：422 定位字段 */
export type FieldError = { field: string; message: string };
