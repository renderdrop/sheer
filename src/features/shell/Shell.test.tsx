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

const toolbar = () => screen.getByRole('toolbar', { name: 'Tools' });
const layout = (container: HTMLElement) => container.querySelector('[data-layout]')?.getAttribute('data-layout');
const tool = (name: string) => within(toolbar()).getByRole('button', { name });

/** Opens the document through the empty state's Open button and waits for the first page to arrive. */
async function openDocument(user: ReturnType<typeof setup>['user']) {
  await user.click(screen.getByRole('button', { name: 'Open…' }));
  await screen.findByRole('img', { name: /^Page 1 of/ });
}

describe('Shell without a document (DESIGN 2, 3.11)', () => {
  it('shows the empty state alone in the main row, on the page background', () => {
    const { container } = setup(<Shell />);
    expect(layout(container)).toBe('empty');
    expect(screen.getByRole('heading', { level: 1, name: 'Open a PDF' })).not.toBeNull();
    expect(screen.queryByRole('complementary')).toBeNull();
    expect(screen.queryByRole('separator', { name: 'Resize left panel' })).toBeNull();
    expect(container.querySelector('[role="region"][aria-label="Document"]')).toBeNull();
  });

  it('the initial focus is on Open', () => {
    setup(<Shell />);
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Open…' }));
  });

  it('the toolbar keeps its slot and every tool is aria-disabled', () => {
    setup(<Shell />);
    for (const name of [
      'Left panel',
      'Select',
      'Highlight',
      'Comment',
      'Draw',
      'Form',
      'Signature',
      'Pages',
      'Zoom out',
      'Zoom in',
      'Inspector',
    ]) {
      expect(tool(name).getAttribute('aria-disabled'), name).toBe('true');
    }
    expect(tool('Zoom level').getAttribute('aria-disabled')).toBe('true');
  });

  it('a disabled tool stays focusable and does nothing', async () => {
    const { user } = setup(<Shell />);
    const highlight = tool('Highlight');
    await user.click(highlight);
    expect(useUi.getState().activeTool).toBe('select');
    highlight.focus();
    await user.keyboard('{Enter}');
    expect(useUi.getState().activeTool).toBe('select');
  });

  it('the status bar is empty, and the toolbar still has More with Open in it', async () => {
    const { user } = setup(<Shell />);
    expect(screen.getByRole('contentinfo', { name: 'Status' }).textContent).toBe('');
    await user.click(tool('More'));
    expect(within(screen.getByRole('menu')).getByRole('menuitem', { name: /Open…/ })).not.toBeNull();
  });

  it('Open calls the open dialog, and the toolbar More menu does too', async () => {
    documentsApi.openDocumentDialog.mockResolvedValue([]);
    const { user } = setup(<Shell />);
    await user.click(screen.getByRole('button', { name: 'Open…' }));
    expect(documentsApi.openDocumentDialog).toHaveBeenCalledTimes(1);
    await user.click(tool('More'));
    await user.click(within(screen.getByRole('menu')).getByRole('menuitem', { name: /Open…/ }));
    expect(documentsApi.openDocumentDialog).toHaveBeenCalledTimes(2);
  });

  it('Ctrl+O opens the dialog too', async () => {
    documentsApi.openDocumentDialog.mockResolvedValue([]);
    setup(<Shell />);
    fireEvent.keyDown(window, { key: 'o', ctrlKey: true });
    await waitFor(() => expect(documentsApi.openDocumentDialog).toHaveBeenCalledTimes(1));
  });
});

describe('Shell with a document', () => {
  it('shows the left panel, the splitter, the canvas with the page and the status bar', async () => {
    const { container, user } = setup(<Shell />);
    await openDocument(user);
    expect(layout(container)).toBe('document');
    expect(screen.getByRole('complementary', { name: 'Left panel' })).not.toBeNull();
    expect(screen.getByRole('separator', { name: 'Resize left panel' })).not.toBeNull();
    expect(screen.getByRole('region', { name: 'Document' })).not.toBeNull();
    const status = screen.getByRole('contentinfo', { name: 'Status' });
    expect(status.textContent).toContain('Quarterly report.pdf');
    expect(within(status).getByRole('button', { name: /Go to page/ }).textContent).toBe('1 / 120');
    expect(within(status).getByRole('button', { name: /Zoom level/ }).textContent).toBe(`100${NBSP}%`);
  });

  it('the tools are enabled and Select is the active one', async () => {
    const { user } = setup(<Shell />);
    await openDocument(user);
    expect(tool('Highlight').hasAttribute('aria-disabled')).toBe(false);
    expect(tool('Select').getAttribute('aria-pressed')).toBe('true');
    expect(tool('Highlight').getAttribute('aria-pressed')).toBe('false');
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
    expect(screen.getByRole('contentinfo', { name: 'Status' }).textContent).toContain('Other.pdf');

    fireEvent.keyDown(window, { key: 'w', ctrlKey: true });
    await waitFor(() => expect(documentsApi.closeDocument).toHaveBeenCalledWith(2));
    expect(activeDocument()?.id).toBe(1);
    expect(Object.keys(useView.getState().byDoc)).toEqual(['1']);
    expect(screen.getByRole('contentinfo', { name: 'Status' }).textContent).toContain('Quarterly report.pdf');
  });

  it('an error shows in the banner row until it is dismissed', async () => {
    documentsApi.openDocumentDialog.mockRejectedValue({
      code: 'damaged_file',
      key: 'error.damaged_file',
      retryable: false,
    });
    const { user } = setup(<Shell />);
    await user.click(screen.getByRole('button', { name: 'Open…' }));
    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toContain('This PDF is damaged and could not be displayed.');
    await user.click(within(alert).getByRole('button', { name: 'Dismiss' }));
    expect(screen.queryByRole('alert')).toBeNull();
  });

  describe('zoom', () => {
    it('Ctrl+plus and Ctrl+minus step the zoom, Ctrl+1 resets it, and the status bar and toolbar follow', async () => {
      const { user } = setup(<Shell />);
      await openDocument(user);
      const readout = () => within(toolbar()).getByRole('button', { name: 'Zoom level' }).textContent;
      fireEvent.keyDown(window, { key: '+', ctrlKey: true });
      expect(readout()).toBe(`110${NBSP}%`);
      expect(within(screen.getByRole('contentinfo')).getByRole('button', { name: /Zoom level/ }).textContent).toBe(
        `110${NBSP}%`,
      );
      fireEvent.keyDown(window, { key: '-', ctrlKey: true });
      fireEvent.keyDown(window, { key: '-', ctrlKey: true });
      expect(readout()).toBe(`90${NBSP}%`);
      fireEvent.keyDown(window, { key: '1', ctrlKey: true });
      expect(readout()).toBe(`100${NBSP}%`);
    });

    it('the toolbar buttons and the zoom menu change it too', async () => {
      const { user } = setup(<Shell />);
      await openDocument(user);
      await user.click(tool('Zoom in'));
      expect(tool('Zoom level').textContent).toBe(`110${NBSP}%`);
      await user.click(tool('Zoom level'));
      await user.click(within(screen.getByRole('menu')).getByRole('menuitemcheckbox', { name: `200${NBSP}%` }));
      expect(tool('Zoom level').textContent).toBe(`200${NBSP}%`);
    });

    it('is a view of the document: it does not touch another document', async () => {
      const { user } = setup(<Shell />);
      await openDocument(user);
      fireEvent.keyDown(window, { key: '+', ctrlKey: true });
      expect(useView.getState().byDoc[1]?.zoom).toBe(1.1);
    });
  });

  describe('commands (the action registry)', () => {
    const more = async (user: ReturnType<typeof setup>['user']) => {
      await user.click(tool('More'));
      return screen.getByRole('menu');
    };
    const pageText = () =>
      within(screen.getByRole('contentinfo')).getByRole('button', { name: /Go to page/ }).textContent;

    it('More lists every command that has no toolbar button, with its shortcut, on the platform without a menu bar', async () => {
      const { user } = setup(<Shell />);
      await openDocument(user);
      const menu = await more(user);
      const items = within(menu)
        .getAllByRole('menuitem')
        .map((item) => item.textContent);
      expect(items).toEqual([
        'Open…Ctrl+O',
        'Close documentCtrl+W',
        'Actual sizeCtrl+1',
        'Fit widthCtrl+2',
        'Fit pageCtrl+0',
        'Next pageCtrl+↓',
        'Previous pageCtrl+↑',
        'Settings…Ctrl+,',
        'About',
      ]);
    });

    it('More runs them: Next page and Previous page turn the page, Close document returns to the empty state', async () => {
      const { user } = setup(<Shell />);
      await openDocument(user);
      await user.click(within(await more(user)).getByRole('menuitem', { name: /^Next page/ }));
      expect(pageText()).toBe('2 / 120');
      await user.click(within(await more(user)).getByRole('menuitem', { name: /^Previous page/ }));
      expect(pageText()).toBe('1 / 120');
      await user.click(within(await more(user)).getByRole('menuitem', { name: /^Close document/ }));
      expect(screen.getByRole('heading', { level: 1, name: 'Open a PDF' })).not.toBeNull();
      expect(documentsApi.closeDocument).toHaveBeenCalledWith(1);
    });

    it('More offers the three ways to lay out pages as a choice of one: the current one is checked, and choosing one changes the canvas', async () => {
      const { user } = setup(<Shell />);
      await openDocument(user);
      const modes = () =>
        within(screen.getByRole('menu'))
          .getAllByRole('menuitemcheckbox')
          .map((item) => [item.textContent, item.getAttribute('aria-checked')]);
      await more(user);
      expect(modes()).toEqual([
        ['Continuous scrolling', 'true'],
        ['Single page', 'false'],
        ['Two pages', 'false'],
      ]);
      const mounted = () => document.querySelectorAll('[data-page]').length;
      expect(mounted()).toBeGreaterThan(1);

      await user.click(within(screen.getByRole('menu')).getByRole('menuitemcheckbox', { name: 'Single page' }));
      expect(useView.getState().byDoc[1]?.scrollMode).toBe('single');
      expect(mounted()).toBe(1);
      await more(user);
      expect(modes()).toEqual([
        ['Continuous scrolling', 'false'],
        ['Single page', 'true'],
        ['Two pages', 'false'],
      ]);

      await user.click(within(screen.getByRole('menu')).getByRole('menuitemcheckbox', { name: 'Two pages' }));
      expect(mounted()).toBe(2);
      // The next page turns a spread, and the status bar follows.
      fireEvent.keyDown(window, { key: 'ArrowDown', ctrlKey: true });
      expect(pageText()).toBe('3 / 120');
    });

    it('the three ways to lay out pages are aria-disabled without a document', async () => {
      const { user } = setup(<Shell />);
      await more(user);
      for (const name of ['Continuous scrolling', 'Single page', 'Two pages']) {
        const item = within(screen.getByRole('menu')).getByRole('menuitemcheckbox', { name });
        expect(item.getAttribute('aria-disabled'), name).toBe('true');
      }
    });

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

    it('without a document More has only Open, Settings and About enabled, and the others are aria-disabled', async () => {
      const { user } = setup(<Shell />);
      const menu = await more(user);
      const enabled = within(menu)
        .getAllByRole('menuitem')
        .filter((item) => item.getAttribute('aria-disabled') !== 'true')
        .map((item) => item.textContent);
      expect(enabled).toEqual(['Open…Ctrl+O', 'Settings…Ctrl+,', 'About']);
    });

    it('Ctrl+W closes the document and the empty state comes back; Ctrl+W without one does nothing', async () => {
      const { user } = setup(<Shell />);
      await openDocument(user);
      fireEvent.keyDown(window, { key: 'w', ctrlKey: true });
      expect(await screen.findByRole('heading', { level: 1, name: 'Open a PDF' })).not.toBeNull();
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

    it('F4 hides and shows the left panel, and the toolbar toggle follows', async () => {
      const { user } = setup(<Shell />);
      await openDocument(user);
      expect(tool('Left panel').getAttribute('aria-pressed')).toBe('true');
      fireEvent.keyDown(window, { key: 'F4' });
      expect(tool('Left panel').getAttribute('aria-pressed')).toBe('false');
      // The panel fades out first and is gone once it has.
      await waitFor(() => expect(screen.queryByRole('complementary', { name: 'Left panel' })).toBeNull());
      fireEvent.keyDown(window, { key: 'F4' });
      expect(tool('Left panel').getAttribute('aria-pressed')).toBe('true');
      expect(screen.getByRole('complementary', { name: 'Left panel' })).not.toBeNull();
    });

    it('Shift+F4 shows and hides the inspector, and the toolbar toggle follows', async () => {
      const { user } = setup(<Shell />);
      await openDocument(user);
      expect(tool('Inspector').getAttribute('aria-pressed')).toBe('false');
      fireEvent.keyDown(window, { key: 'F4', shiftKey: true });
      expect(tool('Inspector').getAttribute('aria-pressed')).toBe('true');
      fireEvent.keyDown(window, { key: 'F4', shiftKey: true });
      expect(tool('Inspector').getAttribute('aria-pressed')).toBe('false');
    });

    it('Ctrl+2 and Ctrl+0 fit the page to the canvas once it is measured, and the readout follows', async () => {
      const { user } = setup(<Shell />);
      await openDocument(user);
      // jsdom has no layout: the canvas reports its size here, as the ResizeObserver does in the app. The rendered page is 612 x 792 pt.
      act(() => useViewer.getState().setViewport({ width: 816 + 16, height: 528 }));
      fireEvent.keyDown(window, { key: '2', code: 'Digit2', ctrlKey: true });
      expect(tool('Zoom level').textContent).toBe(`100${NBSP}%`);
      fireEvent.keyDown(window, { key: '0', code: 'Digit0', ctrlKey: true });
      expect(tool('Zoom level').textContent).toBe(`50${NBSP}%`);
      fireEvent.keyDown(window, { key: '1', code: 'Digit1', ctrlKey: true });
      expect(tool('Zoom level').textContent).toBe(`100${NBSP}%`);
    });

    it('a tool letter selects the tool only while the canvas has the focus', async () => {
      const { user } = setup(<Shell />);
      await openDocument(user);
      expect(tool('Select').getAttribute('aria-pressed')).toBe('true');
      fireEvent.keyDown(window, { key: 'h' });
      fireEvent.keyDown(tool('Zoom in'), { key: 'h' });
      expect(tool('Select').getAttribute('aria-pressed')).toBe('true');
      const canvas = screen.getByRole('region', { name: 'Document' });
      canvas.focus();
      await user.keyboard('h');
      expect(tool('Highlight').getAttribute('aria-pressed')).toBe('true');
      await user.keyboard('d');
      expect(tool('Draw').getAttribute('aria-pressed')).toBe('true');
      expect(tool('Highlight').getAttribute('aria-pressed')).toBe('false');
      await user.keyboard('v');
      expect(tool('Select').getAttribute('aria-pressed')).toBe('true');
    });

    it('typing in the Go to page field never takes a shortcut: letters and Ctrl+plus stay with the field', async () => {
      const { user } = setup(<Shell />);
      await openDocument(user);
      await user.click(within(screen.getByRole('contentinfo')).getByRole('button', { name: /Go to page/ }));
      const field = screen.getByLabelText('Page number');
      await user.keyboard('h');
      fireEvent.keyDown(field, { key: '+', ctrlKey: true });
      fireEvent.keyDown(field, { key: 'w', ctrlKey: true });
      expect(tool('Select').getAttribute('aria-pressed')).toBe('true');
      expect(tool('Zoom level').textContent).toBe(`100${NBSP}%`);
      expect(activeDocument()).not.toBeNull();
    });

    it('the tools and the panel toggles show their keys in their tooltips', async () => {
      const { user } = setup(<Shell />);
      await openDocument(user);
      expect(tool('Highlight').getAttribute('aria-keyshortcuts')).toBe('H');
      expect(tool('Left panel').getAttribute('aria-keyshortcuts')).toBe('F4');
      expect(tool('Zoom in').getAttribute('aria-keyshortcuts')).toBe('Control+Plus');
    });
  });

  describe('the left panel (DESIGN 3.6, 3.8)', () => {
    it('has the four tabs, Thumbnails first and selected', async () => {
      const { user } = setup(<Shell />);
      await openDocument(user);
      const tabs = within(screen.getByRole('tablist', { name: 'Left panel views' })).getAllByRole('tab');
      expect(tabs.map((tab) => tab.getAttribute('aria-label'))).toEqual([
        'Thumbnails',
        'Outline',
        'Comments',
        'Search',
      ]);
      expect(tabs.map((tab) => tab.getAttribute('aria-selected'))).toEqual(['true', 'false', 'false', 'false']);
    });

    it('arrow keys move through the tabs and select them, and the ui store remembers the tab', async () => {
      const { user } = setup(<Shell />);
      await openDocument(user);
      const [thumbnails] = screen.getAllByRole('tab');
      thumbnails?.focus();
      await user.keyboard('{ArrowRight}');
      expect(useUi.getState().leftPanelTab).toBe('outline');
      expect(screen.getByRole('heading', { name: 'Outline' })).not.toBeNull();
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
      expect(tool('Left panel').getAttribute('aria-pressed')).toBe('false');
      await user.keyboard('{Enter}');
      expect(screen.getByRole('complementary', { name: 'Left panel' })).not.toBeNull();
    });

    it('the toolbar toggle shows and hides it', async () => {
      const { user } = setup(<Shell />);
      await openDocument(user);
      expect(tool('Left panel').getAttribute('aria-pressed')).toBe('true');
      await user.click(tool('Left panel'));
      expect(useUi.getState().leftPanelCollapsed).toBe(true);
      await waitFor(() => expect(screen.queryByRole('complementary', { name: 'Left panel' })).toBeNull());
      await user.click(tool('Left panel'));
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
    it('below 1280 there is no inspector until it is toggled; a tool does not open it', async () => {
      const { user } = setup(<Shell />);
      await openDocument(user);
      await user.click(tool('Highlight'));
      expect(screen.queryByRole('complementary', { name: 'Inspector', hidden: true })).toBeNull();
      expect(tool('Inspector').getAttribute('aria-pressed')).toBe('false');
      await user.click(tool('Inspector'));
      const inspector = screen.getByRole('complementary', { name: 'Inspector' });
      expect(inspector.hasAttribute('inert')).toBe(false);
      expect(tool('Inspector').getAttribute('aria-pressed')).toBe('true');
      await user.click(tool('Inspector'));
      expect(screen.queryByRole('complementary', { name: 'Inspector', hidden: true })).toBeNull();
    });

    it('from 1280 nothing is reserved for the inspector until a tool or selection wants it, and it leaves again with them', async () => {
      resizeTo(1280);
      const { user } = setup(<Shell />);
      await openDocument(user);
      expect(screen.queryByRole('complementary', { name: 'Inspector', hidden: true })).toBeNull();
      await user.click(tool('Highlight'));
      const inspector = screen.getByRole('complementary', { name: 'Inspector' });
      expect(inspector.hasAttribute('inert')).toBe(false);
      expect(within(inspector).getByRole('heading', { name: 'Tool options' })).not.toBeNull();
      // Back to Select: the panel fades out and its track goes.
      await user.click(tool('Highlight'));
      await waitFor(() => expect(screen.queryByRole('complementary', { name: 'Inspector', hidden: true })).toBeNull());
    });

    it('the inspector toggle can show it at 1280 and more without a tool, and hide it again', async () => {
      resizeTo(1400);
      const { user } = setup(<Shell />);
      await openDocument(user);
      await user.click(tool('Inspector'));
      expect(screen.getByRole('complementary', { name: 'Inspector' }).hasAttribute('inert')).toBe(false);
      await user.click(tool('Inspector'));
      await waitFor(() => expect(screen.queryByRole('complementary', { name: 'Inspector', hidden: true })).toBeNull());
      await user.click(tool('Highlight'));
      // The user closed it: a tool does not override that.
      expect(screen.queryByRole('complementary', { name: 'Inspector', hidden: true })).toBeNull();
    });

    it('at 960 the left panel collapses by itself when the inspector leaves the canvas under 360, and returns with room', async () => {
      resizeTo(960);
      useUi.setState({ leftPanelWidth: 400 });
      const { user } = setup(<Shell />);
      await openDocument(user);
      expect(screen.getByRole('complementary', { name: 'Left panel' })).not.toBeNull();
      await user.click(tool('Inspector'));
      await waitFor(() => expect(screen.queryByRole('complementary', { name: 'Left panel' })).toBeNull());
      expect(tool('Left panel').getAttribute('aria-pressed')).toBe('false');
      // The user did not collapse it: the layout did, so growing the window brings it back.
      expect(useUi.getState().leftPanelCollapsed).toBe(false);
      resizeTo(1300);
      expect(screen.getByRole('complementary', { name: 'Left panel' })).not.toBeNull();
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
    it('a click activates a tool and a second click goes back to Select', async () => {
      const { user } = setup(<Shell />);
      await openDocument(user);
      await user.click(tool('Draw'));
      expect(tool('Draw').getAttribute('aria-pressed')).toBe('true');
      expect(tool('Select').getAttribute('aria-pressed')).toBe('false');
      await user.click(tool('Draw'));
      expect(tool('Select').getAttribute('aria-pressed')).toBe('true');
    });

    it('a double click locks a tool and Esc releases it back to Select', async () => {
      const { user } = setup(<Shell />);
      await openDocument(user);
      await user.dblClick(tool('Comment'));
      expect(useUi.getState()).toMatchObject({ activeTool: 'comment', toolLocked: true });
      expect(tool('Comment').getAttribute('aria-description')).toBe('Locked');
      await user.keyboard('{Escape}');
      expect(useUi.getState()).toMatchObject({ activeTool: 'select', toolLocked: false });
    });

    it('Esc closes an open menu first and leaves the tool alone', async () => {
      const { user } = setup(<Shell />);
      await openDocument(user);
      await user.click(tool('Highlight'));
      await user.click(tool('Zoom level'));
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
    expect(container.querySelector('[data-tauri-drag-region]')?.className).toContain('ps-1');
  });

  it('the toolbar row is a drag region on every platform, and only Windows has the caption row above it', () => {
    useSettings.setState({ platform: 'windows' });
    const { container } = setup(<Shell />);
    const regions = [...container.querySelectorAll('[data-tauri-drag-region]')];
    expect(regions).toHaveLength(2);
    expect(regions[0]?.className).toContain('h-caption');
    expect(regions[1]?.className).toContain('h-toolbar-row');
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
    await user.click(screen.getByRole('button', { name: 'Open…' }));
    const open = await screen.findByRole('button', { name: 'Open…' });
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
    await user.click(screen.getByRole('button', { name: 'Open…' }));
    const opening = await screen.findByRole('button', { name: 'Opening…' });
    await user.click(opening);
    await user.keyboard('{Enter}');
    fireEvent.keyDown(window, { key: 'o', ctrlKey: true });
    expect(documentsApi.openDocumentDialog).toHaveBeenCalledTimes(1);
    await act(async () => finish(null));
    expect(await screen.findByRole('button', { name: 'Open…' })).not.toBeNull();
  });

  it('the initial focus is on Open with the Windows caption row above it too (its buttons are no tab stops)', () => {
    useSettings.setState({ platform: 'windows' });
    setup(<Shell />);
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Open…' }));
  });

  it('the zoom keys do nothing and break nothing without a document', () => {
    const { container } = setup(<Shell />);
    for (const key of ['+', '=', '-', '_', '0']) fireEvent.keyDown(window, { key, ctrlKey: true });
    fireEvent.keyDown(window, { key: 'Escape' });
    expect(useView.getState().byDoc).toEqual({});
    expect(layout(container)).toBe('empty');
    expect(screen.getByRole('contentinfo', { name: 'Status' }).textContent).toBe('');
  });

  it('a double click on a disabled tool neither activates nor locks it, and the toggles stay where they were', async () => {
    const { user } = setup(<Shell />);
    await user.dblClick(tool('Draw'));
    await user.click(tool('Inspector'));
    await user.click(tool('Left panel'));
    await user.click(tool('Zoom in'));
    expect(useUi.getState()).toMatchObject({
      activeTool: 'select',
      toolLocked: false,
      inspector: 'auto',
      leftPanelCollapsed: false,
    });
  });

  it('there is no inspector track at 1280 and more while no document is open', () => {
    resizeTo(1400);
    const { container } = setup(<Shell />);
    expect(screen.queryByRole('complementary', { hidden: true })).toBeNull();
    expect(container.querySelector<HTMLElement>('[data-layout]')?.style.gridTemplateColumns).toBe(
      'var(--space-1) minmax(0, 1fr) var(--space-1)',
    );
  });
});

describe('Shell with a document: edge cases', () => {
  it('the status bar keeps a name at the 255 character limit whole for assistive technology, and its extension in view', async () => {
    const name = `${'n'.repeat(251)}.pdf`;
    documentsApi.openDocumentDialog.mockResolvedValue([opened({ id: 3, pageCount: 2, displayName: name })]);
    const { user } = setup(<Shell />);
    await openDocument(user);
    const status = screen.getByRole('contentinfo', { name: 'Status' });
    expect(within(status).getByText(name)).not.toBeNull();
    const visible = [...status.querySelectorAll('[aria-hidden="true"]')].map((part) => part.textContent);
    expect(visible.join('')).toBe(name);
    expect(visible[1]).toBe('nnnn.pdf');
  });

  it('a document without a name shows "Untitled" in the status bar', async () => {
    documentsApi.openDocumentDialog.mockResolvedValue([opened({ id: 3, pageCount: 2, displayName: '' })]);
    const { user } = setup(<Shell />);
    await openDocument(user);
    const status = screen.getByRole('contentinfo', { name: 'Status' });
    expect(within(status).getAllByText('Untitled').length).toBeGreaterThanOrEqual(1);
    expect(status.querySelector('[aria-hidden="true"]')?.textContent).toBe('Untitled');
  });

  it('a document without pages: name and zoom in the status bar, no page button, no render', async () => {
    documentsApi.openDocumentDialog.mockResolvedValue([opened({ id: 4, pageCount: 0, displayName: 'Empty.pdf' })]);
    const { container, user } = setup(<Shell />);
    await user.click(screen.getByRole('button', { name: 'Open…' }));
    expect(await screen.findByText('This document has no pages.')).not.toBeNull();
    expect(layout(container)).toBe('document');
    const status = screen.getByRole('contentinfo', { name: 'Status' });
    expect(within(status).queryByRole('button', { name: /Go to page/ })).toBeNull();
    expect(within(status).getByRole('button', { name: /Zoom level/ }).textContent).toBe(`100${NBSP}%`);
    expect(status.textContent).toContain('Empty.pdf');
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 150));
    });
    expect(renderApi.renderPage).not.toHaveBeenCalled();
  });

  it('Go to page takes the first and the last page, and a number outside the document is refused by the field', async () => {
    const { user } = setup(<Shell />);
    await openDocument(user);
    const status = screen.getByRole('contentinfo', { name: 'Status' });
    const pageButton = () => within(status).getByRole('button', { name: /Go to page/ });
    const goTo = async (typed: string) => {
      await user.click(pageButton());
      const field = screen.getByLabelText('Page number');
      await user.clear(field);
      await user.type(field, typed);
      await user.keyboard('{Enter}');
    };
    for (const [typed, shown] of [
      ['120', '120 / 120'],
      ['1', '1 / 120'],
      ['42', '42 / 120'],
    ] as const) {
      await goTo(typed);
      expect(pageButton().textContent, typed).toBe(shown);
    }
    // The number field has min 1 and max 120, so 0 and 121 never leave the form: the page stays, the popover stays open.
    for (const typed of ['0', '121']) {
      await goTo(typed);
      expect(pageButton().textContent, typed).toBe('42 / 120');
      expect(screen.getByRole('dialog', { name: 'Go to page' })).not.toBeNull();
      await user.keyboard('{Escape}');
    }
  });

  describe('the left panel width', () => {
    it('stays within 192 to 400 on the keyboard: past an end nothing moves, and the grid carries the clamped width', async () => {
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
      expect(screen.getByRole('separator', { name: 'Resize left panel' }).getAttribute('aria-valuenow')).toBe('400');
    });

    it('collapsing and restoring the panel does not forget the width', async () => {
      useUi.setState({ leftPanelWidth: 320 });
      const { user } = setup(<Shell />);
      await openDocument(user);
      await user.click(tool('Left panel'));
      await user.click(tool('Left panel'));
      expect(useUi.getState().leftPanelWidth).toBe(320);
      expect(screen.getByRole('separator', { name: 'Resize left panel' }).getAttribute('aria-valuenow')).toBe('320');
    });
  });

  describe('collapse rules (DESIGN 2): boundaries', () => {
    it('a tool opens the inspector track from exactly 1280, not at 1279', async () => {
      resizeTo(1279);
      const { user } = setup(<Shell />);
      await openDocument(user);
      await user.click(tool('Highlight'));
      expect(screen.queryByRole('complementary', { name: 'Inspector', hidden: true })).toBeNull();
      resizeTo(1280);
      expect(screen.getByRole('complementary', { name: 'Inspector' })).not.toBeNull();
      resizeTo(1279);
      await waitFor(() => expect(screen.queryByRole('complementary', { name: 'Inspector', hidden: true })).toBeNull());
    });

    it('at 960 with the inspector open the default panel stays: the canvas keeps 392', async () => {
      resizeTo(960);
      useUi.setState({ inspector: 'open' });
      const { user } = setup(<Shell />);
      await openDocument(user);
      expect(screen.getByRole('complementary', { name: 'Left panel' })).not.toBeNull();
      expect(screen.getByRole('complementary', { name: 'Inspector' })).not.toBeNull();
    });

    it('shrinking the window collapses the panel by itself and growing it again brings it back', async () => {
      resizeTo(1300);
      useUi.setState({ leftPanelWidth: 400, inspector: 'open' });
      const { user } = setup(<Shell />);
      await openDocument(user);
      expect(screen.getByRole('complementary', { name: 'Left panel' })).not.toBeNull();
      resizeTo(960);
      await waitFor(() => expect(screen.queryByRole('complementary', { name: 'Left panel' })).toBeNull());
      expect(screen.getByRole('complementary', { name: 'Inspector' })).not.toBeNull();
      resizeTo(1300);
      expect(screen.getByRole('complementary', { name: 'Left panel' })).not.toBeNull();
    });

    it('a panel the user collapsed stays collapsed when the window grows', async () => {
      resizeTo(1000);
      useUi.setState({ leftPanelWidth: 400 });
      const { user } = setup(<Shell />);
      await openDocument(user);
      await user.click(tool('Left panel'));
      expect(useUi.getState().leftPanelCollapsed).toBe(true);
      resizeTo(1500);
      await waitFor(() => expect(screen.queryByRole('complementary', { name: 'Left panel' })).toBeNull());
    });
  });
});
