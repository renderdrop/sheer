// @vitest-environment jsdom
import { fireEvent, render } from '@testing-library/react';
import { useRef } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { useFloatingPosition } from './useFloatingPosition';

/** A rect the way `getBoundingClientRect` reports it. */
function rect(left: number, top: number, width: number, height: number): DOMRect {
  return { left, top, width, height, right: left + width, bottom: top + height, x: left, y: top, toJSON: () => ({}) };
}

/** The animation frames the hook asks for, run by hand so a test decides when a frame happens. */
let frames: Map<number, FrameRequestCallback>;
let nextFrame: number;
const requestFrame = vi.fn((callback: FrameRequestCallback) => {
  nextFrame += 1;
  frames.set(nextFrame, callback);
  return nextFrame;
});
const cancelFrame = vi.fn((handle: number) => {
  frames.delete(handle);
});

function runFrame(): void {
  const pending = [...frames.values()];
  frames.clear();
  for (const callback of pending) callback(0);
}

/** Where the mocked anchor is. A test moves it between frames. */
let anchorRect: DOMRect;
let rectReads: number;
let blockerRect: DOMRect;

beforeEach(() => {
  frames = new Map();
  nextFrame = 0;
  requestFrame.mockClear();
  cancelFrame.mockClear();
  vi.stubGlobal('requestAnimationFrame', requestFrame);
  vi.stubGlobal('cancelAnimationFrame', cancelFrame);
  anchorRect = rect(100, 100, 40, 32);
  rectReads = 0;
  blockerRect = rect(0, 0, 0, 0);
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (this: HTMLElement) {
    rectReads += 1;
    if (this.dataset.slot !== undefined) return rect(50, 0, 310, 500);
    if (this.dataset.avoid !== undefined) return rect(0, 0, 500, 200);
    if (this.dataset.blocker !== undefined) return blockerRect;
    return this.tagName === 'BUTTON' ? anchorRect : rect(0, 0, 200, 100);
  });
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

function Harness({ active = true, clearOf }: { active?: boolean; clearOf?: string }) {
  const anchor = useRef<HTMLButtonElement>(null);
  const floating = useRef<HTMLDivElement>(null);
  useFloatingPosition({
    anchor,
    floatingRef: floating,
    active,
    side: 'bottom',
    align: 'start',
    ...(clearOf === undefined ? {} : { clearOf }),
  });
  return (
    <>
      <button ref={anchor} type="button">
        anchor
      </button>
      <div data-avoid="" />
      <div ref={floating} data-testid="floating">
        <div data-testid="inner" />
      </div>
    </>
  );
}

describe('useFloatingPosition', () => {
  it('places the element before anything else happens, at the anchor with the 8 px offset', () => {
    const { getByTestId } = render(<Harness />);
    const floating = getByTestId('floating');
    expect(floating.style.left).toBe('100px');
    expect(floating.style.top).toBe('140px');
    expect(floating.dataset.side).toBe('bottom');
    // DESIGN 3.5: the window height minus the margin on both sides (jsdom's window is 768 px high).
    expect(floating.style.maxHeight).toBe(`${window.innerHeight - 16}px`);
    expect(requestFrame).not.toHaveBeenCalled();
  });

  it('sits below the element it must clear when the anchor is above its bottom edge', () => {
    const { getByTestId } = render(<Harness clearOf="[data-avoid]" />);
    expect(getByTestId('floating').style.top).toBe('208px');
  });

  it('does nothing while it is not active', () => {
    const { getByTestId } = render(<Harness active={false} />);
    expect(getByTestId('floating').style.left).toBe('');
    fireEvent.scroll(window);
    expect(requestFrame).not.toHaveBeenCalled();
  });

  it('places once per animation frame however many scroll events arrive', () => {
    const { getByTestId } = render(<Harness />);
    const floating = getByTestId('floating');
    anchorRect = rect(100, 300, 40, 32);
    const readsAfterMount = rectReads;

    // A wheel gesture over a scrolling list fires scroll events at the rate of the input, on the window and on elements.
    for (let index = 0; index < 50; index += 1) {
      fireEvent.scroll(window);
      fireEvent.scroll(document.body);
    }
    expect(requestFrame).toHaveBeenCalledTimes(1);
    expect(rectReads).toBe(readsAfterMount);
    expect(floating.style.top).toBe('140px');

    runFrame();
    expect(rectReads).toBe(readsAfterMount + 2);
    expect(floating.style.top).toBe('340px');

    // The next burst asks for the next frame.
    fireEvent.scroll(window);
    fireEvent.scroll(window);
    expect(requestFrame).toHaveBeenCalledTimes(2);
  });

  it('follows a resize of the window on the next frame', () => {
    const { getByTestId } = render(<Harness />);
    anchorRect = rect(250, 100, 40, 32);
    fireEvent(window, new Event('resize'));
    fireEvent(window, new Event('resize'));
    expect(requestFrame).toHaveBeenCalledTimes(1);
    runFrame();
    expect(getByTestId('floating').style.left).toBe('250px');
  });

  it('ignores a scroll inside the floating element, which cannot move it', () => {
    const { getByTestId } = render(<Harness />);
    fireEvent.scroll(getByTestId('inner'));
    fireEvent.scroll(getByTestId('floating'));
    expect(requestFrame).not.toHaveBeenCalled();
  });

  it('cancels the frame it asked for when it stops, and places nothing afterwards', () => {
    const { unmount } = render(<Harness />);
    fireEvent.scroll(window);
    expect(requestFrame).toHaveBeenCalledTimes(1);
    const readsBefore = rectReads;
    unmount();
    expect(cancelFrame).toHaveBeenCalledWith(1);
    runFrame();
    expect(rectReads).toBe(readsBefore);
    // Its listeners are gone with it.
    fireEvent.scroll(window);
    expect(requestFrame).toHaveBeenCalledTimes(1);
  });

  it('reads the offset token once, not on every placement', () => {
    const computed = vi.spyOn(window, 'getComputedStyle');
    render(<Harness />);
    const reads = () => computed.mock.calls.filter(([element]) => element === document.documentElement).length;
    expect(reads()).toBe(1);
    for (let index = 0; index < 5; index += 1) {
      fireEvent.scroll(window);
      runFrame();
    }
    expect(reads()).toBe(1);
  });

  it('writes a style only when its value changed', () => {
    const { getByTestId } = render(<Harness />);
    const floating = getByTestId('floating');
    const observer = new MutationObserver(() => undefined);
    observer.observe(floating, { attributes: true });

    fireEvent.scroll(window);
    runFrame();
    expect(observer.takeRecords()).toHaveLength(0);

    anchorRect = rect(100, 200, 40, 32);
    fireEvent.scroll(window);
    runFrame();
    expect(observer.takeRecords().length).toBeGreaterThan(0);
    expect(floating.style.top).toBe('240px');
    observer.disconnect();
  });

  describe('a notice that does not fit (DESIGN 3.9 Q8)', () => {
    function Notice() {
      const anchor = useRef<HTMLButtonElement>(null);
      const floating = useRef<HTMLDivElement>(null);
      useFloatingPosition({
        anchor,
        floatingRef: floating,
        active: true,
        side: 'bottom',
        align: 'start',
        kind: 'coach',
      });
      return (
        <>
          <button ref={anchor} type="button">
            anchor
          </button>
          <div data-blocker="" role="button" tabIndex={0} />
          <div ref={floating} data-testid="floating" />
        </>
      );
    }
    const coversAll = () => rect(0, 0, 5000, 5000);
    const free = () => rect(0, 0, 0, 0);
    const retry = () => {
      fireEvent.scroll(window);
      runFrame();
    };

    it('is hidden while no candidate fits and shown again when space frees', () => {
      blockerRect = coversAll();
      const { getByTestId } = render(<Notice />);
      const floating = getByTestId('floating');
      expect(floating.style.visibility).toBe('hidden');
      blockerRect = free();
      retry();
      expect(floating.style.visibility).toBe('');
      expect(floating.style.left).not.toBe('');
    });

    it('stays hidden for as long as the space is taken, however often it is tried', () => {
      blockerRect = coversAll();
      const { getByTestId } = render(<Notice />);
      retry();
      retry();
      retry();
      expect(getByTestId('floating').style.visibility).toBe('hidden');
      expect(getByTestId('floating').style.left).toBe('');
    });

    it('hides again when the space is taken once more after it was shown', () => {
      const { getByTestId } = render(<Notice />);
      const floating = getByTestId('floating');
      expect(floating.style.visibility).toBe('');
      blockerRect = coversAll();
      retry();
      expect(floating.style.visibility).toBe('hidden');
      blockerRect = free();
      retry();
      expect(floating.style.visibility).toBe('');
    });
  });

  describe('clampTo', () => {
    function Clamped({ clamp }: { clamp: boolean }) {
      const anchor = useRef<HTMLButtonElement>(null);
      const floating = useRef<HTMLDivElement>(null);
      useFloatingPosition({
        anchor,
        floatingRef: floating,
        active: true,
        side: 'bottom',
        align: 'start',
        clampTo: clamp ? { selector: '[data-slot]', inset: 16 } : undefined,
      });
      return (
        <>
          <div data-slot="" />
          <button ref={anchor} type="button">
            anchor
          </button>
          <div ref={floating} data-testid="floating" />
        </>
      );
    }
    /** The slot's content box starts at 50 and is 300 wide (a 10 px scrollbar already taken off); the card is 200 wide. */
    function mockSlot(): void {
      const slot = document.querySelector<HTMLElement>('[data-slot]');
      if (slot === null) return;
      Object.defineProperty(slot, 'clientLeft', { value: 0, configurable: true });
      Object.defineProperty(slot, 'clientWidth', { value: 300, configurable: true });
    }

    it('keeps the element inside the slot, inset from its edges', () => {
      anchorRect = rect(340, 100, 40, 32);
      const { getByTestId } = render(<Clamped clamp />);
      mockSlot();
      fireEvent.scroll(window);
      runFrame();
      // Right edge limit: 50 + 300 - 16 - 200 = 134.
      expect(getByTestId('floating').style.left).toBe('134px');
      anchorRect = rect(0, 100, 40, 32);
      fireEvent.scroll(window);
      runFrame();
      expect(getByTestId('floating').style.left).toBe('66px');
    });

    it('leaves the position alone when omitted', () => {
      anchorRect = rect(340, 100, 40, 32);
      const { getByTestId } = render(<Clamped clamp={false} />);
      expect(getByTestId('floating').style.left).toBe('340px');
    });
  });
});
