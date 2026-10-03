// @vitest-environment jsdom
import { act, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { pulse, usePulseMessage } from './SuccessPulse';

beforeEach(() => vi.useFakeTimers());
afterEach(() => {
  vi.runOnlyPendingTimers();
  vi.useRealTimers();
});

function target(): HTMLElement {
  const element = document.createElement('button');
  document.body.append(element);
  return element;
}

describe('pulse', () => {
  it('marks the target once and removes the mark when the ring animation ends', () => {
    const element = target();
    pulse(element, 'Saved');
    expect(element.hasAttribute('data-pulse')).toBe(true);
    const own = new Event('animationend') as AnimationEvent;
    Object.defineProperty(own, 'pseudoElement', { value: '::after' });
    element.dispatchEvent(own);
    expect(element.hasAttribute('data-pulse')).toBe(false);
  });

  it('ignores animations that are not the ring', () => {
    const element = target();
    pulse(element, 'Saved');
    const child = document.createElement('span');
    element.append(child);
    const other = new Event('animationend', { bubbles: true }) as AnimationEvent;
    Object.defineProperty(other, 'pseudoElement', { value: '' });
    child.dispatchEvent(other);
    expect(element.hasAttribute('data-pulse')).toBe(true);
  });

  it('a second call on the same target restarts the pulse', () => {
    const element = target();
    const changes: string[] = [];
    const remove = vi.spyOn(element, 'removeAttribute').mockImplementation((name) => {
      changes.push(`remove:${name}`);
      Element.prototype.removeAttribute.call(element, name);
    });
    pulse(element, 'a');
    pulse(element, 'b');
    expect(changes).toEqual(['remove:data-pulse', 'remove:data-pulse']);
    expect(element.hasAttribute('data-pulse')).toBe(true);
    remove.mockRestore();
  });

  it('announces the message to the live region and clears it again; focus does not move', () => {
    const element = target();
    const before = document.activeElement;
    const { result } = renderHook(() => usePulseMessage());
    expect(result.current).toBe('');
    act(() => pulse(element, 'Saved'));
    expect(result.current).toBe('Saved');
    act(() => vi.advanceTimersByTime(1300));
    expect(result.current).toBe('');
    expect(document.activeElement).toBe(before);
  });

  it('announces the same text again within the window, and drops the ring when animationend never comes', () => {
    const element = target();
    const { result } = renderHook(() => usePulseMessage());
    act(() => pulse(element, 'Saved'));
    const first = result.current;
    act(() => pulse(element, 'Saved'));
    expect(result.current).not.toBe(first);
    expect(result.current.startsWith('Saved')).toBe(true);
    act(() => vi.advanceTimersByTime(1300));
    expect(element.hasAttribute('data-pulse')).toBe(false);
  });
});
