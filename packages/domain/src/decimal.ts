/** 十进制字符串规则（PRD §5 格式规则）：拒绝 NaN/Infinity/负数/非数值；12位有效数字、4位小数为技术上限 */

export type DecimalResult = { ok: true; value: string } | { ok: false; error: string };

/** 全角数字与全角小数点规范化；输入过程中的未完成小数保留（不在此处截断） */
export function normalizeFullWidth(input: string): string {
  return input
    .replace(/[０-９]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0xfee0))
    .replace(/．/g, '.')
    .trim();
}

/**
 * 校验并规范化十进制字符串。
 * - allowZero=false 时要求大于 0（饮水、运动时长等例外由调用方决定）
 * - 最多 12 位有效数字、4 位小数；超限明确报错，不截断、不四舍五入
 */
export function validateDecimal(
  raw: string,
  opts: { allowZero?: boolean; maxSignificant?: number; maxDecimals?: number } = {},
): DecimalResult {
  const { allowZero = false, maxSignificant = 12, maxDecimals = 4 } = opts;
  const s = normalizeFullWidth(raw);
  if (s === '') return { ok: false, error: '请输入数值' };
  if (/^-/.test(s)) return { ok: false, error: '不能为负数' };
  if (/[eE]/i.test(s)) return { ok: false, error: '不支持科学计数法' };
  if (Number.isNaN(Number(s))) return { ok: false, error: '请输入有效数字' };
  if (!/^\d+(\.\d+)?$/.test(s)) return { ok: false, error: '请输入十进制数值' };

  const [intPart, decPart = ''] = s.split('.');
  if (decPart.length > maxDecimals) {
    return { ok: false, error: `小数最多 ${maxDecimals} 位` };
  }
  const significant = (intPart!.replace(/^0+/, '') + decPart.replace(/0+$/, '')).replace(/\./g, '');
  const sigDigits = intPart!.replace(/^0+/, '').length + decPart.replace(/0+$/, '').length;
  if (sigDigits > maxSignificant) {
    return { ok: false, error: `最多 ${maxSignificant} 位有效数字` };
  }
  const num = Number(s);
  if (!Number.isFinite(num)) return { ok: false, error: '数值超出范围' };
  if (num === 0 && !allowZero) return { ok: false, error: '数值需大于 0' };

  // 规范化输出：去掉多余前导零，保留原始精度
  const normalized = s.replace(/^0+(?=\d)/, '');
  void significant;
  return { ok: true, value: normalized };
}

/** 文本上限 4000 字符（PRD §5），服务器同规则校验 */
export const TEXT_MAX_LENGTH = 4000;

export function validateText(raw: string, label: string, required: boolean): string | null {
  if (required && raw.trim() === '') return `请填写${label}`;
  if (raw.length > TEXT_MAX_LENGTH) return `${label}最多 ${TEXT_MAX_LENGTH} 字，当前 ${raw.length} 字`;
  return null;
}

/** 运动时长：非负整数，可空 */
export function validateDuration(raw: string): number | null | string {
  if (raw.trim() === '') return null;
  const s = normalizeFullWidth(raw);
  if (!/^\d+$/.test(s)) return '时长需为非负整数（分钟）';
  const n = Number(s);
  if (!Number.isInteger(n) || n < 0) return '时长需为非负整数（分钟）';
  return n;
}
