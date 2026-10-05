// @vitest-environment jsdom
import { act, render } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { Skeleton, shimmerRuns } from '../../components/Skeleton';
import { CURSOR_HOTSPOTS, cursorForTool } from './cursors';
import { readFileSync } from 'node:fs';
import { HOLD_OUTLINE_MS, PULSE_STEP_MS, SCROLL_MAX_MS, SCROLL_MIN_MS, jumpDurationMs, pulseAnnotation } from './jump';
import { STAGGER_MAX, staggerDelayMs } from './openTransition';
import { endJump, waitForJumpEnd } from './scrollBridge';

describe('spell 3: thumbnail stagger', () => {
  it('is 20 ms apart and capped at the tenth', () => {
    expect([0, 1, 2, 9].map(staggerDelayMs)).toEqual([0, 20, 40, 180]);
    expect(staggerDelayMs(10)).toBe(180);
    expect(staggerDelayMs(500)).toBe(180);
    expect(STAGGER_MAX).toBe(10);
    expect(staggerDelayMs(-1)).toBe(0);
    expect(staggerDelayMs(Number.NaN)).toBe(0);
  });
});

describe('spell 8: comment jump', () => {
  it('scales the scroll time with the distance and never exceeds --motion-scroll-max', () => {
    expect(jumpDurationMs(1, 800)).toBeCloseTo(SCROLL_MIN_MS, 0);
    expect(jumpDurationMs(800, 800)).toBeGreaterThan(jumpDurationMs(200, 800));
    expect(jumpDurationMs(1600, 800)).toBe(SCROLL_MAX_MS);
    expect(jumpDurationMs(1e9, 800)).toBe(SCROLL_MAX_MS);
    expect(jumpDurationMs(100, 0)).toBe(SCROLL_MIN_MS);
    expect(SCROLL_MAX_MS).toBe(300);
  });

  describe('the pulse', () => {
    let frame: HTMLDivElement;
    const matchMedia = (reduce: boolean) =>
      vi.fn((query: string) => ({ matches: reduce && query.includes('prefers-reduced-motion') }));

    beforeEach(() => {
      vi.useFakeTimers();
      frame = document.createElement('div');
      frame.setAttribute('data-annot-frame', '7');
      frame.animate = vi.fn();
      document.body.append(frame);
    });
    afterEach(() => {
      vi.useRealTimers();
      frame.remove();
      vi.unstubAllGlobals();
    });

    it('fades 1, 0.4, 1 once', () => {
      vi.stubGlobal('matchMedia', matchMedia(false));
      pulseAnnotation(7);
      vi.advanceTimersByTime(50);
      expect(frame.animate).toHaveBeenCalledTimes(1);
      const [keyframes, options] = vi.mocked(frame.animate).mock.calls[0] as [
        { opacity: number[] },
        KeyframeAnimationOptions,
      ];
      expect(keyframes.opacity).toEqual([1, 0.4, 1]);
      expect(options.duration).toBe(240);
    });

    it('with reduced motion shows a 2 px Ink outline for a second and does not pulse', () => {
      vi.stubGlobal('matchMedia', matchMedia(true));
      pulseAnnotation(7);
      vi.advanceTimersByTime(50);
      expect(frame.animate).not.toHaveBeenCalled();
      expect(frame.style.outline).toContain('--outline-jump');
      vi.advanceTimersByTime(1000);
      expect(frame.style.outline).toBe('');
    });
  });

  it('the pulse waits for the end of the scroll, or for the fallback', () => {
    vi.useFakeTimers();
    const first = vi.fn();
    waitForJumpEnd(first, 420);
    vi.advanceTimersByTime(100);
    expect(first).not.toHaveBeenCalled();
    endJump();
    expect(first).toHaveBeenCalledTimes(1);
    const second = vi.fn();
    waitForJumpEnd(second, 420);
    vi.advanceTimersByTime(421);
    expect(second).toHaveBeenCalledTimes(1);
    endJump();
    expect(second).toHaveBeenCalledTimes(1);
    vi.useRealTimers();
  });
});

describe('spell 12: cursors', () => {
  it('maps the tools of the brief and leaves the rest alone', () => {
    expect(cursorForTool('highlight')).toBe('marker');
    expect(cursorForTool('draw')).toBe('pen');
    expect(cursorForTool('shapes')).toBe('crosshair');
    expect(cursorForTool('text')).toBe('text');
    expect(cursorForTool('select')).toBeUndefined();
    expect(cursorForTool('hand')).toBeUndefined();
  });

  it('has hotspots inside the 16 px cursor', () => {
    for (const [x, y] of Object.values(CURSOR_HOTSPOTS)) {
      expect(x).toBeGreaterThanOrEqual(0);
      expect(x).toBeLessThan(16);
      expect(y).toBeLessThan(16);
    }
  });
});

describe('spell 15: skeleton loop', () => {
  it('runs only on screen and with a visible window', () => {
    expect(shimmerRuns(true, true)).toBe(true);
    expect(shimmerRuns(false, true)).toBe(false);
    expect(shimmerRuns(true, false)).toBe(false);
  });

  it('pauses when the document is hidden and resumes when it is shown again', () => {
    const { container } = render(<Skeleton />);
    const block = container.querySelector('[data-skeleton]') as HTMLElement;
    expect(block.hasAttribute('data-paused')).toBe(false);
    const hidden = vi.spyOn(document, 'hidden', 'get');
    hidden.mockReturnValue(true);
    act(() => {
      document.dispatchEvent(new Event('visibilitychange'));
    });
    expect(block.hasAttribute('data-paused')).toBe(true);
    hidden.mockReturnValue(false);
    act(() => {
      document.dispatchEvent(new Event('visibilitychange'));
    });
    expect(block.hasAttribute('data-paused')).toBe(false);
    hidden.mockRestore();
  });

  it('pauses when it leaves the screen', () => {
    let notify: IntersectionObserverCallback = () => undefined;
    vi.stubGlobal(
      'IntersectionObserver',
      class {
        constructor(callback: IntersectionObserverCallback) {
          notify = callback;
        }
        observe() {}
        disconnect() {}
      },
    );
    const { container } = render(<Skeleton />);
    const block = container.querySelector('[data-skeleton]') as HTMLElement;
    act(() => notify([{ isIntersecting: false } as IntersectionObserverEntry], {} as IntersectionObserver));
    expect(block.hasAttribute('data-paused')).toBe(true);
    vi.unstubAllGlobals();
  });
});

describe('spell 8 constants mirror tokens.css', () => {
  it('matches the tokens', () => {
    const css = readFileSync('src/styles/tokens.css', 'utf8');
    const ms = (name: string) => Number(css.split(name + ':')[1]?.split('ms')[0]);
    expect(SCROLL_MAX_MS).toBe(ms('--motion-scroll-max'));
    expect(SCROLL_MIN_MS).toBe(ms('--motion-base'));
    expect(PULSE_STEP_MS).toBe(ms('--motion-fast'));
    expect(HOLD_OUTLINE_MS).toBe(ms('--hold-outline'));
  });
});
