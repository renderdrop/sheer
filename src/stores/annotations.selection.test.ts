import { beforeEach, describe, expect, it } from 'vitest';

import { useAnnotations } from './annotations';

const initial = useAnnotations.getState();

beforeEach(() => {
  useAnnotations.setState({ ...initial }, true);
});

describe('clearSelection', () => {
  it('empties the selection of one document and leaves the others', () => {
    useAnnotations.getState().select(1, [3, 4]);
    useAnnotations.getState().select(2, [5]);
    useAnnotations.getState().clearSelection(1);
    expect(useAnnotations.getState().selectedIds[1]).toEqual([]);
    expect(useAnnotations.getState().selectedIds[2]).toEqual([5]);
  });

  it('does not change the state when nothing is selected', () => {
    const before = useAnnotations.getState().selectedIds;
    useAnnotations.getState().clearSelection(7);
    expect(useAnnotations.getState().selectedIds).toBe(before);
  });
});
