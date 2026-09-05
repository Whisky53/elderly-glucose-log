import { describe, expect, it } from 'vitest';
import {
  FIELD_GROUPS,
  findGroupOfKind,
  findSlotDef,
  isUniqueSlot,
} from '../src/fields';
import { addDays, daysInMonth, firstWeekdayOfMonth, isFutureDate, monthKeyOf } from '../src/dates';
import { bloodPressureNeedsConfirm, formFieldsFromPayload, validateForm } from '../src/validation';

describe('字段模型（A01 基础）', () => {
  it('血糖 7 时点 + 临时测量，分组顺序固定', () => {
    const g = FIELD_GROUPS[0]!;
    expect(g.id).toBe('glucose');
    expect(g.slots.length).toBe(8);
    expect(g.slots.map((s) => s.label)).toEqual([
      '空腹', '早餐后2小时', '午餐前', '午餐后2小时', '晚餐前', '晚餐后2小时', '睡前', '临时测量',
    ]);
    expect(FIELD_GROUPS.map((g) => g.label)).toEqual([
      '血糖', '血压', '体重', '饮食与饮水', '运动', '胰岛素', '日纪要',
    ]);
  });

  it('唯一槽位判定', () => {
    expect(isUniqueSlot('meal')).toBe(true);
    expect(isUniqueSlot('water')).toBe(true);
    expect(isUniqueSlot('glucose')).toBe(false);
  });

  it('按 kind/slot 查找', () => {
    expect(findSlotDef('glucose', 'lunch_2h')?.label).toBe('午餐后2小时');
    expect(findGroupOfKind('insulin')?.label).toBe('胰岛素');
  });
});

describe('validateForm（A03/A06/A08/A12 基础）', () => {
  it('血糖：数值+单位必填，可选时间与备注', () => {
    const r = validateForm('glucose', { value: '6.8', unit: 'mmol/L' });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.payload).toMatchObject({ kind: 'glucose', value: '6.8', unit: 'mmol/L' });
    expect(validateForm('glucose', { value: '', unit: 'mmol/L' }).ok).toBe(false);
  });

  it('血压：成对校验；收缩压<舒张压需确认', () => {
    const ok = validateForm('blood_pressure', { systolic: '120', diastolic: '80' });
    expect(ok.ok).toBe(true);
    const abnormal = validateForm('blood_pressure', { systolic: '70', diastolic: '110' });
    expect(abnormal.ok).toBe(false);
    const confirmed = validateForm(
      'blood_pressure',
      { systolic: '70', diastolic: '110' },
      { confirmAbnormalBP: true },
    );
    expect(confirmed.ok).toBe(true);
    expect(bloodPressureNeedsConfirm('120', '80')).toBe(false);
  });

  it('只填收缩压时指向缺少项', () => {
    const r = validateForm('blood_pressure', { systolic: '120', diastolic: '' });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.errors.some((e) => e.field === 'diastolic')).toBe(true);
  });

  it('胰岛素：原文必填；剂量有值时单位必填；不推算剂量', () => {
    const onlyText = validateForm('insulin', { text: '门冬胰岛素 8单位 晚餐前' });
    expect(onlyText.ok).toBe(true);
    const noUnit = validateForm('insulin', { text: 'x', dose: '8' });
    expect(noUnit.ok).toBe(false);
    if (!noUnit.ok) expect(noUnit.errors.find((e) => e.field === 'doseUnit')).toBeTruthy();
  });

  it('饮水：允许 0 并保留', () => {
    const r = validateForm('water', { total: '0', unit: 'mL' });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.payload).toMatchObject({ total: '0' });
  });

  it('时间 unknown：occurredAt 为空合法；错误时间被拒绝', () => {
    expect(validateForm('glucose', { value: '5', unit: 'mmol/L' })).toMatchObject({ ok: true });
    const bad = validateForm('glucose', { value: '5', unit: 'mmol/L', occurredAt: 'not-a-time' });
    expect(bad.ok).toBe(false);
  });

  it('payload 还原为表单字段（修改不产生第三条）', () => {
    const r = validateForm('insulin', { text: '原文', name: '甘精', dose: '10', doseUnit: '单位' });
    if (!r.ok) throw new Error('should pass');
    const f = formFieldsFromPayload(r.payload);
    expect(f['dose']).toBe('10');
    expect(f['doseUnit']).toBe('单位');
  });
});

describe('日期规则（A04 基础）', () => {
  it('小月/闰年天数正确', () => {
    expect(daysInMonth('2026-02')).toBe(28);
    expect(daysInMonth('2028-02')).toBe(29);
    expect(daysInMonth('2026-04')).toBe(30);
    expect(daysInMonth('2026-08')).toBe(31);
  });

  it('补记过去合法，未来日期被标记', () => {
    const today = '2026-09-05';
    expect(isFutureDate(addDays(today, 1))).toBe(true);
    expect(isFutureDate(addDays(today, -1))).toBe(false);
    expect(monthKeyOf('2026-09-05')).toBe('2026-09');
  });

  it('月末跨月连续加天', () => {
    expect(addDays('2026-02-28', 1)).toBe('2026-03-01');
  });

  it('月表起始星期', () => {
    expect(typeof firstWeekdayOfMonth('2026-09')).toBe('number');
  });
});
