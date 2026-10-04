// @vitest-environment jsdom
import { act } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { DocumentInfo } from '../api/documents';
import { useViewer } from '../features/viewer/useViewer';
import { MAX_ZOOM, MIN_ZOOM } from '../lib/zoom';
import { activeDocument, opened, resetDocuments } from '../stores/documents.testutil';
import { useUi } from '../stores/ui';
import { useView } from '../stores/view';
import { useAboutDialog } from '../features/about/state';
import { useSettingsPopover } from '../features/settings/state';
import { canRunAction, isModalOpen, runAction } from './dispatch';
import { ACTION_IDS } from './registry';
import { readActionState } from './state';

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
  useSettingsPopover.setState({ open: false });
  useAboutDialog.setState({ open: false });
  useUi.setState({ ...uiInitial }, true);
  useViewer.setState({ ...viewerInitial }, true);
  resetDocuments();
  useView.setState({ byDoc: {} });
}

beforeEach(() => {
  reset();
  documentsApi.openDocumentDialog.mockReset().mockResolvedValue([opened(REPORT)]);
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
    expect(activeDocument()).toEqual(REPORT);
  });

  it('closes the document', async () => {
    await open();
    expect(runAction('close-document')).toBe(true);
    expect(activeDocument()).toBeNull();
    expect(documentsApi.closeDocument).toHaveBeenCalledWith(1, true);
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
    act(() => useViewer.getState().setViewport({ width: 816 + 16, height: 528 }));
    act(() => useView.getState().setZoom(REPORT.id, 2));
    runAction('actual-size');
    expect(view()?.zoom).toBe(1);
    runAction('fit-width');
    expect(view()?.zoom).toBeCloseTo(1);
    runAction('fit-page');
    expect(view()?.zoom).toBeCloseTo(0.5);
  });

  it('lays the pages out in the mode of Continuous scrolling, Single page and Two pages, and only with a document', async () => {
    expect(runAction('scroll-single')).toBe(false);
    await open();
    expect(view()?.scrollMode).toBe('continuous');
    runAction('scroll-single');
    expect(view()?.scrollMode).toBe('single');
    runAction('scroll-spread');
    expect(view()?.scrollMode).toBe('spread');
    runAction('scroll-continuous');
    expect(view()?.scrollMode).toBe('continuous');
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
    // At 1400 px the tool sidebar is shown, so the first toggle makes it the rail and the second brings it back.
    runAction('toggle-inspector');
    expect(useUi.getState().inspector).toBe('closed');
    runAction('toggle-inspector');
    expect(useUi.getState().inspector).toBe('open');
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

  it('opens the settings popover with Settings, with or without a document, and leaves it open when run again', async () => {
    expect(runAction('settings')).toBe(true);
    expect(useSettingsPopover.getState().open).toBe(true);
    expect(runAction('settings')).toBe(true);
    expect(useSettingsPopover.getState().open).toBe(true);
    useSettingsPopover.setState({ open: false });
    await open();
    expect(runAction('settings')).toBe(true);
    expect(useSettingsPopover.getState().open).toBe(true);
    expect(useAboutDialog.getState().open).toBe(false);
  });

  it('opens the About dialog with About, and closes the settings popover so the dialog is the topmost layer', () => {
    runAction('settings');
    expect(runAction('about')).toBe(true);
    expect(useAboutDialog.getState().open).toBe(true);
    expect(useSettingsPopover.getState().open).toBe(false);
  });

  it('knows an action for every id of the registry', () => {
    for (const id of ACTION_IDS) expect(typeof runAction(id), id).toBe('boolean');
  });
});

/** A modal dialog as the About dialog renders it: `aria-modal="true"`, in the body, outside the app's root. */
function openModal(modal: 'true' | null = 'true'): HTMLElement {
  const element = document.body.appendChild(document.createElement('div'));
  element.setAttribute('role', 'dialog');
  if (modal !== null) element.setAttribute('aria-modal', modal);
  return element;
}

describe('while a modal dialog is open', () => {
  it('knows whether one is: only an element with aria-modal="true" counts, not a popover (role dialog alone)', () => {
    expect(isModalOpen()).toBe(false);
    openModal(null);
    expect(isModalOpen()).toBe(false);
    const modal = openModal();
    expect(isModalOpen()).toBe(true);
    modal.removeAttribute('aria-modal');
    expect(isModalOpen()).toBe(false);
  });

  it('no action runs, however it would be enabled: not Open, not the commands of a document, not Settings, not a tool', async () => {
    await open();
    openModal();
    const ui = useUi.getState();
    const viewer = useViewer.getState();
    for (const id of ACTION_IDS.filter((id) => id !== 'about')) {
      expect(runAction(id), id).toBe(false);
      expect(canRunAction(id), id).toBe(false);
    }
    expect(documentsApi.openDocumentDialog).toHaveBeenCalledTimes(1);
    expect(documentsApi.closeDocument).not.toHaveBeenCalled();
    expect(useViewer.getState()).toBe(viewer);
    expect(useUi.getState()).toBe(ui);
    expect(view()?.zoom).toBe(1);
    expect(view()?.pageIndex).toBe(0);
    expect(useSettingsPopover.getState().open).toBe(false);
  });

  it('runs nothing even with no document: Open does not reach the file dialog behind the dialog', () => {
    openModal();
    expect(runAction('open')).toBe(false);
    expect(documentsApi.openDocumentDialog).not.toHaveBeenCalled();
  });

  it('lets About through, which closes the dialog: running it again closes the dialog', () => {
    expect(runAction('about')).toBe(true);
    expect(useAboutDialog.getState().open).toBe(true);
    openModal();
    expect(canRunAction('about')).toBe(true);
    expect(runAction('about')).toBe(true);
    expect(useAboutDialog.getState().open).toBe(false);
  });

  it('runs again once the dialog is gone, and also while it is closing (it drops aria-modal when its exit starts)', async () => {
    await open();
    const modal = openModal();
    expect(runAction('zoom-in')).toBe(false);
    modal.setAttribute('aria-modal', 'false');
    expect(runAction('zoom-in')).toBe(true);
    expect(view()?.zoom).toBe(1.1);
    modal.setAttribute('aria-modal', 'true');
    expect(runAction('zoom-in')).toBe(false);
    modal.remove();
    expect(runAction('zoom-in')).toBe(true);
    expect(view()?.zoom).toBe(1.25);
  });

  it('keeps the rest of the rules: an unknown id and a disabled action still do nothing, and still say so', () => {
    expect(runAction('quit')).toBe(false);
    openModal();
    expect(runAction('quit')).toBe(false);
    expect(runAction('about')).toBe(true);
  });
});

describe('canRunAction', () => {
  it('is the enabled check of runAction: no for an unknown id and for an action that cannot run now, yes otherwise', async () => {
    for (const id of ['', 'quit', '__proto__', 'tool-draw', 'close-document', 'zoom-in']) {
      expect(canRunAction(id), id).toBe(false);
    }
    expect(canRunAction('open')).toBe(true);
    expect(canRunAction('settings')).toBe(true);
    expect(canRunAction('about')).toBe(true);
    await open();
    for (const id of ['tool-draw', 'close-document', 'zoom-in']) expect(canRunAction(id), id).toBe(true);
    act(() => useView.getState().setZoom(REPORT.id, MAX_ZOOM));
    expect(canRunAction('zoom-in')).toBe(false);
  });

  it('runs nothing: asking changes no state', () => {
    canRunAction('settings');
    canRunAction('about');
    canRunAction('open');
    expect(useSettingsPopover.getState().open).toBe(false);
    expect(useAboutDialog.getState().open).toBe(false);
    expect(documentsApi.openDocumentDialog).not.toHaveBeenCalled();
  });
});

describe('readActionState', () => {
  it('has no document before one is open, and the flags are off', () => {
    expect(readActionState()).toEqual({
      hasDocument: false,
      zoomAtMin: false,
      zoomAtMax: false,
      canUndo: false,
      canRedo: false,
    });
  });

  it('follows the open document', async () => {
    await open();
    expect(readActionState()).toEqual({
      hasDocument: true,
      zoomAtMin: false,
      zoomAtMax: false,
      canUndo: false,
      canRedo: false,
      canPrint: true,
      canCopy: true,
    });
  });
});

vi.mock('../api/pages', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../api/pages')>()),
  getPages: vi.fn().mockResolvedValue([]),
}));
