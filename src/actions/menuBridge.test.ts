// @vitest-environment jsdom
import { act } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { DocumentInfo } from '../api/documents';
import { useAboutDialog } from '../features/about/state';
import { useSettingsPopover } from '../features/settings/state';
import { useViewer } from '../features/viewer/useViewer';
import { activeDocument, opened, resetDocuments } from '../stores/documents.testutil';
import { useUi } from '../stores/ui';
import { useView } from '../stores/view';
import { watchNativeMenu } from './menuBridge';

const documentsApi = vi.hoisted(() => ({
  openDocumentDialog: vi.fn(),
  closeDocument: vi.fn(),
}));

vi.mock('../api/documents', () => documentsApi);
vi.mock('../api/render', () => ({
  renderPage: vi.fn(),
  setViewport: vi.fn().mockResolvedValue(undefined),
  getPageSizes: vi.fn().mockResolvedValue([]),
}));

const uiInitial = useUi.getState();
const viewerInitial = useViewer.getState();
const REPORT: DocumentInfo = { id: 1, pageCount: 10, displayName: 'Report.pdf' };

function reset() {
  useAboutDialog.setState({ open: false });
  useSettingsPopover.setState({ open: false });
  useUi.setState({ ...uiInitial }, true);
  useViewer.setState({ ...viewerInitial }, true);
  resetDocuments();
  useView.setState({ byDoc: {} });
}

beforeEach(() => {
  reset();
  documentsApi.openDocumentDialog.mockReset().mockResolvedValue([opened(REPORT)]);
  documentsApi.closeDocument.mockReset().mockResolvedValue(undefined);
});

afterEach(reset);

describe('watchNativeMenu', () => {
  it('opens the channel with the OS language and runs each id the backend sends', async () => {
    const run = vi.fn(() => true);
    let send: (id: string) => void = () => undefined;
    const subscribe = vi.fn((onAction: (id: string) => void) => {
      send = onAction;
      return Promise.resolve();
    });
    await watchNativeMenu(subscribe, run, 'de-AT');
    expect(subscribe).toHaveBeenCalledTimes(1);
    expect(subscribe).toHaveBeenCalledWith(expect.any(Function), 'de-AT');
    send('open');
    send('zoom-in');
    expect(run.mock.calls).toEqual([['open'], ['zoom-in']]);
  });

  it('never rejects: without a backend or a menu bar the commands stay on the toolbar and the keyboard', async () => {
    const run = vi.fn(() => true);
    await expect(
      watchNativeMenu(() => Promise.reject(new Error('command subscribe_menu not allowed')), run, 'en'),
    ).resolves.toBeUndefined();
    await expect(
      watchNativeMenu(
        () => {
          throw new Error('no Tauri');
        },
        run,
        'en',
      ),
    ).resolves.toBeUndefined();
    expect(run).not.toHaveBeenCalled();
  });

  it('takes the language from the browser when it is not given', async () => {
    const subscribe = vi.fn(() => Promise.resolve());
    await watchNativeMenu(subscribe);
    expect(subscribe).toHaveBeenCalledWith(expect.any(Function), expect.any(String));
  });
});

describe('a menu id from the backend, through the bridge into the registry', () => {
  /** The bridge as `main.tsx` starts it (the real `runAction`), and the function the backend's channel would call. */
  async function connect(): Promise<(id: string) => void> {
    let send: (id: string) => void = () => undefined;
    await watchNativeMenu(
      (onAction) => {
        send = onAction;
        return Promise.resolve();
      },
      undefined,
      'en',
    );
    return send;
  }

  it('ignores an id that is not an action, without throwing and without touching the app', async () => {
    const send = await connect();
    const ui = useUi.getState();
    const viewer = useViewer.getState();
    for (const id of ['quit', 'copy', 'Open', 'close_document', '__proto__', 'constructor', '', 'zoom-in ']) {
      expect(() => send(id), id).not.toThrow();
    }
    expect(documentsApi.openDocumentDialog).not.toHaveBeenCalled();
    expect(documentsApi.closeDocument).not.toHaveBeenCalled();
    expect(useUi.getState()).toBe(ui);
    expect(useViewer.getState()).toBe(viewer);
  });

  it('does not run a disabled action: with no document only Open (and the placeholders) can be chosen', async () => {
    const send = await connect();
    const ui = useUi.getState();
    for (const id of [
      'close-document',
      'zoom-in',
      'zoom-out',
      'actual-size',
      'fit-width',
      'fit-page',
      'next-page',
      'previous-page',
      'toggle-left-panel',
      'tool-draw',
    ]) {
      send(id);
    }
    expect(documentsApi.closeDocument).not.toHaveBeenCalled();
    expect(useView.getState().byDoc).toEqual({});
    expect(useUi.getState()).toBe(ui);
  });

  it('runs an enabled action like a key press would, and stops running it when it is disabled again', async () => {
    const send = await connect();
    await act(async () => send('open'));
    expect(documentsApi.openDocumentDialog).toHaveBeenCalledTimes(1);
    expect(activeDocument()).toEqual(REPORT);
    act(() => send('zoom-in'));
    expect(useView.getState().byDoc[REPORT.id]?.zoom).toBe(1.1);
    act(() => send('close-document'));
    expect(documentsApi.closeDocument).toHaveBeenCalledWith(REPORT.id, true);
    expect(activeDocument()).toBeNull();
    documentsApi.closeDocument.mockClear();
    act(() => send('close-document'));
    expect(documentsApi.closeDocument).not.toHaveBeenCalled();
  });

  describe('while a modal dialog is open (the About dialog)', () => {
    /** The dialog as it is in the page: the menu bar is the OS's, so it keeps sending ids while the dialog is up. */
    const modal = () => {
      const element = document.body.appendChild(document.createElement('div'));
      element.setAttribute('role', 'dialog');
      element.setAttribute('aria-modal', 'true');
      return element;
    };

    it('runs no command from the menu bar, enabled or not: the dialog owns the app until it is closed', async () => {
      const send = await connect();
      await act(async () => send('open'));
      expect(activeDocument()).toEqual(REPORT);
      documentsApi.openDocumentDialog.mockClear();
      useAboutDialog.setState({ open: true });
      modal();
      const ui = useUi.getState();
      for (const id of ['open', 'close-document', 'zoom-in', 'zoom-out', 'actual-size', 'fit-width', 'fit-page'])
        send(id);
      for (const id of ['next-page', 'toggle-left-panel', 'tool-draw', 'settings']) send(id);
      expect(documentsApi.openDocumentDialog).not.toHaveBeenCalled();
      expect(documentsApi.closeDocument).not.toHaveBeenCalled();
      expect(activeDocument()).toEqual(REPORT);
      expect(useView.getState().byDoc[REPORT.id]?.zoom).toBe(1);
      expect(useUi.getState()).toBe(ui);
      expect(useSettingsPopover.getState().open).toBe(false);
    });

    it('runs them again when the dialog is gone', async () => {
      const send = await connect();
      await act(async () => send('open'));
      const element = modal();
      act(() => send('zoom-in'));
      expect(useView.getState().byDoc[REPORT.id]?.zoom).toBe(1);
      element.remove();
      act(() => send('zoom-in'));
      expect(useView.getState().byDoc[REPORT.id]?.zoom).toBe(1.1);
    });

    it('still takes About, which closes the dialog', async () => {
      const send = await connect();
      useAboutDialog.setState({ open: true });
      modal();
      act(() => send('about'));
      expect(useAboutDialog.getState().open).toBe(false);
    });
  });
});

vi.mock('../api/pages', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../api/pages')>()),
  getPages: vi.fn().mockResolvedValue([]),
}));
