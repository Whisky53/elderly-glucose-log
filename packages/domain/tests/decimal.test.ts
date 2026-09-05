import { describe, expect, it } from 'vitest';
import { normalizeFullWidth, validateDecimal, validateDuration, validateText } from '../src/decimal';

describe('validateDecimal（A03 基础）', () => {
  it('接受有效十进制并保持精度不变', () => {
    expect(validateDecimal('5.60')).toEqual({ ok: true, value: '5.60' });
    expect(validateDecimal('100')).toEqual({ ok: true, value: '100' });
    expect(validateDecimal('0.5000')).toEqual({ ok: true, value: '0.5000' });
  });

  it('全角数字与全角小数点规范化', () => {
    expect(validateDecimal('５.６')).toEqual({ ok: true, value: '5.6' });
    expect(validateDecimal('７．２')).toEqual({ ok: true, value: '7.2' });
  });

  it('拒绝负数、字母、科学计数法、空值', () => {
    expect(validateDecimal('-3').ok).toBe(false);
    expect(validateDecimal('abc').ok).toBe(false);
    expect(validateDecimal('1e3').ok).toBe(false);
    expect(validateDecimal('').ok).toBe(false);
  });

  it('默认要求大于 0，allowZero 时 0 合法（饮水）', () => {
    expect(validateDecimal('0').ok).toBe(false);
    expect(validateDecimal('0', { allowZero: true })).toEqual({ ok: true, value: '0' });
  });

  it('小数超过 4 位报错，不截断', () => {
    expect(validateDecimal('1.12345').ok).toBe(false);
  });

  it('有效数字超过 12 位报错', () => {
    expect(validateDecimal('1234567890123').ok).toBe(false);
    expect(validateDecimal('123456789012').ok).toBe(true);
    expect(validateDecimal('0.000000000123456').ok).toBe(false);
  });

  it('前导零规范化但保留小数位', () => {
    expect(validateDecimal('007.50')).toEqual({ ok: true, value: '7.50' });
  });
});

describe('文本与时长', () => {
  it('4000 字边界：超长报错且报告当前字数，不截断', () => {
    expect(validateText('a'.repeat(4000), '纪要', false)).toBeNull();
    const err = validateText('a'.repeat(4001), '纪要', false);
    expect(err).toContain('4001');
  });

  it('必填文本空值报错', () => {
    expect(validateText('  ', '饮食内容', true)).toContain('请填写');
  });

  it('运动时长非负整数，可空', () => {
    expect(validateDuration('')).toBeNull();
    expect(validateDuration('30')).toBe(30);
    expect(validateDuration('-5')).toContain('非负整数');
    expect(validateDuration('1.5')).toContain('非负整数');
  });
});

describe('normalizeFullWidth', () => {
  it('混合全半角', () => {
    expect(normalizeFullWidth('１２３．４５')).toBe('123.45');
  });
});
