// @vitest-environment jsdom
import { render } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import { Skeleton, shimmerRuns, watchShimmer } from './Skeleton';

describe('Skeleton', () => {
  it('is hidden from assistive tech and takes the shape of its target', () => {
    const { container } = render(<Skeleton shape="circle" className="size-swatch" />);
    const el = container.firstElementChild as HTMLElement;
    expect(el.getAttribute('aria-hidden')).toBe('true');
    expect(el.hasAttribute('data-skeleton')).toBe(true);
    expect(el.className).toContain('rounded-pill');
    expect(el.className).toContain('size-swatch');
    expect(el.className).toContain('bg-subtle');
  });

  it('the shimmer runs only on screen in a visible window', () => {
    expect(shimmerRuns(true, true)).toBe(true);
    expect(shimmerRuns(false, true)).toBe(false);
    expect(shimmerRuns(true, false)).toBe(false);
  });

  it('watchShimmer pauses while the document is hidden and stops watching on cleanup', () => {
    const el = document.createElement('div');
    let hidden = false;
    Object.defineProperty(document, 'hidden', { configurable: true, get: () => hidden });
    const stop = watchShimmer(el);
    expect(el.hasAttribute('data-paused')).toBe(false);
    hidden = true;
    document.dispatchEvent(new Event('visibilitychange'));
    expect(el.hasAttribute('data-paused')).toBe(true);
    stop();
    hidden = false;
    document.dispatchEvent(new Event('visibilitychange'));
    expect(el.hasAttribute('data-paused')).toBe(true);
  });
});
