// @vitest-environment jsdom
import { act, fireEvent, screen, waitFor, within } from '@testing-library/react';
import type { ComponentProps } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { DocumentInfo } from '../../api/documents';
import { PANEL } from '../../components/tokens';
import { MAX_ZOOM } from '../../lib/zoom';
import { setup } from '../../test/render';
import { useSettings } from '../../stores/settings';
import { useUi } from '../../stores/ui';
import { useView } from '../../stores/view';
import { useViewer } from '../viewer/useViewer';
import { Shell } from './Shell';

/**
 * Render counts (the shell must not re-render for what changes often). Three counters, each at a seam where a parent's render
 * reaches a child:
 * - `shell`: the shell calls `useShellStructure` once per render, so the wrapper below counts the shell's renders.
 * - `toolbar`: the Toolbar primitive, counted when its parent renders it (its own state changes do not pass this wrapper).
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

vi.mock('../../components/Toolbar', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../components/Toolbar')>();
  const { createElement } = await import('react');
  return {
    ...actual,
    Toolbar: (props: ComponentProps<typeof actual.Toolbar>) => {
      renders.toolbar += 1;
      return createElement(actual.Toolbar, props);
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
  renderPage: vi.fn(),
  closeDocument: vi.fn(),
}));
const windowApi = vi.hoisted(() => ({
  minimizeWindow: vi.fn(),
  toggleMaximizeWindow: vi.fn(),
  closeWindow: vi.fn(),
  isWindowMaximized: vi.fn(),
  isWindowFullscreen: vi.fn(),
}));

vi.mock('../../api/documents', () => documentsApi);
vi.mock('../../api/window', () => windowApi);

const uiInitial = useUi.getState();
const settingsInitial = useSettings.getState();
const viewerInitial = useViewer.getState();

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
  useViewer.setState({ ...viewerInitial }, true);
  useView.setState({ byDoc: {} });
  useSettings.setState({ ...settingsInitial, platform: null }, true);
}

beforeEach(() => {
  reset();
  documentsApi.openDocumentDialog.mockReset().mockResolvedValue(REPORT);
  documentsApi.renderPage
    .mockReset()
    .mockResolvedValue({ data: new Uint8Array([1]), width: 816, height: 1056, scale: 4 / 3 });
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

/** Opens a document and waits until its first page is shown and the viewer is idle, so the counts start from rest. */
async function openAndSettle(user: ReturnType<typeof setup>['user']) {
  await user.click(screen.getByRole('button', { name: 'Open…' }));
  await screen.findByRole('img', { name: /^Page 1 of/ });
  await waitFor(() => expect(useViewer.getState().rendering).toBe(false));
}

/** Waits for the render that a change of page or zoom starts (debounced, then async) to be over. */
async function settleRender() {
  const calls = documentsApi.renderPage.mock.calls.length;
  await waitFor(() => expect(documentsApi.renderPage.mock.calls.length).toBeGreaterThan(calls));
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
    // The inspector has content now, which is a structure change only from 1280 px; at 1100 nothing in the shell moves.
    expect(renders.shell).toBe(before.shell);
    expect(renders.leftPanel).toBe(before.leftPanel);

    const afterTool = counts();
    await user.click(screen.getByRole('tab', { name: 'Outline' }));
    expect(renders.leftPanel).toBeGreaterThan(afterTool.leftPanel);
    expect(renders.toolbar).toBe(afterTool.toolbar);
    expect(renders.shell).toBe(afterTool.shell);
  });
});

describe('what changes often does not render the shell, the toolbar or the left panel', () => {
  it('a zoom step by key, wheel, toolbar button, menu and store, while the readouts follow', async () => {
    const { user } = setup(<Shell />);
    await openAndSettle(user);
    const before = counts();
    const readout = () => within(toolbar()).getByRole('button', { name: 'Zoom level' }).textContent;
    const statusZoom = () =>
      within(screen.getByRole('contentinfo', { name: 'Status' })).getByRole('button', { name: /Zoom level/ })
        .textContent;

    fireEvent.keyDown(window, { key: '+', ctrlKey: true });
    expect(readout()).toBe(`110${NBSP}%`);
    expect(statusZoom()).toBe(`110${NBSP}%`);

    fireEvent.wheel(screen.getByRole('region', { name: 'Document' }), { deltaY: -100, ctrlKey: true });
    expect(readout()).not.toBe(`110${NBSP}%`);

    await user.click(tool('Zoom in'));
    await user.click(tool('Zoom level'));
    await user.click(within(screen.getByRole('menu')).getByRole('menuitemcheckbox', { name: `200${NBSP}%` }));
    expect(readout()).toBe(`200${NBSP}%`);
    expect(statusZoom()).toBe(`200${NBSP}%`);

    act(() => useView.getState().setZoom(REPORT.id, 1.5));
    expect(readout()).toBe(`150${NBSP}%`);

    expect(counts()).toEqual(before);
    await settleRender();
    // The page that was rendered at the new zoom arrived too (image and "rendering" flag): still nothing.
    expect(counts()).toEqual(before);
  });

  it('the toolbar zoom menu opens with the current zoom checked', async () => {
    const { user } = setup(<Shell />);
    await openAndSettle(user);
    act(() => useView.getState().setZoom(REPORT.id, 2));
    await user.click(tool('Zoom level'));
    const menu = screen.getByRole('menu', { name: 'Zoom level' });
    const checked = within(menu).getAllByRole('menuitemcheckbox', { checked: true });
    expect(checked.map((item) => item.textContent)).toEqual([`200${NBSP}%`]);
  });

  it('the zoom limits are the exception: reaching one renders the toolbar once, to disable the button that cannot go on', async () => {
    const { user } = setup(<Shell />);
    await openAndSettle(user);
    expect(tool('Zoom in').hasAttribute('aria-disabled')).toBe(false);
    const before = counts();
    act(() => useView.getState().setZoom(REPORT.id, MAX_ZOOM - 1));
    act(() => useView.getState().setZoom(REPORT.id, MAX_ZOOM - 0.5));
    expect(counts()).toEqual(before);
    act(() => useView.getState().setZoom(REPORT.id, MAX_ZOOM));
    expect(tool('Zoom in').getAttribute('aria-disabled')).toBe('true');
    expect(renders.toolbar).toBe(before.toolbar + 1);
    expect(renders.shell).toBe(before.shell);
    expect(renders.leftPanel).toBe(before.leftPanel);
    // Leaving the limit enables it again, once.
    act(() => useView.getState().setZoom(REPORT.id, MAX_ZOOM - 1));
    expect(tool('Zoom in').hasAttribute('aria-disabled')).toBe(false);
    expect(renders.toolbar).toBe(before.toolbar + 2);
    expect(renders.shell).toBe(before.shell);
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
    expect(screen.getByRole('img', { name: /^Page \d+ of 120$/ })).not.toBeNull();

    expect(counts()).toEqual(before);
    await settleRender();
    expect(screen.getByRole('img', { name: 'Page 42 of 120' })).not.toBeNull();
    expect(counts()).toEqual(before);
  });

  it('a render that starts and ends (the "rendering" flag and the new image)', async () => {
    const { user } = setup(<Shell />);
    await openAndSettle(user);
    const before = counts();
    act(() => useViewer.setState({ rendering: true }));
    expect(within(screen.getByRole('contentinfo', { name: 'Status' })).getByText('Rendering…')).not.toBeNull();
    act(() => useViewer.setState({ rendering: false, image: { url: 'blob:other', widthPt: 612 } }));
    expect(counts()).toEqual(before);
  });

  it('a drag over the window, with a document and without one', async () => {
    const { container, user } = setup(<Shell />);
    const before = counts();
    act(() => useUi.getState().setDropHover(true));
    expect(screen.getByRole('heading', { level: 1, name: 'Drop to open' })).not.toBeNull();
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

    // From 1280 the inspector's track is reserved: the structure of the shell changes, so the shell renders. What the
    // toolbar shows and what the left panel is have not changed, so neither renders.
    resizeTo(1280);
    expect(renders.shell).toBeGreaterThan(before.shell);
    expect(screen.getByRole('complementary', { name: 'Inspector', hidden: true })).not.toBeNull();
    expect(renders.toolbar).toBe(before.toolbar);
    expect(renders.leftPanel).toBe(before.leftPanel);

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
    expect(screen.queryByRole('complementary', { name: 'Left panel' })).toBeNull();
    expect(renders.shell).toBe(before.shell + 1);
    expect(renders.toolbar).toBeGreaterThan(before.toolbar);
    expect(renders.leftPanel).toBe(before.leftPanel);
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
