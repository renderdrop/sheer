// @vitest-environment jsdom
import { act } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { DocumentInfo } from '../api/documents';
import { useViewer } from '../features/viewer/useViewer';
import { MAX_ZOOM, MIN_ZOOM } from '../lib/zoom';
import { useUi } from '../stores/ui';
import { useView } from '../stores/view';
import { runAction } from './dispatch';
import { ACTION_IDS } from './registry';
import { readActionState } from './state';

const documentsApi = vi.hoisted(() => ({
  openDocumentDialog: vi.fn(),
  renderPage: vi.fn(),
  closeDocument: vi.fn(),
}));

vi.mock('../api/documents', () => documentsApi);

const uiInitial = useUi.getState();
const viewerInitial = useViewer.getState();
const REPORT: DocumentInfo = { id: 1, pageCount: 10, displayName: 'Report.pdf' };

function reset() {
  useUi.setState({ ...uiInitial }, true);
  useViewer.setState({ ...viewerInitial }, true);
  useView.setState({ byDoc: {} });
}

beforeEach(() => {
  reset();
  documentsApi.openDocumentDialog.mockReset().mockResolvedValue(REPORT);
  documentsApi.closeDocument.mockReset().mockResolvedValue(undefined);
  Object.defineProperty(window, 'innerWidth', { value: 1400, configurable: true, writable: true });
});

afterEach(reset);

const open = () => act(() => useViewer.getState().open());
const view = () => useView.getState().byDoc[REPORT.id];

describe('runAction', () => {
  it('does nothing for an id that is not an action, and says so', () => {
    for (const id of ['', 'quit', 'OPEN', 'open ', '__proto__', 'constructor']) expect(runAction(id), id).toBe(false);
    expect(documentsApi.openDocumentDialog).not.toHaveBeenCalled();
  });

  it('does nothing for an action that cannot run now', async () => {
    for (const id of ['close-document', 'zoom-in', 'fit-width', 'next-page', 'toggle-left-panel', 'tool-draw']) {
      expect(runAction(id), id).toBe(false);
    }
    expect(useUi.getState().activeTool).toBe('select');
    expect(documentsApi.closeDocument).not.toHaveBeenCalled();
    await open();
    expect(runAction('zoom-in')).toBe(true);
  });

  it('opens a document, which is what every Open (toolbar, More, menu bar, key) does', async () => {
    await act(async () => void runAction('open'));
    expect(documentsApi.openDocumentDialog).toHaveBeenCalledTimes(1);
    expect(useViewer.getState().doc).toEqual(REPORT);
  });

  it('closes the document', async () => {
    await open();
    expect(runAction('close-document')).toBe(true);
    expect(useViewer.getState().doc).toBeNull();
    expect(documentsApi.closeDocument).toHaveBeenCalledWith(1);
  });

  it('zooms in and out by presets, and stops at the limits where it is disabled', async () => {
    await open();
    runAction('zoom-in');
    expect(view()?.zoom).toBe(1.1);
    runAction('zoom-out');
    runAction('zoom-out');
    expect(view()?.zoom).toBe(0.9);
    act(() => useView.getState().setZoom(REPORT.id, MAX_ZOOM));
    expect(readActionState().zoomAtMax).toBe(true);
    expect(runAction('zoom-in')).toBe(false);
    act(() => useView.getState().setZoom(REPORT.id, MIN_ZOOM));
    expect(readActionState().zoomAtMin).toBe(true);
    expect(runAction('zoom-out')).toBe(false);
  });

  it('goes to 100 % with Actual Size, to the canvas width with Fit Width and to the whole page with Fit Page', async () => {
    await open();
    act(() => useViewer.setState({ image: { url: 'blob:p', widthPt: 612, heightPt: 792 } }));
    act(() => useViewer.getState().setViewport({ width: 816 + 16, height: 528 }));
    act(() => useView.getState().setZoom(REPORT.id, 2));
    runAction('actual-size');
    expect(view()?.zoom).toBe(1);
    runAction('fit-width');
    expect(view()?.zoom).toBeCloseTo(1);
    runAction('fit-page');
    expect(view()?.zoom).toBeCloseTo(0.5);
  });

  it('turns pages', async () => {
    await open();
    runAction('next-page');
    runAction('next-page');
    expect(view()?.pageIndex).toBe(2);
    runAction('previous-page');
    expect(view()?.pageIndex).toBe(1);
  });

  it('toggles the left panel and the inspector, whatever the window width', async () => {
    await open();
    runAction('toggle-left-panel');
    expect(useUi.getState().leftPanelCollapsed).toBe(true);
    runAction('toggle-left-panel');
    expect(useUi.getState().leftPanelCollapsed).toBe(false);
    // At 1400 px the inspector is reserved but shows only for a tool or when it is asked for.
    runAction('toggle-inspector');
    expect(useUi.getState().inspector).toBe('open');
    runAction('toggle-inspector');
    expect(useUi.getState().inspector).toBe('closed');
  });

  it('makes a tool the active one, and leaves it active when its key is pressed again', async () => {
    await open();
    runAction('tool-highlight');
    expect(useUi.getState().activeTool).toBe('highlight');
    runAction('tool-highlight');
    expect(useUi.getState().activeTool).toBe('highlight');
    runAction('tool-select');
    expect(useUi.getState().activeTool).toBe('select');
  });

  it('runs Settings and About, which are placeholders and change nothing', () => {
    const ui = useUi.getState();
    expect(runAction('settings')).toBe(true);
    expect(runAction('about')).toBe(true);
    expect(useUi.getState()).toBe(ui);
  });

  it('knows an action for every id of the registry', () => {
    for (const id of ACTION_IDS) expect(typeof runAction(id), id).toBe('boolean');
  });
});

describe('readActionState', () => {
  it('has no document before one is open, and the flags are off', () => {
    expect(readActionState()).toEqual({ hasDocument: false, zoomAtMin: false, zoomAtMax: false });
  });

  it('follows the open document', async () => {
    await open();
    expect(readActionState()).toEqual({ hasDocument: true, zoomAtMin: false, zoomAtMax: false });
  });
});
