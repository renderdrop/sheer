// @vitest-environment jsdom
import { act, fireEvent, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { SmartLink } from '../../api/smartLinks';
import { CSS_PX_PER_PT } from '../../lib/zoom';
import { useView } from '../../stores/view';
import { setup } from '../../test/render';
import { back } from '../history';
import { useHistoryStore } from '../history/store';
import { useMarks } from '../history/marks';
import { canvasPadding } from '../viewer/model';
import { ViewerCanvas } from '../viewer/ViewerCanvas';
import { resetViewer, showDocument, sizes } from '../viewer/viewer.testutil';
import { followLink } from './actions';

const documentsApi = vi.hoisted(() => ({ openDocumentDialog: vi.fn(), closeDocument: vi.fn() }));
const renderApi = vi.hoisted(() => ({ renderPage: vi.fn(), setViewport: vi.fn(), getPageSizes: vi.fn() }));
vi.mock('../../api/documents', () => documentsApi);
vi.mock('../../api/render', () => renderApi);

/**
 * F19.28 (v16-smartlinks "footnote p6"): a page 33 px wider than the viewport, scrolled 17 px sideways, follows a footnote and
 * comes back. jsdom has no layout, so the scroll region is given the geometry a browser computes: its client box is the viewport
 * plus the padding, its scroll extent the content box plus the padding, and the scroll position is clamped to that extent.
 *
 * Root cause of the failed check: the viewer restores exactly the view it saw when the link was followed, but the harness's
 * `input.hover`/`input.click` call `scrollIntoView({ inline: 'center' })` on the run after the script read its baseline, which
 * moves an overflowing page sideways (17 -> 0) before the click. The third case pins that behaviour; the script has to read its
 * baseline after the hover.
 */
const PAGE_PX = 612 * CSS_PX_PER_PT;
const OVERFLOW = 33;
const VIEWPORT = { width: Math.round(PAGE_PX) - OVERFLOW, height: 700 };
const DOC = { id: 1, pageCount: 10, displayName: 'Notes.pdf' };

const region = () => screen.getByRole('region', { name: 'Document' });

const descriptors = ['scrollLeft', 'scrollTop', 'scrollWidth', 'scrollHeight', 'clientWidth', 'clientHeight'] as const;
const saved = new Map<string, PropertyDescriptor | undefined>();
const positions = new WeakMap<Element, { left: number; top: number }>();

/** The geometry of the canvas's scroll region as a browser lays it out; other elements keep jsdom's. */
function emulateScroller(): void {
  const pad = canvasPadding();
  const isRegion = (el: Element) => el.getAttribute('role') === 'region';
  const content = (el: Element) => el.querySelector<HTMLElement>('[data-canvas-content]');
  const extent = (el: Element) => ({
    width: (Number.parseFloat(content(el)?.style.width ?? '0') || 0) + 2 * pad,
    height: (Number.parseFloat(content(el)?.style.height ?? '0') || 0) + 2 * pad,
  });
  const client = () => ({ width: VIEWPORT.width + 2 * pad, height: VIEWPORT.height + 2 * pad });
  const at = (el: Element) => positions.get(el) ?? { left: 0, top: 0 };
  const proto = HTMLElement.prototype;
  for (const name of descriptors) saved.set(name, Object.getOwnPropertyDescriptor(proto, name));
  const clamp = (value: number, max: number) => Math.min(Math.max(0, max), Math.max(0, value));
  Object.defineProperty(proto, 'scrollLeft', {
    configurable: true,
    get(this: HTMLElement) {
      return at(this).left;
    },
    set(this: HTMLElement, value: number) {
      const max = isRegion(this) ? extent(this).width - client().width : Number.POSITIVE_INFINITY;
      positions.set(this, { ...at(this), left: clamp(value, max) });
    },
  });
  Object.defineProperty(proto, 'scrollTop', {
    configurable: true,
    get(this: HTMLElement) {
      return at(this).top;
    },
    set(this: HTMLElement, value: number) {
      const max = isRegion(this) ? extent(this).height - client().height : Number.POSITIVE_INFINITY;
      positions.set(this, { ...at(this), top: clamp(value, max) });
    },
  });
  const getter = (pick: (el: HTMLElement) => number) => ({
    configurable: true,
    get(this: HTMLElement) {
      return isRegion(this) ? pick(this) : 0;
    },
  });
  Object.defineProperty(
    proto,
    'scrollWidth',
    getter((el) => extent(el).width),
  );
  Object.defineProperty(
    proto,
    'scrollHeight',
    getter((el) => extent(el).height),
  );
  Object.defineProperty(
    proto,
    'clientWidth',
    getter(() => client().width),
  );
  Object.defineProperty(
    proto,
    'clientHeight',
    getter(() => client().height),
  );
}

function restoreScroller(): void {
  for (const name of descriptors) {
    const descriptor = saved.get(name);
    if (descriptor === undefined) Reflect.deleteProperty(HTMLElement.prototype, name);
    else Object.defineProperty(HTMLElement.prototype, name, descriptor);
  }
  saved.clear();
}

/** The user (or the browser's scroll) moves the region; the canvas hears of it as of a scroll event. */
function scrollTo(top: number, left: number): void {
  const scroller = region();
  scroller.scrollTop = top;
  scroller.scrollLeft = left;
  fireEvent.scroll(scroller);
}

const footnote: SmartLink = {
  kind: 'footnote',
  rects: [{ x: 80, y: 300, w: 8, h: 10 }],
  marker: '3',
  target: { pageId: 8, rect: { x: 72, y: 700, w: 300, h: 12 } },
  preview: 'The note text.',
};

function follow(): void {
  act(() => followLink(DOC.id, 5, { type: 'smart', key: 'f3', order: footnote.rects[0]!, link: footnote }));
  fireEvent.scroll(region());
}

function goBack(): void {
  act(() => back(DOC.id));
  fireEvent.scroll(region());
}

beforeEach(() => {
  documentsApi.closeDocument.mockReset().mockResolvedValue(undefined);
  renderApi.renderPage.mockReset().mockImplementation(() => new Promise(() => undefined));
  renderApi.setViewport.mockReset().mockResolvedValue(undefined);
  renderApi.getPageSizes.mockReset().mockResolvedValue([]);
  resetViewer();
  useHistoryStore.setState({ byDoc: {} });
  useMarks.setState({ mark: null });
  URL.createObjectURL = vi.fn(() => 'blob:page');
  URL.revokeObjectURL = vi.fn();
  emulateScroller();
  showDocument(DOC, { sizes: sizes(DOC.pageCount), viewport: VIEWPORT });
  useView.getState().setZoom(DOC.id, 1);
});

afterEach(() => {
  restoreScroller();
  resetViewer();
});

describe('Back after a smart link restores the horizontal and the vertical scroll (F19.28)', () => {
  it('a page 33 px wider than the viewport, centred (17 px): back lands on 17 px and the same top', () => {
    setup(<ViewerCanvas />);
    // The overflow is centred while the user has not scrolled sideways: half of 33 px.
    expect(region().scrollLeft).toBeCloseTo(OVERFLOW / 2);
    const top = 5 * (792 * CSS_PX_PER_PT + 24) + 200;
    scrollTo(top, 17);
    const before = { left: region().scrollLeft, top: region().scrollTop };
    expect(before.left).toBe(17);

    follow();
    expect(Math.abs(region().scrollTop - before.top)).toBeGreaterThan(1000);

    goBack();
    expect(Math.abs(region().scrollLeft - before.left)).toBeLessThanOrEqual(1);
    expect(Math.abs(region().scrollTop - before.top)).toBeLessThanOrEqual(1);
  });

  it('after the user scrolled sideways themselves (0 -> 17), back lands on 17 px exactly', () => {
    setup(<ViewerCanvas />);
    const top = 5 * (792 * CSS_PX_PER_PT + 24) + 200;
    scrollTo(top, 0);
    scrollTo(top, 17);
    follow();
    // The view the link left is somewhere else: a sideways scroll on the target page does not leak into the return.
    scrollTo(region().scrollTop, 30);
    goBack();
    expect(region().scrollLeft).toBe(17);
    expect(region().scrollTop).toBeCloseTo(top, 0);
  });

  it('returns to the view at the moment the link was followed (what the acceptance harness had moved before its click)', () => {
    setup(<ViewerCanvas />);
    const top = 5 * (792 * CSS_PX_PER_PT + 24) + 200;
    scrollTo(top, 17);
    // `input.hover`/`input.click` of the CDP harness call `scrollIntoView({ inline: 'center' })` on the run first: a run left of
    // the middle scrolls the region to 0 after the script had read 17 as its baseline.
    scrollTo(top, 0);
    follow();
    goBack();
    expect(region().scrollLeft).toBe(0);
  });
});
