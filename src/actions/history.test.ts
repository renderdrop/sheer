// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import * as annotationsApi from '../api/annotations';
import type { ChangeSet, HistoryState } from '../api/annotations';
import type { DocumentInfo } from '../api/documents';
import { EMPTY_HISTORY, useAnnotations } from '../stores/annotations';
import { resetDocuments } from '../stores/documents.testutil';
import { useDocuments } from '../stores/documents';
import { useUi } from '../stores/ui';
import { canRunAction, runAction } from './dispatch';
import { handleKeyDown } from './keys';
import { getAction } from './registry';
import { readActionState } from './state';

vi.mock('../api/annotations');
const api = vi.mocked(annotationsApi);

const DOC: DocumentInfo = { id: 1, pageCount: 3, displayName: 'Report.pdf' };
const history = (extra: Partial<HistoryState> = {}): HistoryState => ({ ...EMPTY_HISTORY, ...extra });
const empty = (h: HistoryState): ChangeSet => ({ rev: 1, upserted: [], removed: [], pages: null, history: h });

function key(init: KeyboardEventInit): KeyboardEvent {
  return new KeyboardEvent('keydown', { bubbles: true, cancelable: true, ...init });
}

beforeEach(() => {
  vi.resetAllMocks();
  resetDocuments();
  useAnnotations.setState({ byDoc: {} });
  useUi.setState({ banner: null });
  api.undo.mockResolvedValue(empty(history()));
  api.redo.mockResolvedValue(empty(history()));
});

afterEach(() => {
  document.body.replaceChildren();
});

function openDocument(h: HistoryState = history()) {
  useDocuments.getState().add(DOC);
  useAnnotations.getState().applyChanges(DOC.id, empty(h));
}

describe('Undo and Redo as actions', () => {
  it('are in the registry with their shortcuts, in the Edit group', () => {
    expect(getAction('undo')).toMatchObject({ group: 'edit', menuBar: true });
    expect(getAction('redo')).toMatchObject({ group: 'edit', menuBar: true });
  });

  it('can run only with a document whose history has the step', () => {
    expect(canRunAction('undo')).toBe(false);
    openDocument();
    expect(canRunAction('undo')).toBe(false);
    expect(canRunAction('redo')).toBe(false);
    useAnnotations.getState().applyChanges(DOC.id, { ...empty(history({ canUndo: true })), rev: 2 });
    expect(canRunAction('undo')).toBe(true);
    expect(canRunAction('redo')).toBe(false);
    expect(readActionState()).toMatchObject({ canUndo: true, canRedo: false });
    useAnnotations.getState().applyChanges(DOC.id, { ...empty(history({ canRedo: true })), rev: 3 });
    expect(canRunAction('undo')).toBe(false);
    expect(canRunAction('redo')).toBe(true);
  });

  it('follow the active document', () => {
    openDocument(history({ canUndo: true }));
    useDocuments.getState().add({ ...DOC, id: 2 });
    expect(canRunAction('undo')).toBe(false);
    useDocuments.getState().setActive(1);
    expect(canRunAction('undo')).toBe(true);
  });

  it('run the backend step of the active document', async () => {
    openDocument(history({ canUndo: true, canRedo: true }));
    expect(runAction('undo')).toBe(true);
    expect(api.undo).toHaveBeenCalledWith(DOC.id);
    expect(runAction('redo')).toBe(true);
    expect(api.redo).toHaveBeenCalledWith(DOC.id);
    await vi.waitFor(() => expect(useAnnotations.getState().byDoc[DOC.id]?.rev).toBe(1));
  });

  it('show a failed step in the banner and leave the replica alone', async () => {
    openDocument(history({ canUndo: true }));
    api.undo.mockRejectedValue({ code: 'engine_unavailable', key: 'error.engine_unavailable', retryable: false });
    runAction('undo');
    await vi.waitFor(() => expect(useUi.getState().banner).not.toBeNull());
    expect(useAnnotations.getState().byDoc[DOC.id]?.history.canUndo).toBe(true);
  });

  it('go to the text field that has focus, not to the document (the macOS menu sends them there too)', () => {
    openDocument(history({ canUndo: true }));
    const field = document.createElement('input');
    document.body.append(field);
    field.focus();
    const exec = vi.fn(() => true);
    Object.defineProperty(document, 'execCommand', { value: exec, configurable: true });
    runAction('undo');
    expect(exec).toHaveBeenCalledWith('undo');
    expect(api.undo).not.toHaveBeenCalled();
  });
});

describe('the keys', () => {
  it('Ctrl+Z undoes on Windows and Cmd+Z on macOS', () => {
    openDocument(history({ canUndo: true }));
    expect(handleKeyDown(key({ key: 'z', code: 'KeyZ', ctrlKey: true }), 'windows')).toBe(true);
    expect(api.undo).toHaveBeenCalledTimes(1);
    expect(handleKeyDown(key({ key: 'z', code: 'KeyZ', metaKey: true }), 'macos')).toBe(true);
    expect(api.undo).toHaveBeenCalledTimes(2);
    // The wrong modifier for the platform is not the shortcut.
    expect(handleKeyDown(key({ key: 'z', code: 'KeyZ', ctrlKey: true }), 'macos')).toBe(false);
  });

  it('Ctrl+Y and Ctrl+Shift+Z redo on Windows, Cmd+Shift+Z on macOS', () => {
    openDocument(history({ canRedo: true }));
    expect(handleKeyDown(key({ key: 'y', code: 'KeyY', ctrlKey: true }), 'windows')).toBe(true);
    expect(handleKeyDown(key({ key: 'Z', code: 'KeyZ', ctrlKey: true, shiftKey: true }), 'windows')).toBe(true);
    expect(api.redo).toHaveBeenCalledTimes(2);
    expect(handleKeyDown(key({ key: 'Z', code: 'KeyZ', metaKey: true, shiftKey: true }), 'macos')).toBe(true);
    expect(api.redo).toHaveBeenCalledTimes(3);
    // Shift+Z is redo, never undo.
    expect(api.undo).not.toHaveBeenCalled();
  });

  it('take the key but do nothing while there is nothing to undo, and never from a text field', () => {
    openDocument();
    const event = key({ key: 'z', code: 'KeyZ', ctrlKey: true });
    expect(handleKeyDown(event, 'windows')).toBe(true);
    expect(event.defaultPrevented).toBe(true);
    expect(api.undo).not.toHaveBeenCalled();

    openDocument(history({ canUndo: true }));
    const field = document.createElement('textarea');
    document.body.append(field);
    const typed = key({ key: 'z', code: 'KeyZ', ctrlKey: true });
    field.dispatchEvent(typed);
    expect(handleKeyDown(typed, 'windows')).toBe(false);
    expect(api.undo).not.toHaveBeenCalled();
  });
});
