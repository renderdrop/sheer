// @vitest-environment jsdom
import { act, cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { ChangeSet } from '../../api/annotations';
import { useAnnotations } from '../../stores/annotations';
import { useDocuments } from '../../stores/documents';
import { useSettings } from '../../stores/settings';
import { saveNow } from '../save/commands';
import { useSave } from '../save/state';
import { AuthorPromptField } from './AuthorPromptField';
import { useAuthorPrompt } from './state';

const api = vi.hoisted(() => ({ saveDocument: vi.fn(), saveDocumentAs: vi.fn(), updateSettings: vi.fn() }));
vi.mock('../../api/save', () => api);
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
  useDocuments.setState({ byId: {}, order: [], activeId: null });
  useDocuments.getState().add({ id: 1, pageCount: 1, displayName: 'a.pdf', kind: 'user' });
  useAnnotations.setState({ byDoc: {} });
  useAnnotations.getState().applyChanges(1, changes);
  useSave.setState({ saving: {}, prompt: null });
  useAuthorPrompt.setState({ open: false });
  useSettings.setState({ loaded: true, authorName: '', authorPrompt: 'pending', authorSuggestion: 'user' });
  api.saveDocument.mockReset().mockResolvedValue(saved);
  api.saveDocumentAs.mockReset();
  api.updateSettings.mockReset().mockImplementation((patch: object) =>
    Promise.resolve({
      glass: 'auto',
      theme: 'system',
      language: 'system',
      leftPanelWidth: 248,
      welcomeTour: 'pending',
      authorName: '',
      authorPrompt: 'pending',
      ...patch,
    }),
  );
});
afterEach(cleanup);

describe('the author prompt on the first save', () => {
  it('shows the field pre-filled with the suggestion and saves after Confirm, storing the name', async () => {
    render(<AuthorPromptField />);
    const user = userEvent.setup();
    const pending = saveNow(1);
    const field = await screen.findByRole('textbox');
    expect((field as HTMLInputElement).value).toBe('user');
    expect(api.saveDocument).not.toHaveBeenCalled();
    await user.clear(field);
    await user.type(field, 'Ada');
    await user.click(screen.getByRole('button', { name: 'Use name' }));
    expect(await pending).toBe(true);
    expect(api.updateSettings).toHaveBeenCalledWith({ authorName: 'Ada', authorPrompt: 'done' });
    expect(screen.queryByRole('textbox')).toBeNull();
  });

  it('Skip and Esc keep the author empty and still save', async () => {
    render(<AuthorPromptField />);
    const user = userEvent.setup();
    const first = saveNow(1);
    await user.click(await screen.findByRole('button', { name: 'Skip' }));
    expect(await first).toBe(true);
    expect(api.updateSettings).toHaveBeenCalledWith({ authorPrompt: 'done' });

    await waitFor(() => expect(useSettings.getState().authorPrompt).toBe('done'));
    api.updateSettings.mockClear();
    useSettings.setState({ authorName: '', authorPrompt: 'pending' });
    useAnnotations.getState().applyChanges(1, { ...changes, rev: 9 });
    const second = saveNow(1);
    await screen.findByRole('textbox');
    await user.keyboard('{Escape}');
    expect(await second).toBe(true);
    expect(api.updateSettings).toHaveBeenCalledWith({ authorPrompt: 'done' });
  });

  it('does not ask when done, when a name is set, when the settings are not loaded or the document has no annotations', async () => {
    for (const state of [{ authorPrompt: 'done' as const }, { authorName: 'Ada' }, { loaded: false }]) {
      useSettings.setState(state);
      expect(await saveNow(1)).toBe(true);
      expect(useAuthorPrompt.getState().open).toBe(false);
      useSettings.setState({ loaded: true, authorName: '', authorPrompt: 'pending' });
    }
    useAnnotations.setState({ byDoc: {} });
    expect(await saveNow(1)).toBe(true);
    expect(useAuthorPrompt.getState().open).toBe(false);
    await act(async () => {});
  });
});
