// @vitest-environment jsdom
import { act, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { MotionGlobalConfig } from 'motion/react';
import type { ComponentProps } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { DocumentInfo } from '../../api/documents';
import { PANEL } from '../../components/tokens';
import { bindLocaleToSettings } from '../../i18n/bind';
import { useLocaleStore } from '../../i18n/store';
import { MAX_ZOOM } from '../../lib/zoom';
import { setup } from '../../test/render';
import { useSettings } from '../../stores/settings';
import { opened } from '../../stores/documents.testutil';
import { useUi } from '../../stores/ui';
import { useView } from '../../stores/view';
import { useViewer } from '../viewer/useViewer';
import { resetViewer } from '../viewer/viewer.testutil';
import { Shell } from './Shell';

/**
 * Render counts (the shell must not re-render for what changes often). Three counters, each at a seam where a parent's render
 * reaches a child:
 * - `shell`: the shell calls `useShellStructure` once per render, so the wrapper below counts the shell's renders.
 * - `toolbar`: the toolbar row, counted when its parent renders it (its own state changes do not pass this wrapper).
 * - `leftPanel`: the Panel primitive with the left panel's name, counted the same way.
 */
const renders = vi.hoisted(() => ({ shell: 0, toolbar: 0, leftPanel: 0 }));

vi.mock('./useShellStructure', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./useShellStructure')>();
  return {
    ...actual,
    useShellStructure: () => {
      renders.shell += 1;
      return actual.useShellStructure();
    },
  };
});

vi.mock('./ToolbarRow', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./ToolbarRow')>();
  const { createElement } = await import('react');
  return {
    ...actual,
    ToolbarRow: (props: ComponentProps<typeof actual.ToolbarRow>) => {
      renders.toolbar += 1;
      return createElement(actual.ToolbarRow, props);
    },
  };
});

vi.mock('../../components/Panel', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../components/Panel')>();
  const { createElement } = await import('react');
  return {
    ...actual,
    Panel: (props: ComponentProps<typeof actual.Panel>) => {
      if (props.label === 'Left panel') renders.leftPanel += 1;
      return createElement(actual.Panel, props);
    },
  };
});

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
const localeInitial = useLocaleStore.getState().locale;

const REPORT: DocumentInfo = { id: 1, pageCount: 120, displayName: 'Quarterly report.pdf' };
const NBSP = String.fromCharCode(0xa0);

function resizeTo(width: number) {
  act(() => {
    Object.defineProperty(window, 'innerWidth', { value: width, configurable: true, writable: true });
    window.dispatchEvent(new Event('resize'));
  });
}

function reset() {
  useUi.setState({ ...uiInitial }, true);
  resetViewer();
  useViewer.setState({ viewport: { width: 900, height: 700 } });
  useSettings.setState({ ...settingsInitial, platform: null }, true);
  useLocaleStore.setState({ locale: localeInitial });
}

beforeEach(() => {
  reset();
  documentsApi.openDocumentDialog.mockReset().mockResolvedValue([opened(REPORT)]);
  renderApi.renderPage.mockReset().mockResolvedValue({ data: new Uint8Array([1]), width: 816, height: 1056 });
  renderApi.setViewport.mockReset().mockResolvedValue(undefined);
  renderApi.getPageSizes.mockReset().mockResolvedValue([]);
  documentsApi.closeDocument.mockReset().mockResolvedValue(undefined);
  for (const mock of Object.values(windowApi)) mock.mockReset().mockResolvedValue(false);
  URL.createObjectURL = vi.fn(() => 'blob:page');
  URL.revokeObjectURL = vi.fn();
  resizeTo(1100);
  renders.shell = 0;
  renders.toolbar = 0;
  renders.leftPanel = 0;
});

afterEach(() => {
  reset();
});

const toolbar = () => screen.getByRole('toolbar', { name: 'Tools' });
const tool = (name: string) => within(toolbar()).getByRole('button', { name });
const counts = () => ({ ...renders });
const statusButton = (name: string | RegExp) =>
  within(screen.getByRole('contentinfo', { name: 'Status' })).getByRole('button', { name });

/** Opens a document and waits until its first page is shown and the viewer is idle, so the counts start from rest. */
async function openAndSettle(user: ReturnType<typeof setup>['user']) {
  await user.click(screen.getByRole('button', { name: 'Open' }));
  await screen.findByRole('img', { name: /^Page 1 of/ });
  await waitFor(() => expect(useViewer.getState().rendering).toBe(false));
}

/** Lets the renders that a change of page started (the new pages ask as they mount, and the mock answers at once) finish. */
async function flushRenders() {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 20));
  });
}

/** Waits for the render that a change of zoom starts (the pages ask for the sharper image after a moment) to be over. */
async function settleRender() {
  const calls = renderApi.renderPage.mock.calls.length;
  await waitFor(() => expect(renderApi.renderPage.mock.calls.length).toBeGreaterThan(calls));
  await waitFor(() => expect(useViewer.getState().rendering).toBe(false));
}

describe('the counters', () => {
  it('count the shell, the toolbar and the left panel once when the window opens with a document', async () => {
    const { user } = setup(<Shell />);
    await openAndSettle(user);
    expect(renders.shell).toBeGreaterThan(0);
    expect(renders.toolbar).toBeGreaterThan(0);
    expect(renders.leftPanel).toBeGreaterThan(0);
  });

  it('see a re-render where there should be one: a tool change renders the toolbar, a tab change the left panel', async () => {
    const { user } = setup(<Shell />);
    await openAndSettle(user);
    const before = counts();
    await user.click(tool('Highlight'));
    expect(renders.toolbar).toBeGreaterThan(before.toolbar);
    // The inspector has content now and opens at every width (DESIGN 3.57): one structure change, one render of the shell.
    expect(renders.shell).toBe(before.shell + 1);
    expect(renders.leftPanel).toBe(before.leftPanel);

    const afterTool = counts();
    await user.click(screen.getByRole('tab', { name: 'Outline' }));
    expect(renders.leftPanel).toBeGreaterThan(afterTool.leftPanel);
    expect(renders.toolbar).toBe(afterTool.toolbar);
    expect(renders.shell).toBe(afterTool.shell);
  });
});

describe('what changes often does not render the shell, the toolbar or the left panel', () => {
  it('a zoom step by key, wheel, status bar button, menu and store, while the readout follows', async () => {
    const { user } = setup(<Shell />);
    await openAndSettle(user);
    const before = counts();
    const readout = () => statusZoom();
    const statusZoom = () =>
      within(screen.getByRole('contentinfo', { name: 'Status' })).getByRole('button', { name: /Zoom level/ })
        .textContent;

    fireEvent.keyDown(window, { key: '+', ctrlKey: true });
    expect(readout()).toBe(`108${NBSP}%`);

    fireEvent.wheel(screen.getByRole('region', { name: 'Document' }), { deltaY: -100, ctrlKey: true });
    expect(readout()).not.toBe(`108${NBSP}%`);

    await user.click(statusButton('Zoom in'));
    await user.click(statusButton(/Zoom level/));
    await user.click(within(screen.getByRole('menu')).getByRole('menuitemcheckbox', { name: `200${NBSP}%` }));
    expect(readout()).toBe(`200${NBSP}%`);

    act(() => useView.getState().setZoom(REPORT.id, 1.5));
    expect(readout()).toBe(`150${NBSP}%`);

    expect(counts()).toEqual(before);
    await settleRender();
    // The page that was rendered at the new zoom arrived too (image and "rendering" flag): still nothing.
    expect(counts()).toEqual(before);
  });

  it('the status bar zoom menu opens with the current zoom checked', async () => {
    const { user } = setup(<Shell />);
    await openAndSettle(user);
    act(() => useView.getState().setZoom(REPORT.id, 2));
    await user.click(statusButton(/Zoom level/));
    const menu = screen.getByRole('menu', { name: 'Zoom' });
    const checked = within(menu).getAllByRole('menuitemcheckbox', { checked: true });
    expect(checked.map((item) => item.textContent)).toEqual([`200${NBSP}%`]);
  });

  it('the zoom limits render the status bar and never the shell, the toolbar or the left panel', async () => {
    const { user } = setup(<Shell />);
    await openAndSettle(user);
    expect(statusButton('Zoom in').hasAttribute('aria-disabled')).toBe(false);
    const before = counts();
    act(() => useView.getState().setZoom(REPORT.id, MAX_ZOOM));
    expect(statusButton('Zoom in').getAttribute('aria-disabled')).toBe('true');
    act(() => useView.getState().setZoom(REPORT.id, MAX_ZOOM - 1));
    expect(statusButton('Zoom in').hasAttribute('aria-disabled')).toBe(false);
    expect(counts()).toEqual(before);
  });

  it('a change of page, by Go to page or by the store, while the status bar follows', async () => {
    const { user } = setup(<Shell />);
    await openAndSettle(user);
    const before = counts();
    const status = screen.getByRole('contentinfo', { name: 'Status' });
    const pageButton = () => within(status).getByRole('button', { name: /Go to page/ });

    act(() => useViewer.getState().goToPage(5));
    expect(pageButton().textContent).toBe('6 / 120');
    await user.click(pageButton());
    const field = screen.getByLabelText('Page number');
    await user.clear(field);
    await user.type(field, '42');
    await user.keyboard('{Enter}');
    expect(pageButton().textContent).toBe('42 / 120');
    // The canvas is virtualized: the pages around the one that was gone to are mounted, not one.
    expect(screen.getAllByRole('img', { name: /^Page \d+ of 120$/ }).length).toBeGreaterThan(0);

    expect(counts()).toEqual(before);
    await flushRenders();
    expect(screen.getByRole('img', { name: 'Page 42 of 120' })).not.toBeNull();
    expect(counts()).toEqual(before);
  });

  it('a render that starts and ends (the "rendering" flag)', async () => {
    const { user } = setup(<Shell />);
    await openAndSettle(user);
    const before = counts();
    act(() => useViewer.setState({ rendering: true }));
    expect(within(screen.getByRole('contentinfo', { name: 'Status' })).getByText('Rendering…')).not.toBeNull();
    act(() => useViewer.setState({ rendering: false }));
    expect(counts()).toEqual(before);
  });

  it('a drag over the window, with a document and without one', async () => {
    const { container, user } = setup(<Shell />);
    const before = counts();
    act(() => useUi.getState().setDropHover(true));
    expect(screen.getByText('Drop to open')).not.toBeNull();
    act(() => useUi.getState().setDropHover(false));
    expect(counts()).toEqual(before);

    await openAndSettle(user);
    const open = counts();
    act(() => useUi.getState().setDropHover(true));
    expect(container.querySelector('[data-drop-overlay]')).not.toBeNull();
    act(() => useUi.getState().setDropHover(false));
    expect(counts()).toEqual(open);
  });

  it('an error that appears and is dismissed', async () => {
    const { user } = setup(<Shell />);
    await openAndSettle(user);
    const before = counts();
    act(() => useUi.getState().showBanner({ code: 'damaged_file', key: 'error.damaged_file', retryable: false }));
    const alert = await screen.findByRole('alert');
    await user.click(within(alert).getByRole('button', { name: 'Dismiss' }));
    await waitFor(() => expect(screen.queryByRole('alert')).toBeNull());
    expect(counts()).toEqual(before);
  });

  it('every step of the splitter, while the grid and the splitter follow', async () => {
    const { container, user } = setup(<Shell />);
    await openAndSettle(user);
    const before = counts();
    const splitter = screen.getByRole('separator', { name: 'Resize left panel' });
    const grid = container.querySelector<HTMLElement>('[data-layout]');

    splitter.focus();
    await user.keyboard('{ArrowRight}{ArrowRight}{Shift>}{ArrowRight}{/Shift}');
    const width = PANEL.default + 8 + 8 + 40;
    expect(splitter.getAttribute('aria-valuenow')).toBe(String(width));
    expect(grid?.style.gridTemplateColumns).toContain(`${width}px`);

    for (const next of [301, 302, 303, 304]) act(() => useUi.getState().setLeftPanelWidth(next));
    expect(splitter.getAttribute('aria-valuenow')).toBe('304');
    expect(grid?.style.gridTemplateColumns).toContain('304px');

    expect(counts()).toEqual(before);
  });

  it('a window resize within a regime, and not even the one that crosses 1280 renders the toolbar or the left panel', async () => {
    const { user } = setup(<Shell />);
    await openAndSettle(user);
    const before = counts();
    for (const width of [1110, 1150, 1200, 1279]) resizeTo(width);
    expect(counts()).toEqual(before);

    // The inspector reserves nothing without a selection or tool, so crossing 1280 changes nothing either.
    resizeTo(1280);
    expect(counts()).toEqual(before);
    expect(screen.queryByRole('complementary', { name: 'Inspector', hidden: true })).toBeNull();

    const wide = counts();
    for (const width of [1300, 1500, 1920, 2400]) resizeTo(width);
    expect(counts()).toEqual(wide);
  });

  it('the left panel collapsing renders the toolbar once, for its toggle, and the panel goes', async () => {
    const { user } = setup(<Shell />);
    await openAndSettle(user);
    const before = counts();
    await user.click(tool('Left panel'));
    expect(tool('Left panel').getAttribute('aria-pressed')).toBe('false');
    await waitFor(() => expect(screen.queryByRole('complementary', { name: 'Left panel' })).toBeNull());
    expect(renders.shell).toBe(before.shell + 1);
    expect(renders.toolbar).toBeGreaterThan(before.toolbar);
    expect(renders.leftPanel).toBe(before.leftPanel);
  });
});

describe('the animation of the left panel (250 ms) renders nothing', () => {
  /** Longer than the slide of the columns (250 ms) and the timer that ends it (300 ms). */
  const pastTheAnimation = () => new Promise<void>((resolve) => window.setTimeout(resolve, 450));

  it('collapsing: the shell renders once for the change, not for the fade, the slide or the end of either', async () => {
    const { container, user } = setup(<Shell />);
    await openAndSettle(user);
    const before = counts();
    const grid = container.querySelector<HTMLElement>('[data-layout]');

    await user.click(tool('Left panel'));
    expect(grid?.hasAttribute('data-animating')).toBe(true);
    await waitFor(() => expect(screen.queryByRole('complementary', { name: 'Left panel' })).toBeNull());
    await pastTheAnimation();
    expect(grid?.hasAttribute('data-animating')).toBe(false);

    expect(renders.shell).toBe(before.shell + 1);
    expect(renders.leftPanel).toBe(before.leftPanel);
    const afterCollapse = counts();
    // Nothing is left to render: the page, a zoom step and the splitter still do not reach the shell.
    act(() => useViewer.getState().goToPage(3));
    act(() => useUi.getState().setLeftPanelWidth(300));
    expect(counts()).toEqual(afterCollapse);
  });

  it('restoring: the shell renders once, the panel is made once, and nothing renders when the animation ends', async () => {
    const { container, user } = setup(<Shell />);
    await openAndSettle(user);
    await user.click(tool('Left panel'));
    await waitFor(() => expect(screen.queryByRole('complementary', { name: 'Left panel' })).toBeNull());
    await pastTheAnimation();
    const before = counts();
    const grid = container.querySelector<HTMLElement>('[data-layout]');

    await user.click(tool('Left panel'));
    expect(grid?.hasAttribute('data-animating')).toBe(true);
    expect(screen.getByRole('complementary', { name: 'Left panel' })).not.toBeNull();
    await pastTheAnimation();
    expect(grid?.hasAttribute('data-animating')).toBe(false);

    expect(renders.shell).toBe(before.shell + 1);
    expect(renders.leftPanel).toBe(before.leftPanel + 1);
    const afterRestore = counts();
    await pastTheAnimation();
    expect(counts()).toEqual(afterRestore);
  });
});

describe('the animation of the left panel renders nothing with the animations really running', () => {
  // The setup of the tests skips every animation; here the fade and the slide are drawn frame by frame, as in the app.
  beforeEach(() => {
    MotionGlobalConfig.skipAnimations = false;
  });
  afterEach(() => {
    MotionGlobalConfig.skipAnimations = true;
  });

  /** Longer than the slide of the columns (250 ms) and the timer that ends it (300 ms). */
  const pastTheAnimation = () => new Promise<void>((resolve) => window.setTimeout(resolve, 450));
  const gone = () =>
    waitFor(() => expect(screen.queryByRole('complementary', { name: 'Left panel' })).toBeNull(), { timeout: 2000 });

  it('collapsing and restoring: one render of the shell for each, however many frames the fade has', async () => {
    const { user } = setup(<Shell />);
    await openAndSettle(user);
    const before = counts();

    await user.click(tool('Left panel'));
    await gone();
    await pastTheAnimation();
    expect(renders.shell).toBe(before.shell + 1);
    expect(renders.leftPanel).toBe(before.leftPanel);

    await user.click(tool('Left panel'));
    await waitFor(() => expect(useUi.getState().leftPanelCollapsed).toBe(false));
    await pastTheAnimation();
    expect(screen.getByRole('complementary', { name: 'Left panel' })).not.toBeNull();
    expect(renders.shell).toBe(before.shell + 2);
    const after = counts();
    await pastTheAnimation();
    expect(counts()).toEqual(after);
  });

  it('restoring in the middle of the fade out: still one render for each toggle, and one panel', async () => {
    const { user } = setup(<Shell />);
    await openAndSettle(user);
    const before = counts();

    await user.click(tool('Left panel'));
    await user.click(tool('Left panel'));
    await pastTheAnimation();

    expect(renders.shell).toBe(before.shell + 2);
    expect(screen.getAllByRole('complementary', { name: 'Left panel' })).toHaveLength(1);
    expect(useUi.getState().leftPanelCollapsed).toBe(false);
    const after = counts();
    await pastTheAnimation();
    expect(counts()).toEqual(after);
  });

  it('the shortcut collapses and restores it the same way: one render of the shell each', async () => {
    const { user } = setup(<Shell />);
    await openAndSettle(user);
    const before = counts();

    fireEvent.keyDown(window, { key: 'F4' });
    await gone();
    await pastTheAnimation();
    expect(renders.shell).toBe(before.shell + 1);
    fireEvent.keyDown(window, { key: 'F4' });
    await pastTheAnimation();
    expect(renders.shell).toBe(before.shell + 2);
    expect(screen.getByRole('complementary', { name: 'Left panel' })).not.toBeNull();
  });
});

describe('a language switch', () => {
  /** The language setting drives the locale through `bindLocaleToSettings`, as in the app. */
  function chooseLanguage(language: 'en' | 'de') {
    act(() => useSettings.setState({ language }));
  }

  it('re-renders the parts that show text and never the shell, with a document open', async () => {
    const { user } = setup(<Shell />);
    await openAndSettle(user);
    const unbind = bindLocaleToSettings(document.documentElement);
    try {
      const before = counts();
      chooseLanguage('de');
      // The switch took effect: the toolbar renders again, with German text.
      expect(screen.getByRole('toolbar', { name: 'Werkzeuge' })).not.toBeNull();
      expect(renders.toolbar).toBeGreaterThan(before.toolbar);
      expect(renders.shell).toBe(before.shell);

      const german = counts();
      chooseLanguage('en');
      expect(screen.getByRole('toolbar', { name: 'Tools' })).not.toBeNull();
      expect(renders.toolbar).toBeGreaterThan(german.toolbar);
      expect(renders.shell).toBe(before.shell);
    } finally {
      unbind();
    }
  });

  it('does not render the shell in the empty state either', () => {
    setup(<Shell />);
    const unbind = bindLocaleToSettings(document.documentElement);
    try {
      const before = counts();
      chooseLanguage('de');
      expect(screen.getByRole('heading', { level: 1, name: 'Was möchten Sie tun?' })).not.toBeNull();
      expect(renders.shell).toBe(before.shell);
      chooseLanguage('en');
      expect(screen.getByRole('heading', { level: 1, name: 'What would you like to do?' })).not.toBeNull();
      expect(renders.shell).toBe(before.shell);
    } finally {
      unbind();
    }
  });
});

describe('the empty state', () => {
  it('a window without a document renders the shell and the toolbar only for what they show', () => {
    setup(<Shell />);
    const before = counts();
    act(() => useUi.getState().setLeftPanelWidth(300));
    act(() => useUi.getState().setDropHover(true));
    act(() => useUi.getState().setDropHover(false));
    resizeTo(1200);
    resizeTo(1600);
    expect(counts()).toEqual(before);
    expect(renders.leftPanel).toBe(0);
  });
});

vi.mock('../../api/pages', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../api/pages')>()),
  getPages: vi.fn().mockResolvedValue([]),
}));
