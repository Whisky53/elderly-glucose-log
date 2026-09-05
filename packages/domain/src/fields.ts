import type { RecordKind } from '@gms/contracts';

/** 分组顺序固定（PRD §4.1）：血糖、血压、体重、饮食与饮水、运动、胰岛素、一日纪要 */
export type GroupId =
  | 'glucose'
  | 'blood_pressure'
  | 'weight'
  | 'food_water'
  | 'exercise'
  | 'insulin'
  | 'day_note';

export type SlotDef = {
  kind: RecordKind;
  slot: string;
  label: string;
  /** 同一时点允许多条（复测/再记一次） */
  multi: boolean;
};

export type GroupDef = {
  id: GroupId;
  label: string;
  slots: SlotDef[];
};

export const GLUCOSE_SLOTS = [
  { slot: 'fasting', label: '空腹' },
  { slot: 'breakfast_2h', label: '早餐后2小时' },
  { slot: 'lunch_pre', label: '午餐前' },
  { slot: 'lunch_2h', label: '午餐后2小时' },
  { slot: 'dinner_pre', label: '晚餐前' },
  { slot: 'dinner_2h', label: '晚餐后2小时' },
  { slot: 'bedtime', label: '睡前' },
] as const;

export const FIELD_GROUPS: GroupDef[] = [
  {
    id: 'glucose',
    label: '血糖',
    slots: [
      ...GLUCOSE_SLOTS.map((s) => ({ kind: 'glucose' as const, slot: s.slot, label: s.label, multi: true })),
      { kind: 'glucose', slot: 'temporary', label: '临时测量', multi: true },
    ],
  },
  {
    id: 'blood_pressure',
    label: '血压',
    slots: [
      { kind: 'blood_pressure', slot: 'fasting', label: '空腹', multi: true },
      { kind: 'blood_pressure', slot: 'bedtime', label: '睡前', multi: true },
    ],
  },
  {
    id: 'weight',
    label: '体重',
    slots: [
      { kind: 'weight', slot: 'morning', label: '早', multi: true },
      { kind: 'weight', slot: 'evening', label: '晚', multi: true },
    ],
  },
  {
    id: 'food_water',
    label: '饮食与饮水',
    slots: [
      { kind: 'meal', slot: 'breakfast', label: '早餐', multi: false },
      { kind: 'meal', slot: 'lunch', label: '午餐', multi: false },
      { kind: 'meal', slot: 'dinner', label: '晚餐', multi: false },
      { kind: 'water', slot: 'daily', label: '当天饮水量', multi: false },
    ],
  },
  {
    id: 'exercise',
    label: '运动',
    slots: [{ kind: 'exercise', slot: 'daily', label: '当日运动', multi: true }],
  },
  {
    id: 'insulin',
    label: '胰岛素',
    slots: [{ kind: 'insulin', slot: 'daily', label: '当日胰岛素', multi: true }],
  },
  {
    id: 'day_note',
    label: '一日纪要',
    slots: [{ kind: 'day_note', slot: 'daily', label: '一日纪要', multi: false }],
  },
];

export function findSlotDef(kind: RecordKind, slot: string): SlotDef | undefined {
  for (const g of FIELD_GROUPS) {
    for (const s of g.slots) {
      if (s.kind === kind && s.slot === slot) return s;
    }
  }
  return undefined;
}

export function findGroupOfKind(kind: RecordKind): GroupDef | undefined {
  return FIELD_GROUPS.find((g) => g.slots.some((s) => s.kind === kind));
}

export const SLOT_LABEL_MAX = 24;

/** 唯一槽位（02-架构 §4.2）：饮食每餐、饮水当日累计、日纪要（月纪要在回看编辑） */
export const UNIQUE_SLOT_KINDS: ReadonlySet<RecordKind> = new Set(['meal', 'water', 'day_note', 'month_note']);

export function isUniqueSlot(kind: RecordKind): boolean {
  return UNIQUE_SLOT_KINDS.has(kind);
}

export const DEFAULT_UNITS = {
  glucose: 'mmol/L',
  bloodPressure: 'mmHg',
  weight: 'kg',
  water: 'mL',
} as const;

export const UNIT_OPTIONS = {
  glucose: ['mmol/L', 'mg/dL'],
  bloodPressure: ['mmHg'],
  weight: ['kg'],
  water: ['mL'],
} as const;
