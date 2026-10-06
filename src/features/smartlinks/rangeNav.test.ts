import { describe, expect, it } from 'vitest';

import { isDigit, moveCurrent, PAGE_ROWS, rowForDigits } from './rangeNav';

describe('moveCurrent', () => {
  it('moves by one without wrapping', () => {
    expect(moveCurrent('ArrowDown', 0, 3)).toBe(1);
    expect(moveCurrent('ArrowDown', 2, 3)).toBe(2);
    expect(moveCurrent('ArrowUp', 0, 3)).toBe(0);
    expect(moveCurrent('ArrowUp', 2, 3)).toBe(1);
  });

  it('goes to the ends and by pages of 12', () => {
    expect(moveCurrent('Home', 7, 20)).toBe(0);
    expect(moveCurrent('End', 7, 20)).toBe(19);
    expect(moveCurrent('PageDown', 2, 40)).toBe(2 + PAGE_ROWS);
    expect(moveCurrent('PageDown', 35, 40)).toBe(39);
    expect(moveCurrent('PageUp', 5, 40)).toBe(0);
    expect(moveCurrent('PageUp', 30, 40)).toBe(18);
  });

  it('ignores other keys', () => {
    expect(moveCurrent('a', 0, 3)).toBeNull();
  });
});

describe('rowForDigits', () => {
  const numbers = [3, 5, 12, 13, 40];
  it('prefers the exact number, then the first that starts with it', () => {
    expect(rowForDigits('5', numbers)).toBe(1);
    expect(rowForDigits('1', numbers)).toBe(2);
    expect(rowForDigits('13', numbers)).toBe(3);
    expect(rowForDigits('4', numbers)).toBe(4);
  });

  it('answers null for a number that is not listed', () => {
    expect(rowForDigits('7', numbers)).toBeNull();
    expect(rowForDigits('133', numbers)).toBeNull();
  });

  it('knows digits', () => {
    expect(isDigit('7')).toBe(true);
    expect(isDigit('a')).toBe(false);
    expect(isDigit('10')).toBe(false);
  });
});
