import { describe, expect, it } from 'vitest';

import { MAX_HISTORY_ENTRIES, parseHistoryList } from './annotations';

const item = (over: Record<string, unknown> = {}) => ({
  id: 3,
  labelKey: 'annotation.create',
  kind: 'annotation',
  page: 2,
  annotationId: 7,
  annotationKind: 'highlight',
  isTextEdit: false,
  ...over,
});

describe('parseHistoryList', () => {
  it('reads the wire shape, absent optional fields as null', () => {
    const list = parseHistoryList({
      entries: [item(), item({ id: 4, page: null, annotationId: undefined, annotationKind: null })],
      cursor: 1,
    });
    expect(list?.cursor).toBe(1);
    expect(list?.entries[1]).toMatchObject({ page: null, annotationId: null, annotationKind: null });
  });

  it('refuses a bad kind, a cursor outside the list, too many entries and non-objects', () => {
    expect(parseHistoryList({ entries: [item({ kind: 'x' })], cursor: 0 })).toBeNull();
    expect(parseHistoryList({ entries: [item()], cursor: 2 })).toBeNull();
    expect(parseHistoryList({ entries: [item({ id: -1 })], cursor: 0 })).toBeNull();
    expect(
      parseHistoryList({ entries: Array.from({ length: MAX_HISTORY_ENTRIES + 1 }, () => item()), cursor: 0 }),
    ).toBeNull();
    expect(parseHistoryList(null)).toBeNull();
    expect(parseHistoryList({ entries: 'x', cursor: 0 })).toBeNull();
  });
});
