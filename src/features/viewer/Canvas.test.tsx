// @vitest-environment jsdom
import { fireEvent, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { CSS_PX_PER_PT } from '../../lib/zoom';
import { setup } from '../../test/render';
import { Canvas, type CanvasProps } from './Canvas';

const props = (overrides: Partial<CanvasProps> = {}): CanvasProps => ({
  image: { url: 'blob:page', widthPt: 612, heightPt: 792 },
  zoom: 1,
  pageIndex: 0,
  pageCount: 3,
  busy: false,
  onWheelZoom: vi.fn(),
  ...overrides,
});

const region = () => screen.getByRole('region', { name: 'Document' });
const scrim = (container: HTMLElement) => container.querySelector('[data-scrim]');

describe('Canvas (DESIGN 2)', () => {
  it('is the main landmark with one focusable, labelled scroll region', () => {
    const { container } = setup(<Canvas {...props()} />);
    expect(container.querySelector('main')).not.toBeNull();
    expect(region().tabIndex).toBe(0);
  });

  it('hosts the page image at its zoomed size, with a text alternative that names the page', () => {
    setup(<Canvas {...props({ zoom: 1.5, pageIndex: 1, pageCount: 3 })} />);
    const image = screen.getByRole('img', { name: 'Page 2 of 3' });
    expect(image.getAttribute('src')).toBe('blob:page');
    expect((image as HTMLImageElement).style.width).toBe(`${Math.round(612 * CSS_PX_PER_PT * 1.5)}px`);
  });

  it('is opaque canvas with radius 16 and padding 24 through tokens, and isolates its own layers', () => {
    const { container } = setup(<Canvas {...props()} />);
    const slot = container.querySelector('main');
    expect(slot?.className).toContain('bg-canvas');
    expect(slot?.className).toContain('rounded-panel');
    expect(slot?.className).toContain('isolate');
    expect(slot?.className).not.toContain('glass');
    expect(region().className).toContain('p-3');
    expect(region().className).toContain('scroll-pt-3');
  });

  it('shows a message for a document without pages, and nothing while the first render is on its way', () => {
    const { rerender } = setup(<Canvas {...props({ pageCount: 0, image: null })} />);
    expect(screen.getByText('This document has no pages.')).not.toBeNull();
    rerender(<Canvas {...props({ image: null })} />);
    expect(screen.queryByRole('img')).toBeNull();
    expect(screen.queryByText('This document has no pages.')).toBeNull();
  });

  it('marks the region busy while a render is in flight', () => {
    const { rerender } = setup(<Canvas {...props()} />);
    expect(region().getAttribute('aria-busy')).toBe('false');
    rerender(<Canvas {...props({ busy: true })} />);
    expect(region().getAttribute('aria-busy')).toBe('true');
  });

  describe('scroll-edge scrim', () => {
    it('is the top 24 px of the canvas on layer 4 without pointer events, hidden until the region is scrolled', () => {
      const { container } = setup(<Canvas {...props()} />);
      const strip = scrim(container);
      expect(strip?.getAttribute('data-scrim')).toBe('hidden');
      expect(strip?.getAttribute('aria-hidden')).toBe('true');
      for (const className of ['canvas-scrim', 'z-canvas-scrim', 'pointer-events-none', 'top-0', 'opacity-0']) {
        expect(strip?.className, className).toContain(className);
      }
    });

    it('appears when scrollTop is above 0 and goes away at the top again', () => {
      const { container } = setup(<Canvas {...props()} />);
      const scroller = region();
      scroller.scrollTop = 40;
      fireEvent.scroll(scroller);
      expect(scrim(container)?.getAttribute('data-scrim')).toBe('visible');
      expect(scrim(container)?.className).toContain('opacity-100');
      scroller.scrollTop = 0;
      fireEvent.scroll(scroller);
      expect(scrim(container)?.getAttribute('data-scrim')).toBe('hidden');
    });

    it('is a sibling of the scroll region, not inside it, so it stays put while the pages move', () => {
      const { container } = setup(<Canvas {...props()} />);
      expect(region().contains(scrim(container))).toBe(false);
      expect(scrim(container)?.parentElement).toBe(container.querySelector('main'));
    });
  });

  describe('zoom by wheel and pinch', () => {
    it('Ctrl+wheel zooms and does not scroll', () => {
      const onWheelZoom = vi.fn();
      setup(<Canvas {...props({ onWheelZoom })} />);
      const event = new WheelEvent('wheel', {
        deltaY: -100,
        deltaMode: 0,
        ctrlKey: true,
        bubbles: true,
        cancelable: true,
      });
      region().dispatchEvent(event);
      expect(onWheelZoom).toHaveBeenCalledWith(-100, 0);
      expect(event.defaultPrevented).toBe(true);
    });

    it('Cmd+wheel zooms as well', () => {
      const onWheelZoom = vi.fn();
      setup(<Canvas {...props({ onWheelZoom })} />);
      region().dispatchEvent(new WheelEvent('wheel', { deltaY: 40, metaKey: true, bubbles: true, cancelable: true }));
      expect(onWheelZoom).toHaveBeenCalledWith(40, 0);
    });

    it('a plain wheel scrolls: it is neither handled nor cancelled', () => {
      const onWheelZoom = vi.fn();
      setup(<Canvas {...props({ onWheelZoom })} />);
      const event = new WheelEvent('wheel', { deltaY: 100, bubbles: true, cancelable: true });
      region().dispatchEvent(event);
      expect(onWheelZoom).not.toHaveBeenCalled();
      expect(event.defaultPrevented).toBe(false);
    });

    it('stops listening when it goes away', () => {
      const onWheelZoom = vi.fn();
      const { unmount } = setup(<Canvas {...props({ onWheelZoom })} />);
      const scroller = region();
      unmount();
      scroller.dispatchEvent(new WheelEvent('wheel', { deltaY: 100, ctrlKey: true, bubbles: true, cancelable: true }));
      expect(onWheelZoom).not.toHaveBeenCalled();
    });
  });

  describe('its size, for fit width and fit page', () => {
    /** A ResizeObserver that a test can fire, in place of jsdom's, which never reports anything. */
    function fakeObserver() {
      const observers: Array<{ callback: ResizeObserverCallback; observed: Element[]; disconnected: boolean }> = [];
      vi.stubGlobal(
        'ResizeObserver',
        class {
          readonly record: (typeof observers)[number];
          constructor(callback: ResizeObserverCallback) {
            this.record = { callback, observed: [], disconnected: false };
            observers.push(this.record);
          }
          observe(target: Element) {
            this.record.observed.push(target);
          }
          unobserve() {}
          disconnect() {
            this.record.disconnected = true;
          }
        },
      );
      const report = (width: number, height: number) =>
        observers.at(-1)?.callback([{ contentRect: { width, height } } as ResizeObserverEntry], {} as ResizeObserver);
      return { observers, report };
    }

    afterEach(() => vi.unstubAllGlobals());

    it('reports the size of the scroll region as its content box, and again whenever it changes, in whole pixels', () => {
      const { observers, report } = fakeObserver();
      const onViewport = vi.fn();
      setup(<Canvas {...props({ onViewport })} />);
      expect(observers).toHaveLength(1);
      expect(observers[0]?.observed).toEqual([region()]);
      report(816.7, 528.2);
      report(1000, 600);
      expect(onViewport.mock.calls).toEqual([[{ width: 816, height: 528 }], [{ width: 1000, height: 600 }]]);
    });

    it('stops observing when it goes away, and observes nothing when nobody asks', () => {
      const { observers } = fakeObserver();
      const { unmount } = setup(<Canvas {...props({ onViewport: vi.fn() })} />);
      unmount();
      expect(observers[0]?.disconnected).toBe(true);
      setup(<Canvas {...props()} />);
      expect(observers).toHaveLength(1);
    });

    it('is the canvas scope of the key handler: single-key shortcuts work with the focus inside it', () => {
      const { container } = setup(<Canvas {...props()} />);
      expect(container.querySelector('main')?.getAttribute('data-action-scope')).toBe('canvas');
      expect(region().closest('[data-action-scope="canvas"]')).not.toBeNull();
    });
  });

  describe('drop overlay (visual only)', () => {
    it('is a G2 layer inset 8 px above the pages while a file is dragged over, and absent otherwise', () => {
      const { container, rerender } = setup(<Canvas {...props()} />);
      expect(container.querySelector('[data-drop-overlay]')).toBeNull();
      rerender(<Canvas {...props({ dropActive: true })} />);
      const overlay = container.querySelector('[data-drop-overlay]');
      expect(overlay?.textContent).toBe('Drop to open');
      for (const className of ['glass-2', 'inset-1', 'z-drag', 'pointer-events-none']) {
        expect(overlay?.className, className).toContain(className);
      }
    });
  });
});
