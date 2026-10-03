// @vitest-environment jsdom
import { act, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { ChangeSet } from '../../api/annotations';
import type { SaveResult } from '../../api/save';
import { useAnnotations } from '../../stores/annotations';
import { useDocuments } from '../../stores/documents';
import { resetDocuments } from '../../stores/documents.testutil';
import { useUi } from '../../stores/ui';
import { setup } from '../../test/render';
import { requestQuit } from './quit';
import { useSave } from './state';
import { UnsavedDialog } from './UnsavedDialog';

const api = vi.hoisted(() => ({ saveDocument: vi.fn(), saveDocumentAs: vi.fn() }));
const windowApi = vi.hoisted(() => ({ closeWindow: vi.fn() }));
const viewer = vi.hoisted(() => ({ close: vi.fn() }));
vi.mock('../../api/save', () => api);
vi.mock('../../api/window', () => windowApi);
vi.mock('../viewer/useViewer', () => ({ useViewer: { getState: () => ({ close: viewer.close }) } }));

const HISTORY = { canUndo: false, canRedo: false, undoLabel: null, redoLabel: null, dirty: false };
const changes = (rev: number, dirty: boolean): ChangeSet => ({
  rev,
  upserted: [],
  removed: [],
  pages: null,
  history: { ...HISTORY, dirty },
});

function addDocument(id: number, name: string, dirty: boolean): void {
  useDocuments.getState().add({ id, pageCount: 1, displayName: name, kind: 'user' });
  useAnnotations.getState().applyChanges(id, changes(1, dirty));
}

function saved(id: number): SaveResult {
  return {
    rev: 2,
    mode: 'incremental',
    backupCreated: false,
    document: { id, pageCount: 1, displayName: `${id}.pdf`, kind: 'user' },
    changes: changes(2, false),
  };
}

beforeEach(() => {
  resetDocuments();
  useAnnotations.setState({ byDoc: {}, selectedIds: {}, pageRevs: {} });
  useUi.setState({ banner: null });
  useSave.setState({ saving: {}, saved: null, prompt: null, quit: null, answer: null, overwrite: null });
  api.saveDocument.mockReset().mockImplementation((id: number) => Promise.resolve(saved(id)));
  windowApi.closeWindow.mockReset().mockResolvedValue(undefined);
  viewer.close.mockReset().mockImplementation(() => {
    const { activeId } = useDocuments.getState();
    if (activeId !== null) useDocuments.getState().remove(activeId);
  });
});

describe('quitting with unsaved documents', () => {
  it('closes the window at once when nothing is edited', async () => {
    addDocument(1, 'a.pdf', false);
    await requestQuit();
    expect(windowApi.closeWindow).toHaveBeenCalledTimes(1);
    expect(useDocuments.getState().order).toEqual([]);
  });

  it('asks one document at a time, activates each tab and shows the count', async () => {
    addDocument(1, 'a.pdf', true);
    addDocument(2, 'b.pdf', true);
    const { user } = setup(<UnsavedDialog />);
    const quit = requestQuit();
    expect(await screen.findByRole('dialog', { name: /a\.pdf.*\(1 of 2\)/ })).toBeTruthy();
    expect(useDocuments.getState().activeId).toBe(1);
    await user.click(screen.getByRole('button', { name: "Don't Save" }));
    expect(await screen.findByRole('dialog', { name: /b\.pdf.*\(2 of 2\)/ })).toBeTruthy();
    expect(useDocuments.getState().activeId).toBe(2);
    await user.click(screen.getByRole('button', { name: 'Save' }));
    await quit;
    expect(api.saveDocument).toHaveBeenCalledTimes(1);
    expect(api.saveDocument.mock.calls[0]?.[0]).toBe(2);
    expect(windowApi.closeWindow).toHaveBeenCalledTimes(1);
    expect(useDocuments.getState().order).toEqual([]);
  });

  it('stops at Cancel: everything stays open and the window stays', async () => {
    addDocument(1, 'a.pdf', true);
    addDocument(2, 'b.pdf', true);
    const { user } = setup(<UnsavedDialog />);
    const quit = requestQuit();
    await screen.findByRole('dialog');
    await user.click(screen.getByRole('button', { name: 'Cancel' }));
    await quit;
    expect(windowApi.closeWindow).not.toHaveBeenCalled();
    expect(useDocuments.getState().order).toEqual([1, 2]);
    expect(useSave.getState().quit).toBeNull();
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
  });

  it('stops when Esc is pressed', async () => {
    addDocument(1, 'a.pdf', true);
    const { user } = setup(<UnsavedDialog />);
    const quit = requestQuit();
    await screen.findByRole('dialog');
    await user.keyboard('{Escape}');
    await quit;
    expect(windowApi.closeWindow).not.toHaveBeenCalled();
  });

  it('stops when a save fails', async () => {
    addDocument(1, 'a.pdf', true);
    api.saveDocument.mockRejectedValue({ code: 'save_failed', key: 'error.save_failed', retryable: true });
    const { user } = setup(<UnsavedDialog />);
    const quit = requestQuit();
    await screen.findByRole('dialog');
    await user.click(screen.getByRole('button', { name: 'Save' }));
    await quit;
    expect(windowApi.closeWindow).not.toHaveBeenCalled();
    expect(useUi.getState().banner?.code).toBe('save_failed');
    expect(useDocuments.getState().order).toEqual([1]);
  });

  it('ignores a second request while the walk runs', async () => {
    addDocument(1, 'a.pdf', true);
    const { user } = setup(<UnsavedDialog />);
    const quit = requestQuit();
    await screen.findByRole('dialog');
    await requestQuit();
    expect(screen.getAllByRole('dialog')).toHaveLength(1);
    await user.click(screen.getByRole('button', { name: 'Cancel' }));
    await quit;
  });
});

describe('the retry count', () => {
  it('starts afresh after a walk that asked the user', async () => {
    addDocument(1, 'a.pdf', true);
    const { user } = setup(<UnsavedDialog />);
    const quit = requestQuit();
    await screen.findByRole('dialog');
    await user.click(screen.getByRole('button', { name: 'Cancel' }));
    await quit;
    useAnnotations.getState().applyChanges(1, changes(2, false));
    for (let i = 0; i < 10; i += 1) await requestQuit();
    expect(windowApi.closeWindow).toHaveBeenCalledTimes(10);
    await requestQuit();
    expect(windowApi.closeWindow).toHaveBeenCalledTimes(10);
  });
});

describe('the file-changed dialog', () => {
  it('has Cancel focused and answers the save', async () => {
    const answer = vi.fn();
    const { user } = setup(<UnsavedDialog />);
    addDocument(1, 'a.pdf', true);
    act(() => useSave.getState().setOverwrite({ docId: 1, resolve: answer }));
    await screen.findByRole('dialog', { name: /changed on disk/ });
    await waitFor(() => expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Cancel' })));
    await user.click(screen.getByRole('button', { name: 'Overwrite' }));
    expect(answer).toHaveBeenCalledWith(true);
    expect(useSave.getState().overwrite).toBeNull();
  });

  it('Esc declines', async () => {
    const answer = vi.fn();
    const { user } = setup(<UnsavedDialog />);
    addDocument(1, 'a.pdf', true);
    act(() => useSave.getState().setOverwrite({ docId: 1, resolve: answer }));
    await screen.findByRole('dialog');
    await user.keyboard('{Escape}');
    expect(answer).toHaveBeenCalledWith(false);
  });
});
