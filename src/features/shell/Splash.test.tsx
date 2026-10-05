// @vitest-environment jsdom
import { readFileSync } from 'node:fs';
import { act, render, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { useSettings } from '../../stores/settings';
import { Splash, SPLASH_FADE_MS, SPLASH_MAX_MS, useSplash } from './Splash';

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

describe('the splash (MOTION spell 10)', () => {
  it('mirrors --splash-max and --motion-slow of tokens.css', () => {
    const css = readFileSync('src/styles/tokens.css', 'utf8');
    expect(css).toContain(`--splash-max: ${SPLASH_MAX_MS}ms;`);
    expect(css).toContain(`--motion-slow: ${SPLASH_FADE_MS}ms;`);
  });

  it('is never shown when the app is ready at the first render', () => {
    const { result } = renderHook(() => useSplash(true));
    expect(result.current).toBe('gone');
  });

  it('is dismissed as soon as the load is ready (never held longer than the load)', () => {
    const { result, rerender } = renderHook(({ ready }) => useSplash(ready), { initialProps: { ready: false } });
    expect(result.current).toBe('shown');
    act(() => void vi.advanceTimersByTime(300));
    expect(result.current).toBe('shown');
    rerender({ ready: true });
    expect(result.current).toBe('leaving');
    act(() => void vi.advanceTimersByTime(SPLASH_FADE_MS));
    expect(result.current).toBe('gone');
  });

  it('leaves after at most --splash-max even when the load is still running', () => {
    const { result } = renderHook(() => useSplash(false));
    act(() => void vi.advanceTimersByTime(SPLASH_MAX_MS - 1));
    expect(result.current).toBe('shown');
    act(() => void vi.advanceTimersByTime(1));
    expect(result.current).toBe('leaving');
    act(() => void vi.advanceTimersByTime(SPLASH_FADE_MS));
    expect(result.current).toBe('gone');
  });

  it('renders the word mark and the breathing glow, hidden from assistive technology, and unmounts', () => {
    useSettings.setState({ loaded: false });
    const { container } = render(<Splash />);
    const splash = container.querySelector('[data-splash]') as HTMLElement;
    expect(splash.getAttribute('aria-hidden')).toBe('true');
    expect(container.querySelector('[data-splash-glow]')).not.toBeNull();
    expect(container.querySelector('svg')).not.toBeNull();
    act(() => useSettings.setState({ loaded: true }));
    expect(splash.hasAttribute('data-leaving')).toBe(true);
    act(() => void vi.advanceTimersByTime(SPLASH_FADE_MS));
    expect(container.querySelector('[data-splash]')).toBeNull();
  });
});
