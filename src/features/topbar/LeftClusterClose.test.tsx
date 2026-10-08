// @vitest-environment jsdom
import { screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { resetDocuments } from '../../stores/documents.testutil';
import { useDocuments } from '../../stores/documents';
import { setup } from '../../test/render';
import { useSave } from '../save/state';
import { LeftCluster } from './LeftCluster';

const mocks = vi.hoisted(() => ({ dirty: false, close: vi.fn() }));
vi.mock('../save/commands', () => ({ needsSavePrompt: () => mocks.dirty, saveNow: vi.fn(), saveActive: vi.fn() }));
vi.mock('../viewer/useViewer', () => ({
  useViewer: {
    getState: () => ({
      close: () => {
        mocks.close();
        const { activeId, remove } = useDocuments.getState();
        if (activeId !== null) remove(activeId);
      },
    }),
  },
}));

beforeEach(() => {
  resetDocuments();
  mocks.dirty = false;
  mocks.close.mockClear();
  useDocuments.getState().add({ id: 1, pageCount: 1, displayName: 'Only.pdf' });
});

describe('closing the last document from the top bar', () => {
  it('leaves no document open (Home)', async () => {
    const { user } = setup(<LeftCluster />);
    await user.click(screen.getByRole('button', { name: 'Close Only.pdf' }));
    expect(mocks.close).toHaveBeenCalledTimes(1);
    expect(useDocuments.getState().order).toEqual([]);
  });

  it('a document with unsaved changes still asks first', async () => {
    mocks.dirty = true;
    const { user } = setup(<LeftCluster />);
    await user.click(screen.getByRole('button', { name: 'Close Only.pdf' }));
    expect(useSave.getState().prompt).toBe(1);
    expect(mocks.close).not.toHaveBeenCalled();
    expect(useDocuments.getState().order).toEqual([1]);
  });
});
