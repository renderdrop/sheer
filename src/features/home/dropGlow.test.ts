// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';

import { DROP_GLOW_FIXED, proximityOpacity, startDropGlow } from './dropGlow';

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('drop glow proximity (MOTION spell 4)', () => {
  it('maps the centre to 1.0 and the edge to 0.35, linearly between', () => {
    expect(proximityOpacity(500, 400, 1000, 800)).toBeCloseTo(1);
    expect(proximityOpacity(0, 400, 1000, 800)).toBeCloseTo(0.35);
    expect(proximityOpacity(1000, 400, 1000, 800)).toBeCloseTo(0.35);
    expect(proximityOpacity(500, 0, 1000, 800)).toBeCloseTo(0.35);
    expect(proximityOpacity(250, 400, 1000, 800)).toBeCloseTo(0.675);
    expect(proximityOpacity(-50, -50, 1000, 800)).toBeCloseTo(0.35);
  });

  it('falls back to the fixed value for an empty window', () => {
    expect(proximityOpacity(1, 1, 0, 0)).toBe(DROP_GLOW_FIXED);
  });

  it('follows the cursor once per frame and stops on release', () => {
    vi.stubGlobal('matchMedia', () => ({ matches: false }));
    const frames: FrameRequestCallback[] = [];
    vi.spyOn(window, 'requestAnimationFrame').mockImplementation((cb) => frames.push(cb));
    const cancel = vi.spyOn(window, 'cancelAnimationFrame').mockImplementation(() => undefined);
    Object.defineProperty(window, 'innerWidth', { value: 1000, configurable: true });
    Object.defineProperty(window, 'innerHeight', { value: 800, configurable: true });
    const element = document.createElement('div');
    const stop = startDropGlow(element);
    expect(element.style.opacity).toBe('0.6');
    frames.shift()?.(0);
    expect(element.style.opacity).toBe('0.6');
    window.dispatchEvent(Object.assign(new Event('dragover'), { clientX: 500, clientY: 400 }));
    frames.shift()?.(16);
    expect(Number(element.style.opacity)).toBeCloseTo(1);
    window.dispatchEvent(Object.assign(new Event('dragover'), { clientX: 0, clientY: 400 }));
    frames.shift()?.(32);
    expect(Number(element.style.opacity)).toBeCloseTo(0.35);
    stop();
    expect(cancel).toHaveBeenCalled();
  });

  it('reduced motion: a fixed 0.6 and no frames', () => {
    vi.stubGlobal('matchMedia', () => ({ matches: true }));
    const raf = vi.spyOn(window, 'requestAnimationFrame');
    const element = document.createElement('div');
    startDropGlow(element)();
    expect(element.style.opacity).toBe('0.6');
    expect(raf).not.toHaveBeenCalled();
  });
});
