// @vitest-environment jsdom
import { act, fireEvent, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { OutlineNode } from '../../api/outline';
import { usePages } from '../../stores/pages';
import { useView } from '../../stores/view';
import { setup } from '../../test/render';
import { publishViewRect } from '../viewer/scrollBridge';
import { useViewer } from '../viewer/useViewer';
import { resetViewer, showDocument } from '../viewer/viewer.testutil';
import { CURRENT_SETTLE_MS, LOADING_SHOWN_AFTER_MS, Outline, OutlineActions } from './Outline';
import { useOutline } from './store';

const getOutline = vi.hoisted(() => vi.fn());
vi.mock('../../api/outline', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../api/outline')>()),
  getOutline,
}));

const node = (title: string, page: number | null, ...children: OutlineNode[]): OutlineNode => ({
  title,
  target: page === null ? null : { pageId: page, y: 0 },
  children,
});

const BOOK = { id: 1, pageCount: 20, displayName: 'Book.pdf' };

class FakeResizeObserver {
  constructor(readonly callback: ResizeObserverCallback) {}
  observe(): void {
    this.callback([], this as unknown as ResizeObserver);
  }
  unobserve(): void {}
  disconnect(): void {}
}

beforeEach(() => {
  vi.stubGlobal('ResizeObserver', FakeResizeObserver);
  Object.defineProperty(HTMLElement.prototype, 'clientHeight', { configurable: true, get: () => 320 });
  getOutline.mockReset();
  useOutline.setState({ byDoc: {} });
  resetViewer();
  showDocument(BOOK);
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
  delete (HTMLElement.prototype as { clientHeight?: number }).clientHeight;
});

const items = () => screen.queryAllByRole('treeitem');
const names = () => items().map((item) => item.textContent);

describe('Outline states', () => {
  it('shows nothing for a moment, then a status, while loading', () => {
    vi.useFakeTimers();
    getOutline.mockReturnValue(new Promise(() => undefined));
    setup(<Outline />, { advanceTimers: (ms) => void vi.advanceTimersByTime(ms) });
    expect(screen.queryByText('Loading outline')).toBeNull();
    act(() => void vi.advanceTimersByTime(LOADING_SHOWN_AFTER_MS));
    expect(screen.getByRole('status').textContent).toContain('Loading outline');
  });

  it('says there is no outline', async () => {
    getOutline.mockResolvedValue([]);
    setup(<Outline />);
    expect(await screen.findByText('No outline')).toBeTruthy();
    expect(screen.getByText('This document has no bookmarks.')).toBeTruthy();
  });

  it('shows an error with a retry that asks again', async () => {
    getOutline.mockRejectedValueOnce(new Error('boom')).mockResolvedValueOnce([node('One', 0)]);
    const { user } = setup(<Outline />);
    expect(await screen.findByRole('alert')).toBeTruthy();
    await user.click(screen.getByRole('button', { name: 'Try again' }));
    expect(await screen.findByRole('treeitem', { name: /One/ })).toBeTruthy();
    expect(getOutline).toHaveBeenCalledTimes(2);
  });

  it('fetches once per document and drops the outline when the document closes', async () => {
    getOutline.mockResolvedValue([node('One', 0)]);
    const first = setup(<Outline />);
    await screen.findByRole('treeitem');
    first.unmount();
    setup(<Outline />);
    await screen.findByRole('treeitem');
    expect(getOutline).toHaveBeenCalledTimes(1);
    act(() => useViewer.getState().close());
    expect(useOutline.getState().byDoc[1]).toBeUndefined();
  });

  it('shows the placeholder without a document', () => {
    resetViewer();
    setup(<Outline />);
    expect(screen.getByText('The document outline appears here.')).toBeTruthy();
  });
});

describe('Outline tree', () => {
  const tree = [
    node('Intro', 0),
    node('Part', 2, node('Sub <b>one</b>', 3), node('', null), node('Sub two', null)),
    node('Appendix', null),
  ];

  async function shown() {
    getOutline.mockResolvedValue(tree);
    const view = setup(
      <>
        <OutlineActions />
        <Outline />
      </>,
    );
    await screen.findByRole('tree');
    return view;
  }

  it('shows the top level collapsed, with the tree attributes', async () => {
    await shown();
    expect(names()).toEqual(['Intro', 'Part', 'Appendix']);
    const part = screen.getByRole('treeitem', { name: /Part/ });
    expect(part.getAttribute('aria-expanded')).toBe('false');
    expect(part.getAttribute('aria-level')).toBe('1');
    expect(part.getAttribute('aria-posinset')).toBe('2');
    expect(part.getAttribute('aria-setsize')).toBe('3');
  });

  it('has one tab stop', async () => {
    await shown();
    expect(items().filter((item) => item.tabIndex === 0)).toHaveLength(1);
  });

  it('expands with Right, renders titles as text, mutes rows without a target, names untitled ones', async () => {
    const { user } = await shown();
    screen.getByRole('treeitem', { name: /Part/ }).focus();
    await user.keyboard('{ArrowRight}');
    expect(names()).toContain('Sub <b>one</b>');
    expect(document.querySelector('b')).toBeNull();
    expect(names()).toContain('Untitled');
    const noTarget = screen.getByRole('treeitem', { name: /Sub two/ });
    expect(noTarget.getAttribute('aria-disabled')).toBe('true');
    expect(noTarget.getAttribute('aria-description')).toBe('This entry has no destination in the document.');
    expect(noTarget.className).toContain('text-text-muted');
  });

  it('moves with the arrows, Home, End and type-ahead', async () => {
    const { user } = await shown();
    screen.getByRole('treeitem', { name: /Intro/ }).focus();
    await user.keyboard('{ArrowDown}');
    expect(document.activeElement?.textContent).toBe('Part');
    await user.keyboard('{End}');
    expect(document.activeElement?.textContent).toBe('Appendix');
    await user.keyboard('{Home}');
    expect(document.activeElement?.textContent).toBe('Intro');
    await user.keyboard('a');
    expect(document.activeElement?.textContent).toBe('Appendix');
  });

  it('jumps with Enter, selects the row and keeps focus in the tree', async () => {
    const goToPoint = vi.fn();
    useViewer.setState({ goToPoint });
    const { user } = await shown();
    const intro = screen.getByRole('treeitem', { name: /Intro/ });
    intro.focus();
    await user.keyboard('{Enter}');
    expect(goToPoint).toHaveBeenCalledWith(0, 0);
    expect(intro.getAttribute('aria-selected')).toBe('true');
    expect(document.activeElement).toBe(intro);
  });

  it('jumps to where the page sits after the pages were reordered, and to nothing once it was deleted', async () => {
    const goToPoint = vi.fn();
    useViewer.setState({ goToPoint });
    const { user } = await shown();
    const slots = (ids: number[]) =>
      ids.map((id) => ({
        id,
        width: 100,
        height: 100,
        rotation: 0 as const,
        rev: 0,
        label: null,
        origin: 'file' as const,
      }));
    const all = Array.from({ length: 20 }, (_, id) => id);
    // The file's page 0 (Intro's target) moved to position 5.
    act(() => usePages.getState().setSlots(1, slots([1, 2, 3, 4, 5, 0, ...all.slice(6)])));
    const intro = screen.getByRole('treeitem', { name: /Intro/ });
    intro.focus();
    await user.keyboard('{Enter}');
    expect(goToPoint).toHaveBeenLastCalledWith(5, 0);
    // Deleted: the node has no target, so Enter does not jump.
    goToPoint.mockClear();
    act(() => usePages.getState().setSlots(1, slots(all.slice(1))));
    screen.getByRole('treeitem', { name: /Intro/ }).focus();
    await user.keyboard('{Enter}');
    expect(goToPoint).not.toHaveBeenCalled();
  });

  it('toggles a row without a target on Enter and does not jump', async () => {
    const goToPoint = vi.fn();
    useViewer.setState({ goToPoint });
    const { user } = await shown();
    await user.click(screen.getByRole('treeitem', { name: /Part/ }));
    expect(goToPoint).toHaveBeenCalledWith(2, 0);
    screen.getByRole('treeitem', { name: /Appendix/ }).focus();
    await user.keyboard('{Enter}');
    expect(goToPoint).toHaveBeenCalledTimes(1);
  });

  it('collapses everything with the title-row button', async () => {
    const { user } = await shown();
    screen.getByRole('treeitem', { name: /Part/ }).focus();
    await user.keyboard('{ArrowRight}');
    expect(items()).toHaveLength(6);
    await user.click(screen.getByRole('button', { name: 'Collapse all' }));
    expect(items()).toHaveLength(3);
  });

  it('marks the current section 150 ms after scrolling settles', async () => {
    getOutline.mockResolvedValue([node('One', 0), node('Two', 5), node('Three', 10)]);
    setup(<Outline />);
    await screen.findByRole('tree');
    expect(screen.getByRole('treeitem', { name: /One/ }).getAttribute('aria-current')).toBe('location');
    vi.useFakeTimers();
    act(() => {
      useView.getState().reportPage(1, 5);
      publishViewRect({ left: 0, top: 1, right: 1, bottom: 2 });
    });
    expect(screen.getByRole('treeitem', { name: /One/ }).getAttribute('aria-current')).toBe('location');
    act(() => void vi.advanceTimersByTime(CURRENT_SETTLE_MS));
    expect(screen.getByRole('treeitem', { name: /Two/ }).getAttribute('aria-current')).toBe('location');
  });
});

describe('Outline virtualization', () => {
  it('mounts a bounded window of 10 000 nodes and keeps the focused row mounted', async () => {
    getOutline.mockResolvedValue(Array.from({ length: 10_000 }, (_, n) => node(`Row ${n}`, n)));
    setup(<Outline />);
    await screen.findByRole('tree');
    expect(items().length).toBeLessThan(40);
    expect(screen.getByRole('tree').style.height).toBe(`${10_000 * 32}px`);
    act(() => items()[0]?.focus());
    fireEvent.scroll(screen.getByRole('tree').parentElement as HTMLElement, { target: { scrollTop: 32 * 5000 } });
    expect(names()).toContain('Row 0');
    expect(items().length).toBeLessThan(60);
  });
});

describe('Outline fetch results', () => {
  it('discards an answer that arrives after the document closed', async () => {
    let resolve: (nodes: OutlineNode[]) => void = () => undefined;
    getOutline.mockReturnValue(new Promise<OutlineNode[]>((done) => (resolve = done)));
    setup(<Outline />);
    act(() => useViewer.getState().close());
    await act(async () => resolve([node('Late', 0)]));
    expect(useOutline.getState().byDoc[1]).toBeUndefined();
  });
});
