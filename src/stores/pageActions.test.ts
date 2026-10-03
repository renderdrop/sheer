import { beforeEach, describe, expect, it, vi } from 'vitest';

import * as api from '../api/annotations';
import type { ChangeSet } from '../api/annotations';
import { EMPTY_HISTORY, isDirty, useAnnotations } from './annotations';
import { applyPageCommand, undoPageStep } from './pageActions';

vi.mock('../api/annotations');

const mocked = vi.mocked(api);

const slot = { id: 0, width: 612, height: 792, rotation: 90, rev: 1, label: null, origin: 'file' } as const;
const rotated = (dirty: boolean): ChangeSet => ({
  rev: dirty ? 1 : 2,
  upserted: [],
  removed: [],
  pages: [slot],
  history: { ...EMPTY_HISTORY, canUndo: dirty, canRedo: !dirty, dirty },
});

beforeEach(() => {
  vi.resetAllMocks();
  useAnnotations.setState({ byDoc: {} });
});

describe('page commands and the unsaved state', () => {
  it('a page command makes the document edited, and undoing it makes it clean again', async () => {
    expect(isDirty(useAnnotations.getState(), 1)).toBe(false);
    mocked.applyCommand.mockResolvedValueOnce(rotated(true));
    await applyPageCommand(1, { type: 'rotatePages', pages: [0], quarterTurns: 1 });
    expect(isDirty(useAnnotations.getState(), 1)).toBe(true);
    mocked.undo.mockResolvedValueOnce(rotated(false));
    await undoPageStep(1);
    expect(isDirty(useAnnotations.getState(), 1)).toBe(false);
  });
});
