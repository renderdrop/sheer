import { describe, expect, it } from 'vitest';

import { rovingTarget } from './roving';

const horizontal = { orientation: 'horizontal', wrap: false } as const;
const wrapping = { orientation: 'horizontal', wrap: true } as const;
const vertical = { orientation: 'vertical', wrap: true } as const;

describe('rovingTarget', () => {
  it('moves one item with the arrows of its orientation', () => {
    expect(rovingTarget('ArrowRight', 1, 4, horizontal)).toBe(2);
    expect(rovingTarget('ArrowLeft', 1, 4, horizontal)).toBe(0);
    expect(rovingTarget('ArrowDown', 1, 4, vertical)).toBe(2);
    expect(rovingTarget('ArrowUp', 1, 4, vertical)).toBe(0);
  });

  it('ignores the arrows of the other orientation', () => {
    expect(rovingTarget('ArrowDown', 1, 4, horizontal)).toBeNull();
    expect(rovingTarget('ArrowLeft', 1, 4, vertical)).toBeNull();
  });

  it('stops at the ends without wrap', () => {
    expect(rovingTarget('ArrowRight', 3, 4, horizontal)).toBeNull();
    expect(rovingTarget('ArrowLeft', 0, 4, horizontal)).toBeNull();
  });

  it('wraps around when asked to', () => {
    expect(rovingTarget('ArrowRight', 3, 4, wrapping)).toBe(0);
    expect(rovingTarget('ArrowLeft', 0, 4, wrapping)).toBe(3);
    expect(rovingTarget('ArrowDown', 3, 4, vertical)).toBe(0);
  });

  it('jumps with Home and End', () => {
    expect(rovingTarget('Home', 2, 4, horizontal)).toBe(0);
    expect(rovingTarget('End', 1, 4, horizontal)).toBe(3);
    expect(rovingTarget('Home', 0, 4, horizontal)).toBeNull();
    expect(rovingTarget('End', 3, 4, horizontal)).toBeNull();
  });

  it('starts from the ends when focus is not on an item', () => {
    expect(rovingTarget('ArrowRight', -1, 4, horizontal)).toBe(0);
    expect(rovingTarget('ArrowLeft', -1, 4, horizontal)).toBe(3);
  });

  it('ignores other keys and empty lists', () => {
    expect(rovingTarget('a', 1, 4, horizontal)).toBeNull();
    expect(rovingTarget('Enter', 1, 4, horizontal)).toBeNull();
    expect(rovingTarget('ArrowRight', -1, 0, horizontal)).toBeNull();
  });

  it('has nowhere to go with one item', () => {
    expect(rovingTarget('ArrowRight', 0, 1, wrapping)).toBeNull();
  });
});
