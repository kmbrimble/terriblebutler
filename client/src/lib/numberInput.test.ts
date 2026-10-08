import { describe, expect, it } from 'vitest';
import { numberOrZero } from './numberInput';

describe('numberOrZero', () => {
  it('turns a blank or junk box into an explicit 0 and keeps real numbers', () => {
    expect(numberOrZero('')).toBe(0);
    expect(numberOrZero('abc')).toBe(0);
    expect(numberOrZero('3')).toBe(3);
    expect(numberOrZero('2.5')).toBe(2.5);
  });
});
