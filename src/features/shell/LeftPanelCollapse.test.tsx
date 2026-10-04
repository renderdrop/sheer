// @vitest-environment jsdom
import { act, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { MotionGlobalConfig } from 'motion/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { DocumentInfo } from '../../api/documents';
import { PANEL } from '../../components/tokens';
import { setup } from '../../test/render';
import { useSettings } from '../../stores/settings';
import { opened } from '../../stores/documents.testutil';
import { useUi } from '../../stores/ui';
import { useViewer } from '../viewer/useViewer';
import { resetViewer } from '../viewer/viewer.testutil';
import { Shell } from './Shell';

/** Collapsing and restoring the left panel (DESIGN 3.8): the columns slide for 250 ms and the panel fades, without the shell rendering for it. */

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
  vi.useRealTimers();
  useUi.setState({ ...uiInitial }, true);
  resetViewer();
  useSettings.setState(settingsInitial, true);
});

const toolbar = () => screen.getByRole('toolbar', { name: 'Tools' });
const tool = (name: string) => within(toolbar()).getByRole('button', { name });
const panel = () => screen.queryByRole('complementary', { name: 'Left panel' });
/** The element that fades and sits in the grid: around the panel and the `display: contents` element of its tabs. */
const frameOf = (aside: HTMLElement) => aside.parentElement?.parentElement as HTMLElement;
const advance = (ms: number) =>
  act(() => {
    vi.advanceTimersByTime(ms);
  });

async function openDocument(user: ReturnType<typeof setup>['user']) {
  await user.click(screen.getByRole('button', { name: 'Open' }));
  await screen.findByRole('img', { name: /^Page 1 of/ });
}

/** The main grid of a window with a document, and its tracks one by one. */
const gridOf = (container: HTMLElement) => container.querySelector<HTMLElement>('[data-layout]') as HTMLElement;
const tracks = (grid: HTMLElement) => grid.style.gridTemplateColumns.split(' ');
const TRANSITION = 'transition-[grid-template-columns]';

describe('the columns', () => {
  it('keep the list as long as it was: the tracks of the panel shrink to nothing and grow back, so they can animate', async () => {
    const { container, user } = setup(<Shell />);
    await openDocument(user);
    const grid = gridOf(container);
    const open = tracks(grid);
    expect(open.slice(0, 3)).toEqual(['var(--space-2)', `${PANEL.default}px`, 'var(--splitter-width)']);

    await user.click(tool('Left panel'));
    const shut = tracks(grid);
    expect(shut).toHaveLength(open.length);
    expect(shut.slice(0, 3)).toEqual(['var(--spacing-0)', 'var(--spacing-0)', 'var(--splitter-width)']);
    expect(shut.slice(2)).toEqual(open.slice(2));

    await user.click(tool('Left panel'));
    expect(tracks(grid)).toEqual(open);
  });

  it('slide for 230 ms after the panel was collapsed or restored, and not while the splitter is dragged', async () => {
    const { container, user } = setup(<Shell />);
    await openDocument(user);
    const grid = gridOf(container);
    expect(grid.hasAttribute('data-animating')).toBe(false);
    expect(grid.className).not.toContain(TRANSITION);

    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    fireEvent.keyDown(window, { key: 'F4' });
    expect(grid.getAttribute('data-left')).toBe('collapsed');
    expect(grid.hasAttribute('data-animating')).toBe(true);
    // The spring on the columns: what closes takes --motion-base (MOTION 2). The timer keeps 50 ms of margin over --motion-slow.
    expect(grid.className).toContain(TRANSITION);
    expect(grid.className).toContain('ease-out');
    expect(grid.className).toContain('duration-base');
    advance(229);
    expect(grid.hasAttribute('data-animating')).toBe(true);
    advance(1);
    expect(grid.hasAttribute('data-animating')).toBe(false);
    expect(grid.className).not.toContain(TRANSITION);
    expect(grid.getAttribute('data-left')).toBe('collapsed');

    fireEvent.keyDown(window, { key: 'F4' });
    expect(grid.getAttribute('data-left')).toBe('open');
    expect(grid.hasAttribute('data-animating')).toBe(true);
    // What opens takes --motion-slow.
    expect(grid.className).toContain('duration-slow');
    advance(370);
    expect(grid.hasAttribute('data-animating')).toBe(false);

    // A new width of the panel changes the same property: it follows the pointer at once, with no transition.
    act(() => useUi.getState().setLeftPanelWidth(300));
    expect(grid.style.gridTemplateColumns).toContain('300px');
    expect(grid.hasAttribute('data-animating')).toBe(false);
    expect(grid.className).not.toContain(TRANSITION);
  });

  it('slide the inspector track in and out the same way, and stay in step with it', async () => {
    resizeTo(1400);
    const { container, user } = setup(<Shell />);
    await openDocument(user);
    const grid = gridOf(container);
    // Hidden: the gap and the track take no room, so the canvas reaches the trailing gutter.
    expect(tracks(grid).slice(-3)).toEqual(['var(--spacing-0)', 'var(--spacing-0)', 'var(--space-2)']);
    expect(grid.getAttribute('data-inspector')).toBe('closed');

    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    fireEvent.click(tool('Highlight'));
    expect(grid.getAttribute('data-inspector')).toBe('open');
    expect(grid.getAttribute('data-animating')).toBe('inspector');
    expect(grid.className).toContain(TRANSITION);
    expect(tracks(grid).slice(-3)).toEqual(['var(--space-2)', 'var(--inspector-width)', 'var(--space-2)']);
    advance(370);
    expect(grid.hasAttribute('data-animating')).toBe(false);
  });

  it('start another slide when the panel is toggled again before the first is over', async () => {
    const { container, user } = setup(<Shell />);
    await openDocument(user);
    const grid = gridOf(container);
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    fireEvent.keyDown(window, { key: 'F4' });
    advance(200);
    fireEvent.keyDown(window, { key: 'F4' });
    advance(200);
    // 400 ms after the first toggle, 200 after the second: it is still sliding.
    expect(grid.hasAttribute('data-animating')).toBe(true);
    advance(170);
    expect(grid.hasAttribute('data-animating')).toBe(false);
  });

  it('do not slide when the window opens a document: the panel is there at once', async () => {
    const { container, user } = setup(<Shell />);
    expect(gridOf(container).getAttribute('data-layout')).toBe('empty');
    await openDocument(user);
    const grid = gridOf(container);
    expect(grid.getAttribute('data-left')).toBe('open');
    expect(panel()).not.toBeNull();
    expect(grid.hasAttribute('data-animating')).toBe(false);
    expect(frameOf(screen.getByRole('complementary', { name: 'Left panel' })).style.opacity).not.toBe('0');
  });

  it('slide when the window gets too narrow for the panel and when it grows again, the same way', async () => {
    resizeTo(1300);
    useUi.setState({ leftPanelWidth: 400, inspector: 'open' });
    const { container, user } = setup(<Shell />);
    await openDocument(user);
    const grid = gridOf(container);
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    resizeTo(960);
    expect(grid.getAttribute('data-left')).toBe('collapsed');
    expect(grid.hasAttribute('data-animating')).toBe(true);
    advance(370);
    resizeTo(1300);
    expect(grid.getAttribute('data-left')).toBe('open');
    expect(grid.hasAttribute('data-animating')).toBe(true);
  });
});

describe('the panel fades while it goes (animations run here)', () => {
  beforeEach(() => {
    MotionGlobalConfig.skipAnimations = false;
  });
  afterEach(() => {
    MotionGlobalConfig.skipAnimations = true;
  });

  it('stays in the page for the fade, takes no focus meanwhile, and then leaves', async () => {
    const { user } = setup(<Shell />);
    await openDocument(user);
    const frame = frameOf(screen.getByRole('complementary', { name: 'Left panel' }));
    expect(frame.hasAttribute('inert')).toBe(false);

    await user.click(tool('Left panel'));
    expect(panel()).not.toBeNull();
    expect(frame.hasAttribute('inert')).toBe(true);
    await waitFor(() => expect(panel()).toBeNull(), { timeout: 2000 });
    expect(frame.isConnected).toBe(false);
  });

  it('comes back with a fade in, at the column it always has', async () => {
    const { user } = setup(<Shell />);
    await openDocument(user);
    const column = frameOf(screen.getByRole('complementary', { name: 'Left panel' })).style.gridColumn;
    await user.click(tool('Left panel'));
    await waitFor(() => expect(panel()).toBeNull(), { timeout: 2000 });
    // The opacity the frame has when it enters the page: read after the click, a busy machine has drawn frames of the fade already.
    let opacityOnEntry: string | undefined;
    const watch = new MutationObserver((records) => {
      for (const record of records) {
        for (const node of record.addedNodes) {
          if (opacityOnEntry === undefined && node instanceof HTMLElement && node.querySelector('aside'))
            opacityOnEntry = node.style.opacity;
        }
      }
    });
    watch.observe(document.body, { childList: true, subtree: true });
    await user.click(tool('Left panel'));
    watch.disconnect();
    const frame = frameOf(screen.getByRole('complementary', { name: 'Left panel' }));
    expect(opacityOnEntry).toBe('0');
    expect(frame.style.gridColumn).toBe(column);
    await waitFor(() => expect(frame.style.opacity).toBe('1'), { timeout: 2000 });
    expect(frame.hasAttribute('inert')).toBe(false);
  });

  it('is restored in the middle of fading out without a second panel', async () => {
    const { user } = setup(<Shell />);
    await openDocument(user);
    await user.click(tool('Left panel'));
    await user.click(tool('Left panel'));
    await waitFor(() => expect(screen.getAllByRole('complementary', { name: 'Left panel' })).toHaveLength(1), {
      timeout: 2000,
    });
    expect(useUi.getState().leftPanelCollapsed).toBe(false);
  });
});

vi.mock('../../api/pages', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../api/pages')>()),
  getPages: vi.fn().mockResolvedValue([]),
}));
