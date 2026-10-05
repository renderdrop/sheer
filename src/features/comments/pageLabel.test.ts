import { describe, expect, it, vi } from 'vitest';

const slots = vi.hoisted(() => ({ list: [] as { id: number; label: string | null }[] }));
vi.mock('../../stores/pages', () => ({
  readSlots: () => slots.list,
  pageNumberOf: (_doc: number, pageId: number) => pageId + 1,
}));

import { pageLabelOf } from './pageLabel';

describe('pageLabelOf', () => {
  it('uses the page label of the file, else the page number', () => {
    slots.list = [
      { id: 0, label: 'xii' },
      { id: 1, label: null },
      { id: 2, label: ' ' },
    ];
    expect(pageLabelOf(1, 0)).toBe('xii');
    expect(pageLabelOf(1, 1)).toBe('2');
    expect(pageLabelOf(1, 2)).toBe('3');
    expect(pageLabelOf(1, 9)).toBe('10');
  });
});
