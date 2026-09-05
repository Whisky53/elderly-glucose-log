/** 日期规则（PRD §4.3/§5）：默认今天、允许补记过去、默认禁止未来日期、跨午夜不改变正在编辑的日期 */

export function todayKey(): string {
  const d = new Date();
  return localDateKey(d);
}

export function localDateKey(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

export function monthKeyOf(dateKey: string): string {
  return dateKey.slice(0, 7);
}

export function isValidDateKey(s: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) return false;
  const d = new Date(s + 'T00:00:00');
  return !Number.isNaN(d.getTime()) && localDateKey(d) === s;
}

export function addDays(dateKey: string, delta: number): string {
  const d = new Date(dateKey + 'T12:00:00');
  d.setDate(d.getDate() + delta);
  return localDateKey(d);
}

export function isFutureDate(dateKey: string): boolean {
  return dateKey > todayKey();
}

export function daysInMonth(monthKey: string): number {
  const [y, m] = monthKey.split('-').map(Number);
  return new Date(y!, m!, 0).getDate();
}

export function formatDateCn(dateKey: string): string {
  const [, m, d] = dateKey.split('-').map(Number);
  return `${m}月${d}日`;
}

export function weekdayCn(dateKey: string): string {
  const names = ['日', '一', '二', '三', '四', '五', '六'];
  const d = new Date(dateKey + 'T12:00:00');
  return `周${names[d.getDay()]!}`;
}

/** 一个月的第一天是周几（0=周日），用于月表布局 */
export function firstWeekdayOfMonth(monthKey: string): number {
  return new Date(`${monthKey}-01T12:00:00`).getDay();
}
