import { describe, expect, it } from 'vitest';

import { MODES } from '../../stores/ui';
import {
  FIT_START,
  fitOnResize,
  hiddenIds,
  hiddenInGroups,
  keyOfMode,
  modeAfterKey,
  modeOfKey,
  movableIn,
  tighter,
} from './model';

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

describe('the group overflow (F21.9)', () => {
  const groups = [
    ['a1', 'a2', 'a3'],
    ['b1', 'b2', 'b3', 'b4'],
    ['c1', 'c2', 'c3', 'c4'],
  ];

  it('may move all but one tool of every group', () => {
    expect(movableIn(groups)).toBe(2 + 3 + 3);
    expect(movableIn([['x']])).toBe(0);
  });

  it('takes the trailing tool of the fullest group, the rightmost of equals, never the active tool', () => {
    expect([...hiddenInGroups(groups, null, 1)]).toEqual(['c4']);
    expect([...hiddenInGroups(groups, null, 2)]).toEqual(['c4', 'b4']);
    expect([...hiddenInGroups(groups, null, 3)]).toEqual(['c4', 'b4', 'c3']);
    expect([...hiddenInGroups(groups, 'c4', 1)]).toEqual(['c3']);
    expect(hiddenInGroups(groups, null, 0).size).toBe(0);
  });

  it('keeps one tool in every group, the active one where it is in the group', () => {
    const all = hiddenInGroups(groups, 'b1', 100);
    expect(all.size).toBe(movableIn(groups));
    expect(all.has('b1')).toBe(false);
    expect(['a1', 'b1', 'c1'].every((id) => !all.has(id))).toBe(true);
  });
});

describe('fitOnResize (DESIGN Q6 hysteresis)', () => {
  const two = { step: 2, hidden: 0 } as const;
  const three = { step: 3, hidden: 2 } as const;

  it('keeps step 1 and a shrinking row as they are', () => {
    expect(fitOnResize(FIT_START, null, 500, 600)).toBe(FIT_START);
    expect(fitOnResize(two, 700, 600, 650)).toBe(two);
  });

  it('returns to step 1 only when 8 px wider than the full row needs', () => {
    expect(fitOnResize(two, 700, 707, 690)).toBe(two);
    expect(fitOnResize(two, 700, 708, 690)).toEqual(FIT_START);
  });

  it('a growing row at step 3 gives items back through step 2', () => {
    expect(fitOnResize(three, 700, 500, 450)).toEqual(two);
    expect(fitOnResize(three, 700, 450, 450)).toBe(three);
  });
});
