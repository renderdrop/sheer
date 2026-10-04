// @vitest-environment jsdom
import { act, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { AppEvent } from '../../api/app';
import type { DocumentInfo } from '../../api/documents';
import { useDocuments } from '../../stores/documents';
import { activeDocument, resetDocuments } from '../../stores/documents.testutil';
import { useUi } from '../../stores/ui';
import { useView } from '../../stores/view';
import { setup } from '../../test/render';
import { Shell } from '../shell/Shell';
import { appDropBatch } from '../jobs/dropBatch';
import { handleAppEvent, watchAppEvents } from './appEvents';
import { useViewer } from './useViewer';

const documentsApi = vi.hoisted(() => ({
  openDocumentDialog: vi.fn(),
  closeDocument: vi.fn(),
}));

vi.mock('../../api/documents', () => documentsApi);
vi.mock('../../api/render', () => ({
  renderPage: vi.fn(),
  setViewport: vi.fn().mockResolvedValue(undefined),
  getPageSizes: vi.fn().mockResolvedValue([]),
}));

const uiInitial = useUi.getState();
const viewerInitial = useViewer.getState();

const REPORT: DocumentInfo = { id: 1, pageCount: 10, displayName: 'Report.pdf' };
const OTHER: DocumentInfo = { id: 2, pageCount: 3, displayName: 'Other.pdf' };

const hover = (active: boolean): AppEvent => ({ type: 'dropHover', active });
const opened = (document: DocumentInfo): AppEvent => ({ type: 'opened', document });

function reset() {
  useUi.setState({ ...uiInitial }, true);
  useViewer.setState({ ...viewerInitial }, true);
  resetDocuments();
  useView.setState({ byDoc: {} });
}

beforeEach(() => {
  // Every opened document shows at once; the multi-file drop has its own tests (jobs/dropBatch.test.ts).
  appDropBatch.setWindow(0);
  reset();
  documentsApi.closeDocument.mockReset().mockResolvedValue(undefined);
  URL.createObjectURL = vi.fn(() => 'blob:page');
  URL.revokeObjectURL = vi.fn();
  Object.defineProperty(window, 'innerWidth', { value: 1400, configurable: true, writable: true });
});

afterEach(reset);

describe('what the backend pushes', () => {
  it('a drag over the window turns the drop overlay on, leaving or dropping turns it off', () => {
    handleAppEvent(hover(true));
    expect(useUi.getState().dropHover).toBe(true);
    handleAppEvent(hover(false));
    expect(useUi.getState().dropHover).toBe(false);
  });

  it('an opened document (a drop, the file association, a second launch) is added and shown with a view of its own', () => {
    handleAppEvent(opened(REPORT));
    expect(activeDocument()).toEqual(REPORT);
    expect(useView.getState().byDoc[REPORT.id]).toMatchObject({ zoom: 1, pageIndex: 0, pageCount: 10 });
    handleAppEvent(opened(OTHER));
    expect(useDocuments.getState().order).toEqual([1, 2]);
    expect(activeDocument()).toEqual(OTHER);
    // Dropping a file that is open already brings its document forward and does not open it a second time.
    handleAppEvent(opened(REPORT));
    expect(useDocuments.getState().order).toEqual([1, 2]);
    expect(activeDocument()).toEqual(REPORT);
    expect(documentsApi.closeDocument).not.toHaveBeenCalled();
  });

  it('a failed open is a banner with the error, and opens nothing', () => {
    const error = { code: 'not_a_pdf', key: 'error.not_a_pdf', retryable: false } as const;
    handleAppEvent({ type: 'openFailed', error });
    expect(useUi.getState().banner).toEqual(error);
    expect(useDocuments.getState().order).toEqual([]);
  });
});

describe('watching the backend', () => {
  it('hands the subscription a handler that does what the events say', async () => {
    let send: (event: AppEvent) => void = () => undefined;
    await watchAppEvents((onEvent) => {
      send = onEvent;
      return Promise.resolve();
    });
    send(hover(true));
    send(opened(REPORT));
    expect(useUi.getState().dropHover).toBe(true);
    expect(activeDocument()).toEqual(REPORT);
  });

  it('delivers what waited for it before it listened, in order, like anything else', async () => {
    // The backend sends the results of a file the app was started with as the first messages on the channel.
    const failed = { code: 'io_not_found', key: 'error.io_not_found', retryable: false } as const;
    await watchAppEvents((onEvent) => {
      onEvent(opened(REPORT));
      onEvent({ type: 'openFailed', error: failed });
      onEvent(opened(OTHER));
      return Promise.resolve();
    });
    expect(useDocuments.getState().order).toEqual([1, 2]);
    expect(activeDocument()).toEqual(OTHER);
    expect(useUi.getState().banner).toEqual(failed);
  });

  it('never rejects: without a backend there is nothing to hear and the Open button still works', async () => {
    await expect(watchAppEvents(() => Promise.reject(new Error('no backend')))).resolves.toBeUndefined();
    expect(useUi.getState().dropHover).toBe(false);
  });
});

describe('in the window', () => {
  it('a file dragged over the start page shows its drop target card (3.54), and not the canvas overlay', () => {
    const { container } = setup(<Shell />);
    act(() => handleAppEvent(hover(true)));
    expect(
      within(container.querySelector('[data-drop-target]') as HTMLElement).getByText('Drop to open'),
    ).not.toBeNull();
    expect(container.querySelector('[data-drop-overlay]')).toBeNull();
    act(() => handleAppEvent(hover(false)));
    expect(screen.getByText('What would you like to do?')).not.toBeNull();
  });

  it('a file dragged over a document shows the overlay over the canvas, and it goes with the drag', async () => {
    const { container } = setup(<Shell />);
    act(() => handleAppEvent(opened(REPORT)));
    expect(container.querySelector('[data-drop-overlay]')).toBeNull();
    act(() => handleAppEvent(hover(true)));
    const overlay = container.querySelector('[data-drop-overlay]');
    expect(overlay).not.toBeNull();
    expect(within(overlay as HTMLElement).getByText('Drop to open')).not.toBeNull();
    act(() => handleAppEvent(hover(false)));
    // The overlay fades out (fast) before it is removed.
    await waitFor(() => expect(container.querySelector('[data-drop-overlay]')).toBeNull());
  });

  it('a dropped file that is not a PDF shows the error as an alert, in the words of the catalog', () => {
    setup(<Shell />);
    act(() =>
      handleAppEvent({
        type: 'openFailed',
        error: { code: 'not_a_pdf', key: 'error.not_a_pdf', retryable: false },
      }),
    );
    expect(screen.getByRole('alert').textContent).toContain('This file is not a valid PDF.');
  });

  it('too many open documents says which limit, not just that one was reached', () => {
    setup(<Shell />);
    act(() =>
      handleAppEvent({
        type: 'openFailed',
        error: {
          code: 'limit_exceeded',
          key: 'error.limit_exceeded',
          retryable: false,
          params: { what: 'documents', limit: 32 },
        },
      }),
    );
    expect(screen.getByRole('alert').textContent).toContain('Too many documents are open.');
  });

  it('a document that arrives while the window shows the empty state replaces it with the viewer', () => {
    setup(<Shell />);
    expect(screen.queryByRole('region', { name: 'Document' })).toBeNull();
    act(() => handleAppEvent(opened(REPORT)));
    expect(screen.getByRole('region', { name: 'Document' })).not.toBeNull();
    expect(screen.getByRole('tablist', { name: 'Open documents' }).textContent).toContain('Report.pdf');
  });
});

vi.mock('../../api/pages', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../api/pages')>()),
  getPages: vi.fn().mockResolvedValue([]),
}));
