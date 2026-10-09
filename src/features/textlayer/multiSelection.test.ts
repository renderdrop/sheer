import { afterEach, describe, expect, it, vi } from 'vitest';

import type { AnnotationDraft } from '../../api/annotations';
import { createCommand } from './comment';
import {
  mergeRanges,
  ordered,
  piecesOf,
  primaryHeld,
  useMultiSelection,
  type PageSource,
  type TextSpan,
} from './multiSelection';
import { useSettings } from '../../stores/settings';

/** Three pages with ids 10, 11, 12 in that order, 100 characters each. */
const source: PageSource = {
  position: (page) => (page >= 10 && page <= 12 ? page - 10 : null),
  pageAt: (position) => (position >= 0 && position <= 2 ? position + 10 : null),
  lengthOf: () => 100,
};

const span = (a: [number, number], b: [number, number]): TextSpan => ({
  start: { page: a[0], index: a[1] },
  end: { page: b[0], index: b[1] },
});

afterEach(() => {
  useMultiSelection.getState().clear();
  vi.restoreAllMocks();
});

describe('multi-selection (F20.7)', () => {
  it('orders a range in reading order and drops an empty one', () => {
    expect(ordered({ page: 11, index: 5 }, { page: 10, index: 9 }, source.position)).toEqual(span([10, 9], [11, 5]));
    expect(ordered({ page: 10, index: 5 }, { page: 10, index: 5 }, source.position)).toBeNull();
    expect(ordered({ page: 99, index: 0 }, { page: 10, index: 1 }, source.position)).toBeNull();
  });

  it('merges overlapping and touching ranges of a page', () => {
    expect(
      mergeRanges([
        [30, 40],
        [0, 10],
        [10, 20],
        [35, 50],
        [60, 60],
      ]),
    ).toEqual([
      [0, 20],
      [30, 50],
    ]);
  });

  it('cuts separate ranges into one piece per page in page order with all its ranges', () => {
    const pieces = piecesOf([span([12, 5], [12, 9]), span([10, 1], [10, 4]), span([10, 50], [11, 20])], source);
    expect(pieces).toEqual([
      {
        page: 10,
        ranges: [
          [1, 4],
          [50, 100],
        ],
      },
      { page: 11, ranges: [[0, 20]] },
      { page: 12, ranges: [[5, 9]] },
    ]);
  });

  it('pins ranges per document, without doubles, and pops the newest', () => {
    const store = useMultiSelection.getState();
    store.add(1, span([10, 0], [10, 3]));
    store.add(1, span([10, 0], [10, 3]));
    store.add(1, span([11, 0], [11, 3]));
    expect(useMultiSelection.getState().spans).toHaveLength(2);
    expect(useMultiSelection.getState().pop()).toEqual(span([11, 0], [11, 3]));
    // Another document starts over.
    useMultiSelection.getState().add(2, span([10, 5], [10, 6]));
    expect(useMultiSelection.getState()).toMatchObject({ docId: 2, spans: [span([10, 5], [10, 6])] });
    useMultiSelection.getState().clear();
    expect(useMultiSelection.getState().spans).toEqual([]);
  });

  it('takes Ctrl as the modifier, Cmd on macOS', () => {
    useSettings.setState({ platform: 'windows' });
    expect(primaryHeld({ ctrlKey: true, metaKey: false })).toBe(true);
    expect(primaryHeld({ ctrlKey: false, metaKey: true })).toBe(false);
    useSettings.setState({ platform: 'macos' });
    expect(primaryHeld({ ctrlKey: false, metaKey: true })).toBe(true);
    expect(primaryHeld({ ctrlKey: true, metaKey: false })).toBe(false);
  });

  it('makes one annotation for one page and a group for several', () => {
    const draft = (pageId: number): AnnotationDraft => ({
      kind: 'highlight',
      pageId,
      color: [255, 235, 0],
      quads: [
        [
          { x: 0, y: 0 },
          { x: 1, y: 0 },
          { x: 0, y: 1 },
          { x: 1, y: 1 },
        ],
      ],
    });
    expect(createCommand([])).toBeNull();
    expect(createCommand([draft(10)])).toEqual({ type: 'createAnnotation', draft: draft(10) });
    expect(createCommand([draft(10), draft(12)])).toEqual({
      type: 'createAnnotationGroup',
      drafts: [draft(10), draft(12)],
    });
  });
});
