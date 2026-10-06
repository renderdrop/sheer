import { beforeEach, describe, expect, it } from 'vitest';

import { HISTORY_DEPTH, isNear, useHistoryStore, type HistoryEntry } from './store';

const entry = (pageId: number, yPt = 0): HistoryEntry => ({ pageId, xPt: 0, yPt, zoom: 1, fit: 'none' });
const state = () => useHistoryStore.getState().byDoc[1];
const VIEWPORT = 800;

beforeEach(() => useHistoryStore.setState({ byDoc: {} }));

describe('history store', () => {
  it('pushes entries per document', () => {
    const { push } = useHistoryStore.getState();
    push(1, entry(0), VIEWPORT);
    push(1, entry(5), VIEWPORT);
    push(2, entry(9), VIEWPORT);
    expect(state()?.back.map((e) => e.pageId)).toEqual([0, 5]);
    expect(useHistoryStore.getState().byDoc[2]?.back).toHaveLength(1);
  });

  it('replaces the top entry when the new one is on the same page within one viewport', () => {
    const { push } = useHistoryStore.getState();
    push(1, entry(3, 0), VIEWPORT);
    push(1, entry(3, 400), VIEWPORT);
    expect(state()?.back).toEqual([entry(3, 400)]);
    push(1, entry(3, 400 + VIEWPORT), VIEWPORT);
    expect(state()?.back).toHaveLength(2);
    expect(isNear(entry(3, 0), entry(4, 0), VIEWPORT)).toBe(false);
  });

  it('holds 50 entries and drops the oldest', () => {
    const { push } = useHistoryStore.getState();
    for (let page = 0; page < HISTORY_DEPTH + 5; page += 1) push(1, entry(page), VIEWPORT);
    expect(state()?.back).toHaveLength(HISTORY_DEPTH);
    expect(state()?.back[0]?.pageId).toBe(5);
  });

  it('steps back and forward, and a push clears forward', () => {
    const { push, stepBack, stepForward } = useHistoryStore.getState();
    push(1, entry(1), VIEWPORT);
    push(1, entry(2), VIEWPORT);
    expect(stepBack(1, entry(7))?.pageId).toBe(2);
    expect(state()?.forward.map((e) => e.pageId)).toEqual([7]);
    expect(stepForward(1, entry(2))?.pageId).toBe(7);
    expect(state()?.back.map((e) => e.pageId)).toEqual([1, 2]);
    stepBack(1, entry(7));
    push(1, entry(4), VIEWPORT);
    expect(state()?.forward).toEqual([]);
  });

  it('has nothing to step to when empty', () => {
    expect(useHistoryStore.getState().stepBack(1, entry(0))).toBeNull();
    expect(useHistoryStore.getState().stepForward(1, entry(0))).toBeNull();
  });

  it('drops entries of deleted pages and keeps reordered ones (ids)', () => {
    const { push, stepBack, prune } = useHistoryStore.getState();
    push(1, entry(1), VIEWPORT);
    push(1, entry(2), VIEWPORT);
    push(1, entry(3), VIEWPORT);
    stepBack(1, entry(2));
    prune(1, new Set([3, 1]));
    expect(state()?.back.map((e) => e.pageId)).toEqual([1]);
    expect(state()?.forward).toEqual([]);
  });

  it('forgets a closed document', () => {
    useHistoryStore.getState().push(1, entry(1), VIEWPORT);
    useHistoryStore.getState().drop(1);
    expect(state()).toBeUndefined();
  });
});
