// @vitest-environment jsdom
import { act, cleanup, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { ChangeSet } from '../../api/annotations';
import { useAnnotations } from '../../stores/annotations';
import { useDocuments } from '../../stores/documents';
import { useSettings } from '../../stores/settings';
import { setup } from '../../test/render';
import { saveNow } from '../save/commands';
import { useSave } from '../save/state';
import { Shell } from '../shell/Shell';
import { useViewer } from '../viewer/useViewer';
import { resetViewer } from '../viewer/viewer.testutil';
import { askAuthorName, registerAuthorHost, useAuthorPrompt } from './state';

const api = vi.hoisted(() => ({ saveDocument: vi.fn(), saveDocumentAs: vi.fn(), updateSettings: vi.fn() }));
const renderApi = vi.hoisted(() => ({ renderPage: vi.fn(), setViewport: vi.fn(), getPageSizes: vi.fn() }));
vi.mock('../../api/save', () => api);
vi.mock('../../api/render', () => renderApi);
vi.mock('../../api/app', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../api/app')>()),
  updateSettings: api.updateSettings,
}));

const HISTORY = { canUndo: true, canRedo: false, undoLabel: null, redoLabel: null, dirty: true };
const changes: ChangeSet = { rev: 1, upserted: [], removed: [], pages: null, history: HISTORY };
const saved = {
  rev: 2,
  mode: 'incremental',
  backupCreated: false,
  document: { id: 1, pageCount: 1, displayName: 'a.pdf', kind: 'user' },
  changes: { ...changes, rev: 2, history: { ...HISTORY, dirty: false } },
};

beforeEach(() => {
  resetViewer();
  useViewer.setState({ viewport: { width: 900, height: 700 } });
  useDocuments.setState({ byId: {}, order: [], activeId: null });
  useDocuments.getState().add({ id: 1, pageCount: 1, displayName: 'a.pdf', kind: 'user' });
  useAnnotations.setState({ byDoc: {} });
  useAnnotations.getState().applyChanges(1, changes);
  useSave.setState({ saving: {}, prompt: null });
  useAuthorPrompt.setState({ open: false });
  useSettings.setState({ loaded: true, authorName: '', authorPrompt: 'pending', authorSuggestion: 'user' });
  renderApi.renderPage.mockReset().mockResolvedValue({ data: new Uint8Array([1]), width: 816, height: 1056 });
  renderApi.setViewport.mockReset().mockResolvedValue(undefined);
  renderApi.getPageSizes.mockReset().mockResolvedValue([]);
  URL.createObjectURL = vi.fn(() => 'blob:page');
  URL.revokeObjectURL = vi.fn();
  api.saveDocument.mockReset().mockResolvedValue(saved);
  api.saveDocumentAs.mockReset();
  api.updateSettings.mockReset().mockResolvedValue({});
});
afterEach(cleanup);

describe('the author prompt in the app shell (ADR-109)', () => {
  it('shows in the DOM when an annotated document is saved with an empty author, and Skip continues to the save', async () => {
    const { user } = setup(<Shell />);
    const pending = saveNow(1);
    expect(await screen.findByRole('dialog')).not.toBeNull();
    expect(api.saveDocument).not.toHaveBeenCalled();
    await user.click(screen.getByRole('button', { name: 'Skip' }));
    expect(await pending).toBe(true);
    expect(api.saveDocument).toHaveBeenCalledTimes(1);
    expect(useSave.getState().saving[1]).not.toBe(true);
  });

  it('Confirm continues to the save and stores the name', async () => {
    const { user } = setup(<Shell />);
    const pending = saveNow(1);
    await screen.findByRole('dialog');
    await user.click(screen.getByRole('button', { name: 'Use name' }));
    expect(await pending).toBe(true);
    expect(api.updateSettings).toHaveBeenCalledWith({ authorName: 'user', authorPrompt: 'done' });
  });
});

describe('a save never hangs on a missing prompt', () => {
  it('without a mounted host the save proceeds at once', async () => {
    expect(await saveNow(1)).toBe(true);
    expect(api.saveDocument).toHaveBeenCalledTimes(1);
    expect(useAuthorPrompt.getState().open).toBe(false);
    expect(useSave.getState().saving[1]).not.toBe(true);
  });

  it('a host that unmounts while a save waits releases it', async () => {
    const unregister = registerAuthorHost();
    const pending = saveNow(1);
    await waitFor(() => expect(useAuthorPrompt.getState().open).toBe(true));
    act(() => unregister());
    expect(await pending).toBe(true);
    expect(useAuthorPrompt.getState().open).toBe(false);
  });

  it('clears saving after a failure and after a cancelled Save As', async () => {
    useSettings.setState({ authorPrompt: 'done' });
    api.saveDocument.mockRejectedValueOnce({ code: 'io', message: 'x' });
    expect(await saveNow(1)).toBe(false);
    expect(useSave.getState().saving[1]).not.toBe(true);
    api.saveDocumentAs.mockResolvedValueOnce(null);
    expect(await saveNow(1, true)).toBe(false);
    expect(useSave.getState().saving[1]).not.toBe(true);
    expect(await saveNow(1)).toBe(true);
  });

  it('askAuthorName resolves at once without a host', async () => {
    await expect(askAuthorName()).resolves.toBeUndefined();
  });
});
