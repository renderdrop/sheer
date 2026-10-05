// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { newRestackState, restack } from './restack';

const animate = vi.fn();
let cancelled = 0;

function column(items: Record<number, number>): HTMLElement {
  const root = document.createElement('div');
  for (const [id, top] of Object.entries(items)) {
    const element = document.createElement('div');
    element.dataset.item = id;
    element.dataset.top = String(top);
    root.append(element);
  }
  return root;
}

beforeEach(() => {
  animate.mockReset();
  cancelled = 0;
  animate.mockImplementation(() => ({ cancel: () => (cancelled += 1) }));
  (HTMLElement.prototype as unknown as { animate: unknown }).animate = animate;
});
afterEach(() => {
  delete (HTMLElement.prototype as unknown as { animate?: unknown }).animate;
});

describe('bubble re-stack (MOTION spell 22)', () => {
  it('does not animate the first pass', () => {
    const state = newRestackState();
    restack(column({ 1: 0, 2: 100 }), state, 'a', [1, 2], false);
    expect(animate).not.toHaveBeenCalled();
  });

  it('slides a bubble that moved on selection from its old top (translateY, base, ease-out)', () => {
    const state = newRestackState();
    restack(column({ 1: 0, 2: 100 }), state, 'a', [1, 2], false);
    restack(column({ 1: 0, 2: 160 }), state, 'a', [1, 2], false);
    expect(animate).toHaveBeenCalledTimes(1);
    const [frames, options] = animate.mock.calls[0] as [Keyframe[], KeyframeAnimationOptions];
    expect(frames).toEqual([{ transform: 'translateY(-60px)' }, { transform: 'translateY(0)' }]);
    expect(options.duration).toBe(160);
    expect(options.easing).toBe('cubic-bezier(0.2, 0, 0, 1)');
  });

  it('a resolve that pulls the next bubble up moves it up', () => {
    const state = newRestackState();
    restack(column({ 1: 0, 2: 160 }), state, 'a', [1, 2], false);
    restack(column({ 1: 0, 2: 60 }), state, 'a', [1, 2], false);
    const [frames] = animate.mock.calls[0] as [Keyframe[]];
    expect(frames[0]).toEqual({ transform: 'translateY(100px)' });
  });

  it('fades a new thread in from 0.98 and never animates zoom or scroll-in', () => {
    const state = newRestackState();
    restack(column({ 1: 0 }), state, 'a', [1], false);
    restack(column({ 1: 0, 2: 100 }), state, 'a', [1, 2], false);
    const [frames, options] = animate.mock.calls[0] as [Keyframe[], KeyframeAnimationOptions];
    expect(frames[0]).toEqual({ opacity: 0, transform: 'scale(0.98)' });
    expect(options.duration).toBe(180);
    animate.mockClear();
    // Zoom: another key, positions differ.
    restack(column({ 1: 0, 2: 300 }), state, 'b', [1, 2], false);
    expect(animate).not.toHaveBeenCalled();
    // Scrolled into the mounted window: a known thread without an earlier position.
    restack(column({ 2: 300 }), state, 'b', [1, 2], false);
    restack(column({ 1: 0, 2: 300 }), state, 'b', [1, 2], false);
    expect(animate).not.toHaveBeenCalled();
  });

  it('reduced motion: bubbles jump, a new one fades fast without scale', () => {
    const state = newRestackState();
    restack(column({ 1: 0 }), state, 'a', [1], true);
    restack(column({ 1: 50, 2: 100 }), state, 'a', [1, 2], true);
    expect(animate).toHaveBeenCalledTimes(1);
    const [frames, options] = animate.mock.calls[0] as [Keyframe[], KeyframeAnimationOptions];
    expect(frames).toEqual([{ opacity: 0 }, { opacity: 1 }]);
    expect(options.duration).toBe(120);
  });

  it('a move that interrupts another cancels the running one', () => {
    const state = newRestackState();
    const root = column({ 1: 0, 2: 100 });
    restack(root, state, 'a', [1, 2], false);
    const target = root.querySelector<HTMLElement>('[data-item="2"]') as HTMLElement;
    target.dataset.top = '160';
    restack(root, state, 'a', [1, 2], false);
    target.dataset.top = '40';
    restack(root, state, 'a', [1, 2], false);
    expect(cancelled).toBe(1);
    expect(animate).toHaveBeenCalledTimes(2);
  });
});
