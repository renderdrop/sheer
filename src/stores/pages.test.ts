import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { DEFAULT_PAGE_SIZE, placeholderSizes, sizesFor, usePages } from './pages';

const reset = () => usePages.setState({ byDoc: {} });

beforeEach(reset);
afterEach(reset);

describe('the page sizes store', () => {
  it('keeps the sizes of each document as the backend reported them', () => {
    usePages.getState().set(1, [
      [612, 792],
      [200, 100],
    ]);
    usePages.getState().set(2, [[595, 842]]);
    expect(usePages.getState().byDoc[1]).toEqual([
      [612, 792],
      [200, 100],
    ]);
    expect(usePages.getState().byDoc[2]).toEqual([[595, 842]]);
  });

  it('replaces the list as a whole, and forgets a closed document', () => {
    const { set, remove } = usePages.getState();
    set(1, [[1, 1]]);
    const second = [[2, 2]] as const;
    set(1, second);
    expect(usePages.getState().byDoc[1]).toBe(second);
    remove(1);
    expect(usePages.getState().byDoc).toEqual({});
    // Closing twice, or a document that was never there, changes nothing and tells nobody.
    let calls = 0;
    const stop = usePages.subscribe(() => (calls += 1));
    remove(1);
    remove(9);
    expect(calls).toBe(0);
    stop();
  });
});

describe('placeholder sizes', () => {
  it('are US Letter, one for each page', () => {
    expect(DEFAULT_PAGE_SIZE).toEqual([612, 792]);
    const sizes = placeholderSizes(3);
    expect(sizes).toEqual([DEFAULT_PAGE_SIZE, DEFAULT_PAGE_SIZE, DEFAULT_PAGE_SIZE]);
    expect(placeholderSizes(0)).toEqual([]);
    expect(placeholderSizes(-2)).toEqual([]);
    expect(placeholderSizes(2.9)).toHaveLength(2);
  });

  it('are the same list for the same count, so a layout made from them stays valid', () => {
    expect(placeholderSizes(500)).toBe(placeholderSizes(500));
    expect(placeholderSizes(500)).not.toBe(placeholderSizes(501));
  });
});

describe('sizesFor', () => {
  const state = (byDoc: Record<number, readonly (readonly [number, number])[]>) => ({ byDoc });

  it('is what the backend reported if it covers the document', () => {
    const reported = [
      [612, 792],
      [200, 100],
    ] as const;
    expect(sizesFor(state({ 1: reported }), 1, 2)).toBe(reported);
  });

  it('is placeholders until the sizes have arrived, for no document, and for a list that does not match the page count', () => {
    expect(sizesFor(state({}), 1, 3)).toBe(placeholderSizes(3));
    expect(sizesFor(state({ 1: [[1, 1]] }), null, 1)).toBe(placeholderSizes(1));
    expect(sizesFor(state({ 1: [[1, 1]] }), 1, 3)).toBe(placeholderSizes(3));
    expect(sizesFor(state({ 1: [[1, 1]] }), 2, 1)).toBe(placeholderSizes(1));
  });
});
