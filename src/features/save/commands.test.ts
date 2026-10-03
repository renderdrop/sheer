import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { ChangeSet } from '../../api/annotations';
import type { SaveResult } from '../../api/save';
import { useAnnotations } from '../../stores/annotations';
import { useDocuments } from '../../stores/documents';
import { useUi } from '../../stores/ui';
import { needsSavePrompt, saveNow } from './commands';
import { useSave } from './state';

const api = vi.hoisted(() => ({ saveDocument: vi.fn(), saveDocumentAs: vi.fn() }));
vi.mock('../../api/save', () => api);

const HISTORY = { canUndo: false, canRedo: false, undoLabel: null, redoLabel: null, dirty: false };
const changes: ChangeSet = { rev: 5, upserted: [], removed: [], pages: null, history: HISTORY };

function result(name: string): SaveResult {
  return {
    rev: 5,
    mode: 'incremental',
    backupCreated: false,
    document: { id: 1, pageCount: 1, displayName: name, kind: 'user' },
    changes,
  };
}

function open(kind: 'user' | 'welcome', dirty: boolean): void {
  useDocuments.getState().add({ id: 1, pageCount: 1, displayName: 'a.pdf', kind });
  useAnnotations.getState().applyChanges(1, { ...changes, rev: 1, history: { ...HISTORY, dirty } });
}

beforeEach(() => {
  useDocuments.setState({ byId: {}, order: [], activeId: null });
  useAnnotations.setState({ byDoc: {} });
  useUi.setState({ banner: null });
  useSave.setState({ saving: {}, prompt: null });
  api.saveDocument.mockReset();
  api.saveDocumentAs.mockReset();
});

describe('needsSavePrompt', () => {
  it('asks for a document with unsaved changes, never for a clean one or the welcome document', () => {
    open('user', true);
    expect(needsSavePrompt(1)).toBe(true);
    open('user', false);
    expect(needsSavePrompt(1)).toBe(false);
    open('welcome', true);
    expect(needsSavePrompt(1)).toBe(false);
    expect(needsSavePrompt(9)).toBe(false);
  });
});

describe('saveNow', () => {
  it('saves in place, takes the change set and the document the backend answers with', async () => {
    open('user', true);
    api.saveDocument.mockResolvedValue(result('a.pdf'));
    expect(await saveNow(1)).toBe(true);
    expect(useAnnotations.getState().byDoc[1]?.history.dirty).toBe(false);
    expect(useSave.getState().saving).toEqual({});
  });

  it('goes to Save As for the welcome document and when the backend says read_only', async () => {
    open('welcome', false);
    api.saveDocumentAs.mockResolvedValue(result('mine.pdf'));
    expect(await saveNow(1)).toBe(true);
    expect(api.saveDocument).not.toHaveBeenCalled();
    expect(useDocuments.getState().byId[1]?.displayName).toBe('mine.pdf');

    open('user', true);
    api.saveDocument.mockRejectedValue({ code: 'read_only', key: 'error.read_only', retryable: false });
    expect(await saveNow(1)).toBe(true);
    expect(api.saveDocumentAs).toHaveBeenCalledTimes(2);
  });

  it('is false for a cancelled dialog and shows the banner for a failure', async () => {
    open('user', true);
    api.saveDocumentAs.mockResolvedValue(null);
    expect(await saveNow(1, true)).toBe(false);
    expect(useUi.getState().banner).toBeNull();
    api.saveDocument.mockRejectedValue({ code: 'save_failed', key: 'error.save_failed', retryable: true });
    expect(await saveNow(1)).toBe(false);
    expect(useUi.getState().banner?.code).toBe('save_failed');
    expect(useAnnotations.getState().byDoc[1]?.history.dirty).toBe(true);
  });
});
