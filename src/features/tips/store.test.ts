import { beforeEach, describe, expect, it } from 'vitest';

import type { TipId } from './model';
import { useTips } from './store';

const A = 'draw' as TipId;
const B = 'highlight' as TipId;

beforeEach(() => useTips.getState().resetSession());

describe('the tips store', () => {
  it('counts each shown tip in the session', () => {
    useTips.getState().show(A);
    useTips.getState().dismiss();
    useTips.getState().show(B);
    expect(useTips.getState()).toMatchObject({ current: B, shownCount: 2 });
  });

  it('dismiss clears the visible tip and keeps the count; with none it changes nothing', () => {
    const before = useTips.getState();
    useTips.getState().dismiss();
    expect(useTips.getState()).toBe(before);
    useTips.getState().show(A);
    useTips.getState().dismiss();
    expect(useTips.getState()).toMatchObject({ current: null, shownCount: 1 });
  });

  it('resetSession starts afresh: no tip visible and none counted', () => {
    useTips.getState().show(A);
    useTips.getState().show(B);
    useTips.getState().resetSession();
    expect(useTips.getState()).toMatchObject({ current: null, shownCount: 0 });
  });
});
