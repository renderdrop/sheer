// @vitest-environment jsdom
import { fireEvent, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { setup } from '../../test/render';
import { Canvas, PAGE_TURN_COOLDOWN_MS, type CanvasProps } from './Canvas';

const props = (overrides: Partial<CanvasProps> = {}): CanvasProps => ({
  content: { width: 900, height: 3000 },
  pageCount: 3,
  busy: false,
  onWheelZoom: vi.fn(),
  ...overrides,
});

const region = () => screen.getByRole('region', { name: 'Document' });
const scrim = (container: HTMLElement) => container.querySelector('[data-scrim]');
const content = (container: HTMLElement) => container.querySelector<HTMLElement>('main [role="region"] > div');

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('Canvas (DESIGN 2)', () => {
  it('is the main landmark with one focusable, labelled scroll region', () => {
    const { container } = setup(<Canvas {...props()} />);
    expect(container.querySelector('main')).not.toBeNull();
    expect(region().tabIndex).toBe(0);
  });

  it('hosts the pages in a content box as large as the layout says, which is as large as it can be scrolled', () => {
    const { container } = setup(
      <Canvas {...props({ content: { width: 1234, height: 5678 } })}>
        <div data-testid="page" />
      </Canvas>,
    );
    const box = content(container);
    expect(box?.style.width).toBe('1234px');
    expect(box?.style.height).toBe('5678px');
    // The pages are placed in it by their own offsets, so it is their positioning context and never moves them itself.
    expect(box?.className).toContain('relative');
    expect(box?.contains(screen.getByTestId('page'))).toBe(true);
  });

  it('is opaque canvas with radius 16 and padding 24 through tokens, and isolates its own layers', () => {
    const { container } = setup(<Canvas {...props()} />);
    const slot = container.querySelector('main');
    expect(slot?.className).toContain('surface-canvas');
    expect(slot?.className).toContain('rounded-panel');
    expect(slot?.className).toContain('isolate');
    expect(slot?.className).not.toContain('glass');
    expect(region().className).toContain('p-3');
    expect(region().className).toContain('scroll-pt-3');
    // The viewer places the scroll position itself, so the browser does not try to keep it too.
    expect(region().className).toContain('overflow-anchor:none');
  });

  it('shows a message for a document without pages, and nothing while the layout is not there yet', () => {
    const { container, rerender } = setup(<Canvas {...props({ pageCount: 0, content: null })} />);
    expect(screen.getByText('This document has no pages.')).not.toBeNull();
    rerender(<Canvas {...props({ content: null })} />);
    expect(content(container)).toBeNull();
    expect(screen.queryByText('This document has no pages.')).toBeNull();
  });

  it('marks the region busy while a render is in flight', () => {
    const { rerender } = setup(<Canvas {...props()} />);
    expect(region().getAttribute('aria-busy')).toBe('false');
    rerender(<Canvas {...props({ busy: true })} />);
    expect(region().getAttribute('aria-busy')).toBe('true');
  });

  it('gives the scroll region to whoever asks, and takes it back when it goes away', () => {
    const onRegion = vi.fn();
    const { unmount } = setup(<Canvas {...props({ onRegion })} />);
    expect(onRegion).toHaveBeenLastCalledWith(region());
    unmount();
    expect(onRegion).toHaveBeenLastCalledWith(null);
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

  describe('scrolling', () => {
    it('reports where the region is scrolled to, on every scroll event', () => {
      const onScroll = vi.fn();
      setup(<Canvas {...props({ onScroll })} />);
      const scroller = region();
      scroller.scrollTop = 120;
      scroller.scrollLeft = 30;
      fireEvent.scroll(scroller);
      scroller.scrollTop = 480;
      fireEvent.scroll(scroller);
      expect(onScroll.mock.calls).toEqual([[{ left: 30, top: 120 }], [{ left: 30, top: 480 }]]);
    });
  });

  describe('zoom by wheel and pinch', () => {
    /** The content box as the browser would place it: the scroll region's corner, plus its padding, minus the scroll. */
    function placeContent(
      container: HTMLElement,
      scroll: { left: number; top: number },
      corner = { left: 100, top: 50 },
    ) {
      region().scrollLeft = scroll.left;
      region().scrollTop = scroll.top;
      const box = content(container);
      vi.spyOn(box as HTMLElement, 'getBoundingClientRect').mockReturnValue({
        left: corner.left + 24 - scroll.left,
        top: corner.top + 24 - scroll.top,
        right: 0,
        bottom: 0,
        width: 0,
        height: 0,
        x: 0,
        y: 0,
        toJSON: () => ({}),
      });
    }

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
      expect(onWheelZoom).toHaveBeenCalledWith(-100, 0, expect.anything());
      expect(event.defaultPrevented).toBe(true);
    });

    it('Cmd+wheel zooms as well', () => {
      const onWheelZoom = vi.fn();
      setup(<Canvas {...props({ onWheelZoom })} />);
      region().dispatchEvent(new WheelEvent('wheel', { deltaY: 40, metaKey: true, bubbles: true, cancelable: true }));
      expect(onWheelZoom).toHaveBeenCalledWith(40, 0, expect.anything());
    });

    it('centres the zoom on the pointer: its position in the region, whatever the scroll position is', () => {
      const onWheelZoom = vi.fn();
      const { container } = setup(<Canvas {...props({ onWheelZoom })} />);
      // The region is at (100, 50) with 24 px of padding, scrolled by (40, 300): the pointer at (400, 250) is at
      // (400 - 100 - 24, 250 - 50 - 24) = (276, 176) in the region's content box, scrolled or not.
      placeContent(container, { left: 40, top: 300 });
      region().dispatchEvent(
        new WheelEvent('wheel', {
          deltaY: -60,
          ctrlKey: true,
          clientX: 400,
          clientY: 250,
          bubbles: true,
          cancelable: true,
        }),
      );
      expect(onWheelZoom).toHaveBeenCalledWith(-60, 0, { x: 276, y: 176 });
      placeContent(container, { left: 0, top: 0 });
      region().dispatchEvent(
        new WheelEvent('wheel', {
          deltaY: 60,
          ctrlKey: true,
          clientX: 124,
          clientY: 74,
          bubbles: true,
          cancelable: true,
        }),
      );
      expect(onWheelZoom).toHaveBeenLastCalledWith(60, 0, { x: 0, y: 0 });
    });

    it('has no centre to give when there is no content (the zoom then takes the middle of the viewport)', () => {
      const onWheelZoom = vi.fn();
      setup(<Canvas {...props({ onWheelZoom, content: null })} />);
      region().dispatchEvent(new WheelEvent('wheel', { deltaY: -60, ctrlKey: true, bubbles: true, cancelable: true }));
      expect(onWheelZoom).toHaveBeenCalledWith(-60, 0, undefined);
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

    it('uses the latest callback without listening again', () => {
      const first = vi.fn();
      const second = vi.fn();
      const { rerender } = setup(<Canvas {...props({ onWheelZoom: first })} />);
      rerender(<Canvas {...props({ onWheelZoom: second })} />);
      region().dispatchEvent(new WheelEvent('wheel', { deltaY: -10, ctrlKey: true, bubbles: true, cancelable: true }));
      expect(first).not.toHaveBeenCalled();
      expect(second).toHaveBeenCalledTimes(1);
    });

    /** A WebKit gesture event: the pinch of WKWebView, which has no wheel event for it. */
    function gesture(type: string, scale: number, clientX = 0, clientY = 0): Event {
      const event = new Event(type, { bubbles: true, cancelable: true });
      return Object.assign(event, { scale, clientX, clientY });
    }

    it('turns the pinch of WKWebView into zoom factors around the fingers, and keeps the browser from zooming the page', () => {
      const onPinch = vi.fn();
      const { container } = setup(<Canvas {...props({ onPinch })} />);
      placeContent(container, { left: 0, top: 0 });
      const start = gesture('gesturestart', 1);
      region().dispatchEvent(start);
      expect(start.defaultPrevented).toBe(true);
      // The scale is since the start of the gesture: the factor of each step is the ratio to the one before.
      const first = gesture('gesturechange', 1.1, 224, 174);
      region().dispatchEvent(first);
      region().dispatchEvent(gesture('gesturechange', 1.21, 224, 174));
      region().dispatchEvent(gesture('gesturechange', 0.9, 124, 74));
      expect(first.defaultPrevented).toBe(true);
      expect(onPinch).toHaveBeenCalledTimes(3);
      expect(onPinch.mock.calls[0]?.[0]).toBeCloseTo(1.1);
      expect(onPinch.mock.calls[0]?.[1]).toEqual({ x: 100, y: 100 });
      expect(onPinch.mock.calls[1]?.[0]).toBeCloseTo(1.1);
      expect(onPinch.mock.calls[2]?.[0]).toBeCloseTo(0.9 / 1.21);
      expect(onPinch.mock.calls[2]?.[1]).toEqual({ x: 0, y: 0 });
      const end = gesture('gestureend', 0.9);
      region().dispatchEvent(end);
      expect(end.defaultPrevented).toBe(true);
    });

    it('starts again at 1 with the next gesture', () => {
      const onPinch = vi.fn();
      const { container } = setup(<Canvas {...props({ onPinch })} />);
      placeContent(container, { left: 0, top: 0 });
      region().dispatchEvent(gesture('gesturestart', 1));
      region().dispatchEvent(gesture('gesturechange', 2, 124, 74));
      region().dispatchEvent(gesture('gesturestart', 1));
      region().dispatchEvent(gesture('gesturechange', 1.5, 124, 74));
      expect(onPinch.mock.calls.map(([factor]) => factor)).toEqual([2, 1.5]);
    });

    it('ignores a gesture without content to centre it on, and a scale that is not a number', () => {
      const onPinch = vi.fn();
      const { container } = setup(<Canvas {...props({ onPinch })} />);
      placeContent(container, { left: 0, top: 0 });
      region().dispatchEvent(gesture('gesturestart', 1));
      region().dispatchEvent(gesture('gesturechange', Number.NaN, 124, 74));
      region().dispatchEvent(gesture('gesturechange', 0, 124, 74));
      expect(onPinch).not.toHaveBeenCalled();
    });
  });

  describe('turning pages with the wheel in a paged mode', () => {
    function wheel(deltaY: number) {
      region().dispatchEvent(new WheelEvent('wheel', { deltaY, bubbles: true, cancelable: true }));
    }

    it('turns to the next page when the wheel goes down at the end of the page, and back when it goes up at the top', () => {
      const onPageTurn = vi.fn();
      vi.spyOn(performance, 'now').mockReturnValue(10_000);
      setup(<Canvas {...props({ paged: true, onPageTurn })} />);
      // jsdom has no layout: the region is 0 high, scrolled to 0, which is both the top and the end.
      wheel(120);
      expect(onPageTurn).toHaveBeenLastCalledWith(1);
      vi.spyOn(performance, 'now').mockReturnValue(10_000 + PAGE_TURN_COOLDOWN_MS);
      wheel(-120);
      expect(onPageTurn).toHaveBeenLastCalledWith(-1);
    });

    it('waits between turns: the inertia of a trackpad would otherwise turn a dozen pages', () => {
      const onPageTurn = vi.fn();
      const now = vi.spyOn(performance, 'now');
      setup(<Canvas {...props({ paged: true, onPageTurn })} />);
      now.mockReturnValue(5000);
      wheel(120);
      now.mockReturnValue(5000 + PAGE_TURN_COOLDOWN_MS - 1);
      wheel(120);
      wheel(40);
      expect(onPageTurn).toHaveBeenCalledTimes(1);
      now.mockReturnValue(5000 + PAGE_TURN_COOLDOWN_MS);
      wheel(120);
      expect(onPageTurn).toHaveBeenCalledTimes(2);
    });

    it('does not turn while the page can still be scrolled that way', () => {
      const onPageTurn = vi.fn();
      vi.spyOn(performance, 'now').mockReturnValue(10_000);
      setup(<Canvas {...props({ paged: true, onPageTurn })} />);
      const scroller = region();
      Object.defineProperty(scroller, 'clientHeight', { value: 600, configurable: true });
      Object.defineProperty(scroller, 'scrollHeight', { value: 2000, configurable: true });
      scroller.scrollTop = 500;
      wheel(120);
      wheel(-120);
      expect(onPageTurn).not.toHaveBeenCalled();
      // Scrolled to the end: down turns, up does not.
      scroller.scrollTop = 1400;
      wheel(-120);
      expect(onPageTurn).not.toHaveBeenCalled();
      wheel(120);
      expect(onPageTurn).toHaveBeenCalledWith(1);
    });

    it('does nothing in continuous scrolling, without a handler, or for a wheel that does not move', () => {
      const onPageTurn = vi.fn();
      vi.spyOn(performance, 'now').mockReturnValue(10_000);
      const { rerender } = setup(<Canvas {...props({ paged: false, onPageTurn })} />);
      wheel(120);
      rerender(<Canvas {...props({ paged: true, onPageTurn })} />);
      wheel(0);
      expect(onPageTurn).not.toHaveBeenCalled();
      rerender(<Canvas {...props({ paged: true })} />);
      expect(() => wheel(120)).not.toThrow();
    });
  });

  describe('its size, for the layout and the fits', () => {
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
