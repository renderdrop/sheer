import { describe, expect, it } from 'vitest';

import { MODES } from '../../stores/ui';
import { FIT_START, hiddenIds, keyOfMode, modeAfterKey, modeOfKey, tighter } from './model';

describe('the keys of the modes', () => {
  it('1 to 5 are Lesen, Kommentieren, Ausfüllen & Signieren, Seiten, Bearbeiten', () => {
    expect(['1', '2', '3', '4', '5'].map(modeOfKey)).toEqual(['read', 'comment', 'fill', 'pages', 'edit']);
    expect(MODES.map(keyOfMode)).toEqual(['1', '2', '3', '4', '5']);
  });

  it('every other key is none', () => {
    for (const key of ['0', '6', '9', 'a', 'Enter', '', '12', '١']) expect(modeOfKey(key)).toBeNull();
  });

  it('Left and Right wrap, Home and End jump, other keys are none', () => {
    expect(modeAfterKey('read', 'ArrowLeft')).toBe('edit');
    expect(modeAfterKey('edit', 'ArrowRight')).toBe('read');
    expect(modeAfterKey('fill', 'ArrowRight')).toBe('pages');
    expect(modeAfterKey('fill', 'ArrowLeft')).toBe('comment');
    expect(modeAfterKey('pages', 'Home')).toBe('read');
    expect(modeAfterKey('pages', 'End')).toBe('edit');
    expect(modeAfterKey('pages', 'ArrowDown')).toBeNull();
  });
});

describe('the three-step overflow', () => {
  it('gives up the labels first, then items from the right', () => {
    expect(tighter(FIT_START, 5)).toEqual({ step: 2, hidden: 0 });
    expect(tighter({ step: 2, hidden: 0 }, 5)).toEqual({ step: 3, hidden: 1 });
    expect(tighter({ step: 3, hidden: 1 }, 5)).toEqual({ step: 3, hidden: 2 });
    expect(tighter({ step: 3, hidden: 5 }, 5)).toBeNull();
  });

  it('has nothing left to give when only the active tool remains', () => {
    expect(tighter({ step: 2, hidden: 0 }, 0)).toBeNull();
  });

  it('lets items leave from the right and never the active tool', () => {
    const ids = ['a', 'b', 'c', 'd', 'e'];
    expect([...hiddenIds(ids, null, 2)]).toEqual(['e', 'd']);
    expect([...hiddenIds(ids, 'e', 2)]).toEqual(['d', 'c']);
    expect([...hiddenIds(ids, 'a', 10)]).toEqual(['e', 'd', 'c', 'b']);
    expect(hiddenIds(ids, null, 0).size).toBe(0);
  });
});
