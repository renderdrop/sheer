// @vitest-environment jsdom
import { act, fireEvent, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { MIN_BUDGET_BYTES, RenderCache } from '../../engine/renderCache';
import { RenderScheduler, type RenderBackend } from '../../engine/renderScheduler';
import { usePages } from '../../stores/pages';
import { useView } from '../../stores/view';
import { setup } from '../../test/render';
import { resetTransition, useTransition } from '../viewer/openTransition';
import { resetViewer, showDocument } from '../viewer/viewer.testutil';
import { ThumbnailList } from './Thumbnails';

/** MOTION spells 2 (page indicator) and 9 (delete page) in the sidebar; the reduced-motion variants through a matchMedia mock. */

const reduced = { on: false };
const observers = new Set<{ callback: ResizeObserverCallback }>();

class FakeResizeObserver {
  constructor(readonly callback: ResizeObserverCallback) {}
  observe(): void {
    observers.add(this);
    this.callback([], this as unknown as ResizeObserver);
  }
  unobserve(): void {}
  disconnect(): void {
    observers.delete(this);
  }
}

const isRegion = (element: Element) => element.className.includes('overflow-y-auto');

function scheduler(): RenderScheduler {
  const backend: RenderBackend = { render: () => new Promise(() => undefined), setViewport: () => Promise.resolve() };
  return new RenderScheduler(new RenderCache({ budgetBytes: MIN_BUDGET_BYTES, createUrl: () => 'blob:t' }), backend);
}

const indicator = () => document.querySelector<HTMLElement>('[data-thumb-indicator]');
const shift = (element: HTMLElement | null) =>
  Number.parseFloat(/translateY\(([\d.]+)px\)/.exec(element?.style.transform ?? '')?.[1] ?? 'NaN');
const go = (page: number) => act(() => useView.getState().setPage(1, page));

beforeEach(() => {
  reduced.on = false;
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
  vi.stubGlobal('ResizeObserver', FakeResizeObserver);
  vi.stubGlobal('matchMedia', (query: string) => ({
    matches: reduced.on && query.includes('reduce'),
    media: query,
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
  }));
  Object.defineProperty(HTMLElement.prototype, 'clientWidth', {
    configurable: true,
    get(this: HTMLElement) {
      return isRegion(this) ? 232 : 0;
    },
  });
  Object.defineProperty(HTMLElement.prototype, 'clientHeight', {
    configurable: true,
    get(this: HTMLElement) {
      return isRegion(this) ? 600 : 0;
    },
  });
  resetViewer();
  showDocument({ id: 1, pageCount: 500, displayName: 'Book.pdf' });
});

afterEach(() => {
  Reflect.deleteProperty(HTMLElement.prototype, 'clientWidth');
  Reflect.deleteProperty(HTMLElement.prototype, 'clientHeight');
  vi.useRealTimers();
  vi.unstubAllGlobals();
  resetViewer();
});

const list = (count = 500) => <ThumbnailList docId={1} pageCount={count} scheduler={scheduler()} />;

describe('spell 2: the page indicator', () => {
  it('is one element at the current page, not a border of the cells', () => {
    setup(list());
    expect(document.querySelectorAll('[data-thumb-indicator]')).toHaveLength(1);
    expect(indicator()?.dataset.mode).toBe('still');
    expect(indicator()?.firstElementChild?.className).toContain('border-accent');
    for (const option of screen.getAllByRole('option')) {
      expect(option.firstElementChild?.className).not.toContain('border-accent');
    }
  });

  it('travels to a near page with a translateY transition, then rests', () => {
    setup(list());
    const start = shift(indicator());
    go(1);
    expect(indicator()?.dataset.mode).toBe('travel');
    expect(shift(indicator())).toBeGreaterThan(start);
    act(() => void vi.advanceTimersByTime(200));
    expect(indicator()?.dataset.mode).toBe('still');
  });

  it('fades in at the target after a far jump (more than one viewport of thumbnails)', () => {
    setup(list());
    const start = shift(indicator());
    go(300);
    expect(indicator()?.dataset.mode).toBe('fade');
    expect(shift(indicator())).toBeGreaterThan(start + 600);
    // The fade starts from nothing and ends with the inline styles gone, so the CSS opacity transition has run its course.
    expect(indicator()?.style.opacity).toBe('');
  });

  it('under reduced motion even a near change is a fade at the target', () => {
    reduced.on = true;
    setup(list());
    go(1);
    expect(indicator()?.dataset.mode).toBe('fade');
  });

  it('a click on a thumbnail is a plain page change: the document-open spell does not play', () => {
    resetTransition();
    setup(list());
    fireEvent.click(screen.getByRole('option', { name: 'Page 2' }));
    expect(useView.getState().byDoc[1]?.pageIndex).toBe(1);
    expect(useTransition.getState().active).toBeNull();
    expect(document.querySelector('[data-open-spell], [data-entering]')).toBeNull();
  });
});

describe('spell 9: delete page in the sidebar', () => {
  const slots = (ids: readonly number[]) =>
    ids.map((id) => ({
      id,
      width: 612,
      height: 792,
      rotation: 0 as const,
      rev: 0,
      label: null,
      origin: 'file' as const,
    }));

  beforeEach(() => {
    resetViewer();
    showDocument({ id: 1, pageCount: 6, displayName: 'Six.pdf' });
    usePages.getState().setSlots(1, slots([0, 1, 2, 3, 4, 5]));
  });

  it('leaves a ghost that rotates and fades out, neighbours slide, and all is gone after the exit', () => {
    setup(list(6));
    const before = screen.getAllByRole('option').map((o) => shift(o));
    act(() => usePages.getState().setSlots(1, slots([0, 1, 3, 4, 5])));
    const ghost = document.querySelector<HTMLElement>('[data-delete-ghost]');
    expect(ghost).not.toBeNull();
    expect(ghost?.dataset.deleteGhost).toBe('out');
    expect(shift(ghost)).toBe(before[2]);
    expect(ghost?.getAttribute('aria-hidden')).toBe('true');
    // The neighbours keep their elements (keyed by page id) and move up: the list lets them transition for one base duration.
    expect(document.querySelector('[data-sliding]')).not.toBeNull();
    expect(shift(screen.getByRole('option', { name: 'Page 3' }))).toBe(before[2]);
    act(() => void vi.advanceTimersByTime(130));
    expect(document.querySelector('[data-delete-ghost]')).toBeNull();
    act(() => void vi.advanceTimersByTime(60));
    expect(document.querySelector('[data-sliding]')).toBeNull();
  });

  it('undo brings the page back and drops its ghost at once', () => {
    setup(list(6));
    act(() => usePages.getState().setSlots(1, slots([0, 1, 3, 4, 5])));
    expect(document.querySelector('[data-delete-ghost]')).not.toBeNull();
    act(() => usePages.getState().setSlots(1, slots([0, 1, 2, 3, 4, 5])));
    expect(document.querySelector('[data-delete-ghost]')).toBeNull();
  });
});

describe('spell 3: thumbnails at document open', () => {
  it('cells of a document that is opening fade in staggered by 20 ms', async () => {
    const { beginOpening } = await import('../viewer/openTransition');
    beginOpening(1);
    setup(list());
    const cells = screen.getAllByRole('option');
    expect(cells[0]?.hasAttribute('data-thumb-entrance')).toBe(true);
    expect(cells[0]?.style.transition).toContain(' 0ms');
    expect(cells[3]?.style.transition).toContain(' 60ms');
    expect(cells[0]?.style.opacity).toBe('1');
  });

  it('a page change, or a list that mounts long after the open, makes no entrance (F15 A1)', async () => {
    const { resetTransition } = await import('../viewer/openTransition');
    resetTransition();
    setup(list());
    go(1);
    expect(document.querySelector('[data-thumb-entrance]')).toBeNull();
  });
});
