// @vitest-environment jsdom
import { screen, waitFor } from '@testing-library/react';
import { MotionGlobalConfig } from 'motion/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { useAnnotations } from '../../stores/annotations';
import { useDocuments } from '../../stores/documents';
import { useUi } from '../../stores/ui';
import { setup } from '../../test/render';
import { saveNow } from './commands';
import { useSave } from './state';
import { UnsavedDialog } from './UnsavedDialog';

const api = vi.hoisted(() => ({ saveDocument: vi.fn(), saveDocumentAs: vi.fn() }));
vi.mock('../../api/save', () => api);

MotionGlobalConfig.skipAnimations = true;

const HISTORY = { canUndo: true, canRedo: false, undoLabel: null, redoLabel: null, dirty: true };

beforeEach(() => {
  useDocuments.setState({ byId: {}, order: [], activeId: null });
  useAnnotations.setState({ byDoc: {} });
  useUi.setState({ banner: null });
  useSave.setState({ saving: {}, prompt: null, saved: null, overwrite: null, rewrite: null, quit: null, answer: null });
  useDocuments.getState().add({ id: 1, pageCount: 1, displayName: 'a.pdf', kind: 'user' });
  useAnnotations.getState().applyChanges(1, { rev: 1, upserted: [], removed: [], pages: null, history: HISTORY });
  api.saveDocument.mockReset().mockRejectedValue({
    code: 'needs_confirmation',
    key: 'error.needs_confirmation',
    retryable: false,
    params: { what: 'rewriteEncrypted' },
  });
});

describe('the rewrite-protected-file dialog', () => {
  it('aborts the save when Cancel is pressed', async () => {
    const { user } = setup(<UnsavedDialog />);
    const saving = saveNow(1);
    await user.click(await screen.findByRole('button', { name: 'Cancel' }));
    expect(await saving).toBe(false);
    await waitFor(() => expect(useSave.getState().rewrite).toBeNull());
    expect(api.saveDocument).toHaveBeenCalledTimes(1);
    expect(useUi.getState().banner).toBeNull();
    expect(useAnnotations.getState().byDoc[1]?.history.dirty).toBe(true);
  });
});
