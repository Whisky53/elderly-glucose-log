import type { LocalRecord } from '@gms/contracts';
import { LOCAL_ACCOUNT } from './repo';

/** 虚构示例数据（PRD §10：测试只用虚构数据；用于评审趋势/月表，可一键载入与清除） */

function rec(
  id: string,
  dateKey: string,
  kind: LocalRecord['kind'],
  slot: string,
  payload: LocalRecord['payload'],
  occurredAt: string | null = null,
): LocalRecord {
  return {
    id,
    accountId: LOCAL_ACCOUNT,
    kind,
    periodKey: dateKey,
    slot,
    occurredAt,
    timePrecision: occurredAt ? 'minute' : 'unknown',
    timezone: 'Asia/Shanghai',
    payload,
    version: 1,
    createdAt: `${dateKey}T08:00:00.000Z`,
    updatedAt: `${dateKey}T08:00:00.000Z`,
    deletedAt: null,
  };
}

export function buildFictionalSeed(): LocalRecord[] {
  const out: LocalRecord[] = [];
  const glucoseValues = [
    '6.2', '8.5', '6.9', '9.8', '6.4', '10.2', '7.1',
    '6.0', '8.1', '7.4', '9.1', '6.8', '7.6', '6.5',
  ];
  glucoseValues.forEach((raw, i) => {
    const v = raw!;
    const dateKey = addDaysKey('2026-09-05', -i);
    out.push(rec(`seed-gl-${i}-0`, dateKey, 'glucose', 'fasting', { kind: 'glucose', value: v, unit: 'mmol/L' }, `${dateKey}T06:40`));
    out.push(rec(`seed-gl-${i}-1`, dateKey, 'glucose', 'breakfast_2h', { kind: 'glucose', value: (Number(v) + 2.5).toFixed(1), unit: 'mmol/L' }, `${dateKey}T08:40`));
    out.push(rec(`seed-gl-${i}-2`, dateKey, 'glucose', 'dinner_2h', { kind: 'glucose', value: (Number(v) + 1.8).toFixed(1), unit: 'mmol/L' }, `${dateKey}T19:30`));
    out.push(rec(`seed-bp-${i}`, dateKey, 'blood_pressure', 'fasting', { kind: 'blood_pressure', systolic: '132', diastolic: '84', unit: 'mmHg' }, `${dateKey}T07:00`));
    out.push(rec(`seed-wt-${i}`, dateKey, 'weight', 'morning', { kind: 'weight', value: (62.5 - i * 0.1).toFixed(1), unit: 'kg' }, `${dateKey}T07:10`));
    out.push(rec(`seed-meal-${i}-b`, dateKey, 'meal', 'breakfast', { kind: 'meal', text: '燕麦粥一碗，鸡蛋一个' }));
    if (i % 3 === 0) {
      out.push(rec(`seed-gl-re-${i}`, dateKey, 'glucose', 'fasting', { kind: 'glucose', value: (Number(v) + 0.3).toFixed(1), unit: 'mmol/L', note: '复测' }, `${dateKey}T07:10`));
    }
    if (i % 2 === 0) {
      out.push(rec(`seed-ex-${i}`, dateKey, 'exercise', 'daily', { kind: 'exercise', text: '晚饭后散步', durationMinutes: 30 }));
      out.push(rec(`seed-in-${i}`, dateKey, 'insulin', 'daily', { kind: 'insulin', text: '甘精胰岛素 10单位 睡前', name: '甘精胰岛素', dose: '10', doseUnit: '单位' }, `${dateKey}T22:00`));
    }
    out.push(rec(`seed-wa-${i}`, dateKey, 'water', 'daily', { kind: 'water', total: String(1500 + i * 50), unit: 'mL' }));
    if (i === 4) {
      out.push(rec('seed-dn-4', dateKey, 'day_note', 'daily', { kind: 'day_note', text: '今天头晕一次，休息后缓解。' }));
    }
  });
  out.push(rec('seed-mn-202609', '2026-09', 'month_note', 'monthly', { kind: 'month_note', text: '本月（虚构示例）整体血糖偏高，关注早餐后数值。' }));
  return out;
}

function addDaysKey(dateKey: string, delta: number): string {
  const d = new Date(dateKey + 'T12:00:00');
  d.setDate(d.getDate() + delta);
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}
