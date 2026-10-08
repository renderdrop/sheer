// @vitest-environment jsdom
import { act, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { DocumentInfo } from '../../api/documents';
import { PANEL } from '../../components/tokens';
import { setup } from '../../test/render';
import { useSettings } from '../../stores/settings';
import { activeDocument, opened } from '../../stores/documents.testutil';
import { useUi } from '../../stores/ui';
import { useView } from '../../stores/view';
import { useViewer } from '../viewer/useViewer';
import { resetViewer } from '../viewer/viewer.testutil';
import { Shell } from './Shell';

const documentsApi = vi.hoisted(() => ({
  openDocumentDialog: vi.fn(),
  closeDocument: vi.fn(),
}));
const renderApi = vi.hoisted(() => ({ renderPage: vi.fn(), setViewport: vi.fn(), getPageSizes: vi.fn() }));
const windowApi = vi.hoisted(() => ({
  minimizeWindow: vi.fn(),
  toggleMaximizeWindow: vi.fn(),
  closeWindow: vi.fn(),
  isWindowMaximized: vi.fn(),
  isWindowFullscreen: vi.fn(),
}));

vi.mock('../../api/documents', () => documentsApi);
vi.mock('../../api/render', () => renderApi);
vi.mock('../../api/window', () => windowApi);

const uiInitial = useUi.getState();
const settingsInitial = useSettings.getState();

const REPORT: DocumentInfo = { id: 1, pageCount: 120, displayName: 'Quarterly report.pdf' };
const NBSP = String.fromCharCode(0xa0);

function resizeTo(width: number) {
  act(() => {
    Object.defineProperty(window, 'innerWidth', { value: width, configurable: true, writable: true });
    window.dispatchEvent(new Event('resize'));
  });
}

beforeEach(() => {
  useUi.setState({ ...uiInitial }, true);
  resetViewer();
  useViewer.setState({ viewport: { width: 900, height: 700 } });
  useSettings.setState({ ...settingsInitial, platform: null }, true);
  documentsApi.openDocumentDialog.mockReset().mockResolvedValue([opened(REPORT)]);
  renderApi.renderPage.mockReset().mockResolvedValue({ data: new Uint8Array([1]), width: 816, height: 1056 });
  renderApi.setViewport.mockReset().mockResolvedValue(undefined);
  renderApi.getPageSizes.mockReset().mockResolvedValue([]);
  documentsApi.closeDocument.mockReset().mockResolvedValue(undefined);
  for (const mock of Object.values(windowApi)) mock.mockReset().mockResolvedValue(false);
  URL.createObjectURL = vi.fn(() => 'blob:page');
  URL.revokeObjectURL = vi.fn();
  resizeTo(1100);
});

afterEach(() => {
  useUi.setState({ ...uiInitial }, true);
  resetViewer();
  useSettings.setState(settingsInitial, true);
});

/** The tool row (a toolbar named by the mode, DESIGN v2 3.2). */
const toolRegion = () => document.querySelector<HTMLElement>('[data-slot="tool-row"]') as HTMLElement;
const layout = (container: HTMLElement) =>
  container.querySelector('[data-layout]')?.getAttribute('data-layout') ??
  (container.querySelector('[data-slot="home"]') === null ? undefined : 'empty');
const tool = (name: string) => within(toolRegion()).getByRole('button', { name });
/** The page sidebar's collapse chevron; F4 is the way back (the command map, ARCHITECTURE 12). */
const collapseLeft = () => screen.getByRole('button', { name: 'Hide sidebar' });
const pressF4 = (shiftKey = false) => fireEvent.keyDown(window, { key: 'F4', shiftKey });
/** The top bar: zoom and page live there since v1.2 (no status bar). */
const topbarElement = () => document.querySelector<HTMLElement>('[data-slot="topbar"]') as HTMLElement;
const status = () => within(topbarElement());
const pageField = () => status().getByRole('textbox', { name: 'Go to page' }) as HTMLInputElement;
/** "3 / 12": the field's value and the total beside it. */
const pageTextNow = () => `${pageField().value} ${pageField().parentElement?.textContent ?? ''}`;
/** The left of the top bar: the file name, or with two or more documents the tabs; it has the name of every open document. */
const tabs = () => topbarElement();
const toolPressed = (name: string) => tool(name).getAttribute('aria-pressed');
/** Switches the mode with its tab. */
const inMode = async (user: ReturnType<typeof setup>['user'], name: string) =>
  user.click(screen.getByRole('tab', { name }));
const readout = () => status().getByRole('button', { name: /Zoom level/ });
/** Opens the zoom menu and chooses an item by its name. */
const zoomItem = async (user: ReturnType<typeof setup>['user'], name: string) => {
  await user.click(readout());
  await user.click(within(screen.getByRole('menu')).getByRole('menuitem', { name: new RegExp(name) }));
};
/** The Windows platform. */
const windows = () => useSettings.setState({ platform: 'windows' });

/** Opens the document through the empty state's Open button and waits for the first page to arrive. */
async function openDocument(user: ReturnType<typeof setup>['user']) {
  await user.click(screen.getByRole('button', { name: /^(Or open|Open)$/ }));
  await screen.findByRole('img', { name: /^Page 1 of/ });
}

describe('Shell without a document (DESIGN 2, 3.11)', () => {
  it('shows the empty state alone in the main row, on the page background', () => {
    const { container } = setup(<Shell />);
    expect(layout(container)).toBe('empty');
    expect(screen.getByRole('heading', { level: 1, name: 'Drop a PDF here.' })).not.toBeNull();
    expect(screen.queryByRole('complementary')).toBeNull();
    expect(screen.queryByRole('separator', { name: 'Resize left panel' })).toBeNull();
    expect(container.querySelector('[role="region"][aria-label="Document"]')).toBeNull();
  });

  it('the initial focus is on Open', () => {
    setup(<Shell />);
    expect(document.activeElement).toBe(screen.getByRole('button', { name: /^(Or open|Open)$/ }));
  });

  it('Home has no toolbar, no sidebars and no status bar: the editor owns them', () => {
    setup(<Shell />);
    expect(screen.queryByRole('toolbar', { name: 'Tools' })).toBeNull();
    expect(screen.queryByRole('contentinfo', { name: 'Status' })).toBeNull();
    expect(screen.queryByRole('menubar')).toBeNull();
  });

  it('the strip at the top of Home is a drag region with the Windows caption buttons, and no menu bar', () => {
    windows();
    const { container } = setup(<Shell />);
    expect(container.querySelector('[data-slot="home-strip"]')?.getAttribute('data-tauri-drag-region')).toBe('deep');
    expect(screen.getByRole('group', { name: 'Window controls' })).not.toBeNull();
    expect(screen.queryByRole('menubar')).toBeNull();
  });

  it('Open calls the open dialog', async () => {
    documentsApi.openDocumentDialog.mockResolvedValue([]);
    const { user } = setup(<Shell />);
    await user.click(screen.getByRole('button', { name: /^(Or open|Open)$/ }));
    expect(documentsApi.openDocumentDialog).toHaveBeenCalledTimes(1);
  });

  it('Ctrl+O opens the dialog too', async () => {
    documentsApi.openDocumentDialog.mockResolvedValue([]);
    setup(<Shell />);
    fireEvent.keyDown(window, { key: 'o', ctrlKey: true });
    await waitFor(() => expect(documentsApi.openDocumentDialog).toHaveBeenCalledTimes(1));
  });
});

describe('Shell with a document', () => {
  it('shows the left panel, the splitter, the canvas with the page and the top bar', async () => {
    const { container, user } = setup(<Shell />);
    await openDocument(user);
    expect(layout(container)).toBe('document');
    expect(screen.getByRole('complementary', { name: 'Left panel' })).not.toBeNull();
    expect(screen.getByRole('separator', { name: 'Resize left panel' })).not.toBeNull();
    expect(screen.getByRole('region', { name: 'Document' })).not.toBeNull();
    expect(tabs().textContent).toContain('Quarterly report.pdf');
    expect(pageTextNow()).toBe('1 / 120');
    expect(readout().textContent).toBe(`100${NBSP}%`);
  });

  it('the tools are enabled and Select is the active one', async () => {
    const { user } = setup(<Shell />);
    await openDocument(user);
    expect(tool('Hand').hasAttribute('aria-disabled')).toBe(false);
    expect(toolPressed('Select')).toBe('true');
    expect(toolPressed('Hand')).toBe('false');
    await inMode(user, 'Comment');
    expect(tool('Highlight').hasAttribute('aria-disabled')).toBe(false);
    expect(toolPressed('Highlight')).toBe('false');
  });

  it('another document opens beside the first and is the one shown; closing it brings the first back', async () => {
    const { user } = setup(<Shell />);
    await openDocument(user);
    documentsApi.openDocumentDialog.mockResolvedValue([opened({ id: 2, pageCount: 4, displayName: 'Other.pdf' })]);
    fireEvent.keyDown(window, { key: 'o', ctrlKey: true });
    await waitFor(() => expect(activeDocument()?.id).toBe(2));
    // The first one stays open in the backend and keeps its view.
    expect(documentsApi.closeDocument).not.toHaveBeenCalled();
    expect(Object.keys(useView.getState().byDoc)).toEqual(['1', '2']);
    expect(tabs().textContent).toContain('Other.pdf');

    fireEvent.keyDown(window, { key: 'w', ctrlKey: true });
    await waitFor(() => expect(documentsApi.closeDocument).toHaveBeenCalledWith(2, true));
    expect(activeDocument()?.id).toBe(1);
    expect(Object.keys(useView.getState().byDoc)).toEqual(['1']);
    expect(tabs().textContent).toContain('Quarterly report.pdf');
  });

  it('an error shows in the banner row until it is dismissed', async () => {
    documentsApi.openDocumentDialog.mockRejectedValue({
      code: 'damaged_file',
      key: 'error.damaged_file',
      retryable: false,
    });
    const { user } = setup(<Shell />);
    await user.click(screen.getByRole('button', { name: /^(Or open|Open)$/ }));
    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toContain('This PDF is damaged and could not be displayed.');
    await user.click(within(alert).getByRole('button', { name: 'Dismiss' }));
    expect(screen.queryByRole('alert')).toBeNull();
  });

  describe('zoom', () => {
    it('Ctrl+plus and Ctrl+minus step the zoom, Ctrl+1 resets it, and the status bar follows', async () => {
      const { user } = setup(<Shell />);
      await openDocument(user);
      fireEvent.keyDown(window, { key: '+', ctrlKey: true });
      expect(readout().textContent).toBe(`108${NBSP}%`);
      fireEvent.keyDown(window, { key: '-', ctrlKey: true });
      fireEvent.keyDown(window, { key: '-', ctrlKey: true });
      expect(readout().textContent).toBe(`90${NBSP}%`);
      fireEvent.keyDown(window, { key: '1', ctrlKey: true });
      expect(readout().textContent).toBe(`100${NBSP}%`);
    });

    it('the zoom menu changes it too', async () => {
      const { user } = setup(<Shell />);
      await openDocument(user);
      await zoomItem(user, 'Zoom in');
      expect(readout().textContent).toBe(`108${NBSP}%`);
      await zoomItem(user, 'Zoom out');
      expect(readout().textContent).toBe(`100${NBSP}%`);
      await zoomItem(user, 'Fit width');
      expect(useView.getState().byDoc[1]?.zoom).not.toBe(1);
    });

    it('is a view of the document: it does not touch another document', async () => {
      const { user } = setup(<Shell />);
      await openDocument(user);
      fireEvent.keyDown(window, { key: '+', ctrlKey: true });
      expect(useView.getState().byDoc[1]?.zoom).toBeCloseTo(13 / 12);
    });
  });

  describe('commands (the action registry)', () => {
    const pageText = pageTextNow;

    it('the status bar shows the page the scroll position is on', async () => {
      const { user } = setup(<Shell />);
      await openDocument(user);
      expect(pageText()).toBe('1 / 120');
      const region = screen.getByRole('region', { name: 'Document' });
      // A page and its gap are 1056 + 16 px at 100 %.
      region.scrollTop = 30 * 1072;
      fireEvent.scroll(region);
      expect(pageText()).toBe('31 / 120');
      region.scrollTop = 0;
      fireEvent.scroll(region);
      expect(pageText()).toBe('1 / 120');
    });

    it('Ctrl+W closes the document and the empty state comes back; Ctrl+W without one does nothing', async () => {
      const { user } = setup(<Shell />);
      await openDocument(user);
      fireEvent.keyDown(window, { key: 'w', ctrlKey: true });
      expect(await screen.findByRole('heading', { level: 1, name: 'Drop a PDF here.' })).not.toBeNull();
      expect(documentsApi.closeDocument).toHaveBeenCalledTimes(1);
      fireEvent.keyDown(window, { key: 'w', ctrlKey: true });
      expect(documentsApi.closeDocument).toHaveBeenCalledTimes(1);
    });

    it('Ctrl+Down and Ctrl+Up turn the page, and the status bar follows; Alt+Down is the thumbnails and does not', async () => {
      const { user } = setup(<Shell />);
      await openDocument(user);
      fireEvent.keyDown(window, { key: 'ArrowDown', ctrlKey: true });
      fireEvent.keyDown(window, { key: 'ArrowDown', ctrlKey: true });
      expect(pageText()).toBe('3 / 120');
      fireEvent.keyDown(window, { key: 'ArrowUp', ctrlKey: true });
      expect(pageText()).toBe('2 / 120');
      fireEvent.keyDown(window, { key: 'ArrowDown', altKey: true });
      expect(pageText()).toBe('2 / 120');
    });

    it('F4 hides and shows the left panel, and the store follows', async () => {
      const { user } = setup(<Shell />);
      await openDocument(user);
      expect(useUi.getState().leftPanelCollapsed).toBe(false);
      pressF4();
      expect(useUi.getState().leftPanelCollapsed).toBe(true);
      // The panel fades out first and is gone once it has.
      await waitFor(() => expect(screen.queryByRole('complementary', { name: 'Left panel' })).toBeNull());
      pressF4();
      expect(useUi.getState().leftPanelCollapsed).toBe(false);
      expect(screen.getByRole('complementary', { name: 'Left panel' })).not.toBeNull();
    });

    it('Ctrl+2 and Ctrl+0 fit the page to the canvas once it is measured, and the readout follows', async () => {
      const { user } = setup(<Shell />);
      await openDocument(user);
      // jsdom has no layout: the canvas reports its size here, as the ResizeObserver does in the app. The rendered page is 612 x 792 pt.
      act(() => useViewer.getState().setViewport({ width: 816 + 16, height: 528 }));
      fireEvent.keyDown(window, { key: '2', code: 'Digit2', ctrlKey: true });
      expect(readout().textContent).toBe(`100${NBSP}%`);
      fireEvent.keyDown(window, { key: '0', code: 'Digit0', ctrlKey: true });
      expect(readout().textContent).toBe(`50${NBSP}%`);
      fireEvent.keyDown(window, { key: '1', code: 'Digit1', ctrlKey: true });
      expect(readout().textContent).toBe(`100${NBSP}%`);
    });

    it('a tool letter selects the tool only while the canvas has the focus', async () => {
      const { user } = setup(<Shell />);
      await openDocument(user);
      expect(toolPressed('Select')).toBe('true');
      fireEvent.keyDown(window, { key: 'h' });
      fireEvent.keyDown(tool('Select'), { key: 'h' });
      expect(toolPressed('Select')).toBe('true');
      const canvas = screen.getByRole('region', { name: 'Document' });
      canvas.focus();
      await user.keyboard('h');
      // A tool of another mode switches the mode first (DESIGN v2 3.2).
      expect(useUi.getState()).toMatchObject({ mode: 'comment', activeTool: 'highlight' });
      expect(toolPressed('Highlight')).toBe('true');
      await user.keyboard('d');
      expect(toolPressed('Draw')).toBe('true');
      expect(toolPressed('Highlight')).toBe('false');
      await user.keyboard('v');
      expect(useUi.getState().activeTool).toBe('select');
      expect(toolPressed('Draw')).toBe('false');
    });

    it('typing in the Go to page field never takes a shortcut: letters and Ctrl+plus stay with the field', async () => {
      const { user } = setup(<Shell />);
      await openDocument(user);
      const field = pageField();
      await user.click(field);
      await user.keyboard('h');
      fireEvent.keyDown(field, { key: '+', ctrlKey: true });
      fireEvent.keyDown(field, { key: 'w', ctrlKey: true });
      expect(toolPressed('Select')).toBe('true');
      expect(readout().textContent).toBe(`100${NBSP}%`);
      expect(activeDocument()).not.toBeNull();
    });

    it('the top bar buttons show their keys in their tooltips', async () => {
      const { user } = setup(<Shell />);
      await openDocument(user);
      expect(status().getByRole('button', { name: 'Undo' }).getAttribute('aria-keyshortcuts')).toBe('Control+Z');
      expect(status().getByRole('button', { name: 'Find' }).getAttribute('aria-keyshortcuts')).toBe('Control+F');
    });
  });

  describe('the left panel (DESIGN 3.6, 3.8)', () => {
    it('has the four tabs, Pages first and selected', async () => {
      const { user } = setup(<Shell />);
      await openDocument(user);
      const tabs = within(screen.getByRole('tablist', { name: 'Left panel views' })).getAllByRole('tab');
      expect(tabs.map((tab) => tab.getAttribute('aria-label'))).toEqual(['Pages', 'Outline', 'Comments', 'Search']);
      expect(tabs.map((tab) => tab.getAttribute('aria-selected'))).toEqual(['true', 'false', 'false', 'false']);
    });

    it('arrow keys move through the tabs and select them, and the ui store remembers the tab', async () => {
      const { user } = setup(<Shell />);
      await openDocument(user);
      const [thumbnails] = within(screen.getByRole('tablist', { name: 'Left panel views' })).getAllByRole('tab');
      thumbnails?.focus();
      await user.keyboard('{ArrowRight}');
      expect(useUi.getState().leftPanelTab).toBe('outline');
      expect(screen.getByRole('tabpanel', { name: 'Outline' })).not.toBeNull();
      await user.keyboard('{End}');
      expect(useUi.getState().leftPanelTab).toBe('search');
    });

    it('the splitter resizes it from the keyboard: 8 px per arrow, Shift 40, and the width goes to the store', async () => {
      const { user } = setup(<Shell />);
      await openDocument(user);
      const splitter = screen.getByRole('separator', { name: 'Resize left panel' });
      expect(splitter.getAttribute('aria-valuenow')).toBe(String(PANEL.default));
      splitter.focus();
      await user.keyboard('{ArrowRight}');
      expect(useUi.getState().leftPanelWidth).toBe(PANEL.default + 8);
      await user.keyboard('{Shift>}{ArrowRight}{/Shift}');
      expect(useUi.getState().leftPanelWidth).toBe(PANEL.default + 48);
      expect(splitter.getAttribute('aria-valuenow')).toBe(String(PANEL.default + 48));
      await user.keyboard('{Home}');
      expect(useUi.getState().leftPanelWidth).toBe(PANEL.min);
    });

    it('Enter on the splitter collapses the panel and restores it', async () => {
      const { user } = setup(<Shell />);
      await openDocument(user);
      const splitter = screen.getByRole('separator', { name: 'Resize left panel' });
      splitter.focus();
      await user.keyboard('{Enter}');
      await waitFor(() => expect(screen.queryByRole('complementary', { name: 'Left panel' })).toBeNull());
      expect(splitter.getAttribute('aria-valuenow')).toBe('0');
      expect(useUi.getState().leftPanelCollapsed).toBe(true);
      await user.keyboard('{Enter}');
      expect(screen.getByRole('complementary', { name: 'Left panel' })).not.toBeNull();
    });

    it('the collapse chevron hides it, and F4 shows it again', async () => {
      const { user } = setup(<Shell />);
      await openDocument(user);
      await user.click(collapseLeft());
      expect(useUi.getState().leftPanelCollapsed).toBe(true);
      await waitFor(() => expect(screen.queryByRole('complementary', { name: 'Left panel' })).toBeNull());
      pressF4();
      expect(screen.getByRole('complementary', { name: 'Left panel' })).not.toBeNull();
    });

    it('the splitter points at the panel it resizes', async () => {
      const { user } = setup(<Shell />);
      await openDocument(user);
      const panel = screen.getByRole('complementary', { name: 'Left panel' });
      expect(screen.getByRole('separator', { name: 'Resize left panel' }).getAttribute('aria-controls')).toBe(panel.id);
    });
  });

  describe('collapse rules (DESIGN 2)', () => {
    it('there is no tool sidebar and no rail: the mode row and the tool row are the only tool surfaces (ADR-102)', async () => {
      const { container, user } = setup(<Shell />);
      await openDocument(user);
      expect(container.querySelector('[data-region="inspector"]')).toBeNull();
      expect(screen.queryByRole('complementary', { name: 'Inspector' })).toBeNull();
      expect(screen.getByRole('tablist', { name: 'Mode' })).not.toBeNull();
      expect(screen.getByRole('toolbar', { name: 'Read' })).not.toBeNull();
      const columns = container.querySelector<HTMLElement>('[data-layout]')?.style.gridTemplateColumns ?? '';
      expect(columns).not.toContain('tool-');
      expect(columns.split(' ').length).toBeLessThanOrEqual(4);
    });

    it('the editor rows are top bar, mode row, tool row and body (no menu row off Windows)', async () => {
      const { container, user } = setup(<Shell />);
      await openDocument(user);
      const rows = container.querySelector<HTMLElement>('[data-slot="editor"]')?.style.gridTemplateRows;
      expect(rows).toBe('var(--topbar-height) var(--mode-row-height) var(--tool-row-height) minmax(0, 1fr)');
    });

    it('the grid follows the layout: its columns carry the panel width', async () => {
      const { container, user } = setup(<Shell />);
      await openDocument(user);
      const grid = container.querySelector<HTMLElement>('[data-layout]');
      expect(grid?.style.gridTemplateColumns).toContain(`${PANEL.default}px`);
      useUi.getState().setLeftPanelWidth(304);
      await waitFor(() => expect(grid?.style.gridTemplateColumns).toContain('304px'));
    });
  });

  describe('tools', () => {
    it('a click activates a tool, it stays active on a second click, and Esc goes back to Select (ADR-056)', async () => {
      const { user } = setup(<Shell />);
      await openDocument(user);
      await inMode(user, 'Comment');
      await user.click(tool('Draw'));
      expect(toolPressed('Draw')).toBe('true');
      await user.click(tool('Draw'));
      expect(toolPressed('Draw')).toBe('true');
      await user.keyboard('{Escape}');
      expect(toolPressed('Draw')).toBe('false');
      expect(useUi.getState().activeTool).toBe('select');
    });

    it('Esc releases the active tool back to Select', async () => {
      const { user } = setup(<Shell />);
      await openDocument(user);
      await inMode(user, 'Comment');
      await user.click(tool('Note'));
      expect(useUi.getState().activeTool).toBe('note');
      await user.keyboard('{Escape}');
      expect(useUi.getState()).toMatchObject({ activeTool: 'select', toolLocked: false });
    });

    it('Esc closes an open menu first and leaves the tool alone', async () => {
      const { user } = setup(<Shell />);
      await openDocument(user);
      await inMode(user, 'Comment');
      await user.click(tool('Highlight'));
      await user.click(readout());
      expect(screen.getByRole('menu')).not.toBeNull();
      await user.keyboard('{Escape}');
      expect(screen.queryByRole('menu')).toBeNull();
      expect(useUi.getState().activeTool).toBe('highlight');
      await user.keyboard('{Escape}');
      expect(useUi.getState().activeTool).toBe('select');
    });
  });

  describe('the drop overlay', () => {
    it('shows over the canvas while a file is dragged over the window', async () => {
      const { container, user } = setup(<Shell />);
      await openDocument(user);
      expect(container.querySelector('[data-drop-overlay]')).toBeNull();
      act(() => useUi.getState().setDropHover(true));
      expect(container.querySelector('[data-drop-overlay]')).not.toBeNull();
    });
  });
});

describe('the window chrome (DESIGN 2.2)', () => {
  it('Windows has a caption row with the three buttons, which call the window API', async () => {
    useSettings.setState({ platform: 'windows' });
    const { user } = setup(<Shell />);
    const controls = screen.getByRole('group', { name: 'Window controls' });
    await user.click(within(controls).getByRole('button', { name: 'Minimize' }));
    await user.click(within(controls).getByRole('button', { name: 'Maximize' }));
    await user.click(within(controls).getByRole('button', { name: 'Close' }));
    expect(windowApi.minimizeWindow).toHaveBeenCalledTimes(1);
    expect(windowApi.toggleMaximizeWindow).toHaveBeenCalledTimes(1);
    expect(windowApi.closeWindow).toHaveBeenCalledTimes(1);
  });

  it('a maximized Windows window shows Restore, read from the window API', async () => {
    useSettings.setState({ platform: 'windows' });
    windowApi.isWindowMaximized.mockResolvedValue(true);
    setup(<Shell />);
    expect(await screen.findByRole('button', { name: 'Restore' })).not.toBeNull();
  });

  it('macOS has no caption row; the toolbar row keeps an 80 px inset for the traffic lights', () => {
    useSettings.setState({ platform: 'macos' });
    const { container } = setup(<Shell />);
    expect(screen.queryByRole('group', { name: 'Window controls' })).toBeNull();
    const row = container.querySelector('[data-tauri-drag-region]');
    expect(row?.className).toContain('ps-chrome-inset');
  });

  it('in macOS full screen the inset is the normal 8 px', async () => {
    useSettings.setState({ platform: 'macos' });
    windowApi.isWindowFullscreen.mockResolvedValue(true);
    const { container } = setup(<Shell />);
    await waitFor(() =>
      expect(container.querySelector('[data-tauri-drag-region]')?.className).not.toContain('ps-chrome-inset'),
    );
  });

  it('the Home strip, the menu row and the top bar are drag regions; the caption buttons sit in the strip and in the menu row (46 x 32), not in the top bar', async () => {
    useSettings.setState({ platform: 'windows' });
    const { container, user } = setup(<Shell />);
    const strip = container.querySelectorAll('[data-tauri-drag-region]');
    expect(strip).toHaveLength(1);
    expect(strip[0]?.className).toContain('h-topbar');
    await openDocument(user);
    const regions = [...container.querySelectorAll('[data-tauri-drag-region]')];
    expect(regions[0]?.className).toContain('h-menubar');
    expect(within(regions[0] as HTMLElement).getByRole('group', { name: 'Window controls' })).not.toBeNull();
    expect(within(regions[0] as HTMLElement).getByRole('menubar')).not.toBeNull();
    expect(regions[1]?.className).toContain('h-topbar');
    expect(within(regions[1] as HTMLElement).queryByRole('group', { name: 'Window controls' })).toBeNull();
  });

  it('a platform that cannot be told has neither chrome', () => {
    const { container } = setup(<Shell />);
    expect(screen.queryByRole('group', { name: 'Window controls' })).toBeNull();
    expect(container.querySelectorAll('[data-tauri-drag-region]')).toHaveLength(1);
  });

  it('after Maximize the caption row asks the window again and offers Restore, which toggles back', async () => {
    useSettings.setState({ platform: 'windows' });
    const { user } = setup(<Shell />);
    const controls = screen.getByRole('group', { name: 'Window controls' });
    windowApi.isWindowMaximized.mockResolvedValue(true);
    await user.click(within(controls).getByRole('button', { name: 'Maximize' }));
    const restore = await screen.findByRole('button', { name: 'Restore' });
    expect(windowApi.toggleMaximizeWindow).toHaveBeenCalledTimes(1);
    windowApi.isWindowMaximized.mockResolvedValue(false);
    await user.click(restore);
    expect(windowApi.toggleMaximizeWindow).toHaveBeenCalledTimes(2);
    expect(await screen.findByRole('button', { name: 'Maximize' })).not.toBeNull();
  });

  it('a window call that is refused shows no banner and leaves the window chrome as it was', async () => {
    useSettings.setState({ platform: 'windows' });
    for (const mock of [windowApi.minimizeWindow, windowApi.toggleMaximizeWindow, windowApi.closeWindow]) {
      mock.mockRejectedValue({ code: 'internal', key: 'error.internal', retryable: false });
    }
    const { user } = setup(<Shell />);
    const controls = screen.getByRole('group', { name: 'Window controls' });
    await user.click(within(controls).getByRole('button', { name: 'Minimize' }));
    await user.click(within(controls).getByRole('button', { name: 'Maximize' }));
    await user.click(within(controls).getByRole('button', { name: 'Close' }));
    expect(windowApi.minimizeWindow).toHaveBeenCalledTimes(1);
    expect(windowApi.toggleMaximizeWindow).toHaveBeenCalledTimes(1);
    expect(windowApi.closeWindow).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole('alert')).toBeNull();
    expect(within(controls).getByRole('button', { name: 'Maximize' })).not.toBeNull();
  });

  it('a failing state read counts as "not maximized" instead of breaking the caption row', async () => {
    useSettings.setState({ platform: 'windows' });
    windowApi.isWindowMaximized.mockRejectedValue({ code: 'internal', key: 'error.internal', retryable: false });
    setup(<Shell />);
    await act(async () => undefined);
    expect(screen.getByRole('button', { name: 'Maximize' })).not.toBeNull();
  });
});

describe('Shell without a document: edge cases', () => {
  it('a cancelled dialog leaves the empty state as it was: no banner, Open is ready again and keeps the focus', async () => {
    documentsApi.openDocumentDialog.mockResolvedValue([]);
    const { container, user } = setup(<Shell />);
    await user.click(screen.getByRole('button', { name: /^(Or open|Open)$/ }));
    const open = await screen.findByRole('button', { name: /^(Or open|Open)$/ });
    expect(open.hasAttribute('aria-disabled')).toBe(false);
    expect(layout(container)).toBe('empty');
    expect(screen.queryByRole('alert')).toBeNull();
    expect(document.activeElement).toBe(open);
    expect(renderApi.renderPage).not.toHaveBeenCalled();
  });

  it('Open does not start a second dialog while the first one is still open, by mouse, Enter or Ctrl+O', async () => {
    let finish: (info: DocumentInfo | null) => void = () => undefined;
    documentsApi.openDocumentDialog.mockReturnValue(
      new Promise<DocumentInfo | null>((resolve) => {
        finish = resolve;
      }),
    );
    const { user } = setup(<Shell />);
    await user.click(screen.getByRole('button', { name: /^(Or open|Open)$/ }));
    const opening = screen.getByRole('button', { name: /^(Or open|Open)$/ });
    expect(opening.getAttribute('aria-busy')).toBe('true');
    await user.click(opening);
    await user.keyboard('{Enter}');
    fireEvent.keyDown(window, { key: 'o', ctrlKey: true });
    expect(documentsApi.openDocumentDialog).toHaveBeenCalledTimes(1);
    await act(async () => finish(null));
    expect(await screen.findByRole('button', { name: /^(Or open|Open)$/ })).not.toBeNull();
  });

  it('the initial focus is on Open with the Windows caption row above it too (its buttons are no tab stops)', () => {
    useSettings.setState({ platform: 'windows' });
    setup(<Shell />);
    expect(document.activeElement).toBe(screen.getByRole('button', { name: /^(Or open|Open)$/ }));
  });

  it('the zoom keys do nothing and break nothing without a document', () => {
    const { container } = setup(<Shell />);
    for (const key of ['+', '=', '-', '_', '0']) fireEvent.keyDown(window, { key, ctrlKey: true });
    fireEvent.keyDown(window, { key: 'Escape' });
    expect(useView.getState().byDoc).toEqual({});
    expect(layout(container)).toBe('empty');
  });

  it('Home has no editor grid at any width: no sidebars, no tracks', () => {
    resizeTo(1400);
    const { container } = setup(<Shell />);
    expect(screen.queryByRole('complementary', { hidden: true })).toBeNull();
    expect(container.querySelector('[data-layout]')).toBeNull();
  });

  it('"back to Home" shows Home while the document stays open, and activating it brings the editor back', async () => {
    const { container, user } = setup(<Shell />);
    await openDocument(user);
    act(() => useUi.getState().setView('home'));
    expect(layout(container)).toBe('empty');
    expect(activeDocument()?.id).toBe(1);
    expect(documentsApi.closeDocument).not.toHaveBeenCalled();
    act(() => useUi.getState().setView('editor'));
    expect(layout(container)).toBe('document');
    expect(screen.getByRole('region', { name: 'Document' })).not.toBeNull();
  });
});

describe('Shell with a document: edge cases', () => {
  it('a document without pages: zoom in the top bar, no page button, no render', async () => {
    documentsApi.openDocumentDialog.mockResolvedValue([opened({ id: 4, pageCount: 0, displayName: 'Empty.pdf' })]);
    const { container, user } = setup(<Shell />);
    await user.click(screen.getByRole('button', { name: /^(Or open|Open)$/ }));
    expect(await screen.findByText('This document has no pages.')).not.toBeNull();
    expect(layout(container)).toBe('document');
    expect(pageField().disabled).toBe(true);
    expect(readout().textContent).toBe(`100${NBSP}%`);
    expect(tabs().textContent).toContain('Empty.pdf');
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 150));
    });
    expect(renderApi.renderPage).not.toHaveBeenCalled();
  });

  it('Go to page takes the first and the last page, and a number outside the document is refused by the field', async () => {
    const { user } = setup(<Shell />);
    await openDocument(user);
    const goTo = async (typed: string) => {
      await user.click(pageField());
      await user.clear(pageField());
      await user.type(pageField(), typed);
      await user.keyboard('{Enter}');
    };
    for (const [typed, shown] of [
      ['120', '120 / 120'],
      ['1', '1 / 120'],
      ['42', '42 / 120'],
    ] as const) {
      await goTo(typed);
      expect(pageTextNow(), typed).toBe(shown);
    }
    // 0 and 121 are refused: the page stays and the field is marked.
    for (const typed of ['0', '121']) {
      await goTo(typed);
      expect(pageField().getAttribute('aria-invalid'), typed).toBe('true');
      await user.keyboard('{Escape}');
      expect(pageTextNow(), typed).toBe('42 / 120');
    }
  });

  describe('the left panel width', () => {
    it('stays within 200 to 320 on the keyboard: past an end nothing moves, and the grid carries the clamped width', async () => {
      const { container, user } = setup(<Shell />);
      await openDocument(user);
      const splitter = screen.getByRole('separator', { name: 'Resize left panel' });
      const columns = () => container.querySelector<HTMLElement>('[data-layout]')?.style.gridTemplateColumns ?? '';
      splitter.focus();

      await user.keyboard('{End}{ArrowRight}{Shift>}{ArrowRight}{/Shift}');
      expect(useUi.getState().leftPanelWidth).toBe(PANEL.max);
      expect(splitter.getAttribute('aria-valuenow')).toBe(String(PANEL.max));
      expect(splitter.getAttribute('aria-valuemax')).toBe(String(PANEL.max));
      expect(columns()).toContain(`${PANEL.max}px`);

      await user.keyboard('{Home}{ArrowLeft}{Shift>}{ArrowLeft}{/Shift}');
      expect(useUi.getState().leftPanelWidth).toBe(PANEL.min);
      expect(splitter.getAttribute('aria-valuenow')).toBe(String(PANEL.min));
      expect(columns()).toContain(`${PANEL.min}px`);
      // The arrow past the minimum does not collapse the panel.
      expect(screen.getByRole('complementary', { name: 'Left panel' })).not.toBeNull();
    });

    it('a width that is out of range in the store is shown clamped', async () => {
      useUi.setState({ leftPanelWidth: 9000 });
      const { user } = setup(<Shell />);
      await openDocument(user);
      expect(screen.getByRole('separator', { name: 'Resize left panel' }).getAttribute('aria-valuenow')).toBe('480');
    });

    it('collapsing and restoring the panel does not forget the width', async () => {
      useUi.setState({ leftPanelWidth: 320 });
      const { user } = setup(<Shell />);
      await openDocument(user);
      await user.click(collapseLeft());
      pressF4();
      expect(useUi.getState().leftPanelWidth).toBe(320);
      expect(screen.getByRole('separator', { name: 'Resize left panel' }).getAttribute('aria-valuenow')).toBe('320');
    });
  });

  describe('collapse rules (DESIGN 2): boundaries', () => {
    it('at 960 the default panel stays: the canvas keeps 752', async () => {
      resizeTo(960);
      const { user } = setup(<Shell />);
      await openDocument(user);
      expect(screen.getByRole('complementary', { name: 'Left panel' })).not.toBeNull();
    });

    it('shrinking the window collapses the panel by itself and growing it again brings it back', async () => {
      resizeTo(1300);
      useUi.setState({ leftPanelWidth: 400 });
      const { user } = setup(<Shell />);
      await openDocument(user);
      expect(screen.getByRole('complementary', { name: 'Left panel' })).not.toBeNull();
      resizeTo(800);
      await waitFor(() => expect(screen.queryByRole('complementary', { name: 'Left panel' })).toBeNull());
      resizeTo(1300);
      expect(screen.getByRole('complementary', { name: 'Left panel' })).not.toBeNull();
    });

    it('a panel the user collapsed stays collapsed when the window grows', async () => {
      resizeTo(1000);
      useUi.setState({ leftPanelWidth: 400 });
      const { user } = setup(<Shell />);
      await openDocument(user);
      await user.click(collapseLeft());
      expect(useUi.getState().leftPanelCollapsed).toBe(true);
      resizeTo(1500);
      await waitFor(() => expect(screen.queryByRole('complementary', { name: 'Left panel' })).toBeNull());
    });
  });
});

vi.mock('../../api/pages', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../api/pages')>()),
  getPages: vi.fn().mockResolvedValue([]),
}));
