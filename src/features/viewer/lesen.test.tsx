// @vitest-environment jsdom
import { act, render, renderHook } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';

import { useUi } from '../../stores/ui';
import { LENS_SIZE, LENS_ZOOM, Magnifier, lensOffset } from './Magnifier';
import { effectiveTool, textPointer, useLesen, useLesenKeys } from './lesen';
import { usePan } from './usePan';

afterEach(() => {
  useUi.setState({ activeTool: 'select' });
  useLesen.setState({ spaceHand: false, zHeld: false });
});

const key = (type: 'keydown' | 'keyup', k: string, target: EventTarget = window) =>
  act(() => {
    target.dispatchEvent(new KeyboardEvent(type, { key: k, bubbles: true, cancelable: true }));
  });

describe('tool gating', () => {
  it('selects text with Select and Text select, never with the hand', () => {
    expect(textPointer('select')).toBe(true);
    expect(textPointer('textSelect')).toBe(true);
    expect(textPointer('hand')).toBe(false);
    expect(textPointer('highlight')).toBe(false);
    expect(effectiveTool('highlight', true)).toBe('hand');
    expect(effectiveTool('highlight', false)).toBe('highlight');
  });
});

describe('Space and Z', () => {
  it('holds the hand and the lens while the keys are down, not in text fields', () => {
    renderHook(() => useLesenKeys());
    key('keydown', ' ');
    expect(useLesen.getState().spaceHand).toBe(true);
    key('keyup', ' ');
    expect(useLesen.getState().spaceHand).toBe(false);
    key('keydown', 'z');
    expect(useLesen.getState().zHeld).toBe(true);
    key('keyup', 'z');
    expect(useLesen.getState().zHeld).toBe(false);
    const input = document.createElement('input');
    document.body.append(input);
    key('keydown', ' ', input);
    key('keydown', 'z', input);
    expect(useLesen.getState()).toMatchObject({ spaceHand: false, zHeld: false });
  });
});

describe('the hand', () => {
  it('pans the region by dragging and ignores the gesture below it', () => {
    const region = document.createElement('div');
    const child = document.createElement('div');
    region.append(child);
    document.body.append(region);
    region.scrollLeft = 50;
    region.scrollTop = 50;
    renderHook(() => usePan({ current: region }));
    useUi.setState({ activeTool: 'hand' });
    expect(region.style.cursor).toBe('grab');
    let reached = false;
    child.addEventListener('pointerdown', () => (reached = true));
    const fire = (type: string, x: number, y: number, target: Element) =>
      act(() => {
        target.dispatchEvent(
          new MouseEvent(type, { clientX: x, clientY: y, button: 0, bubbles: true, cancelable: true }) as never,
        );
      });
    const pointer = (type: string, x: number, y: number, target: Element) => {
      const event = new Event(type, { bubbles: true, cancelable: true });
      Object.assign(event, { clientX: x, clientY: y, button: 0, pointerId: 1, isPrimary: true });
      act(() => {
        target.dispatchEvent(event);
      });
    };
    void fire;
    // jsdom has no layout: the region reports a zero size, so the scroll-bar test treats the whole of it as bar. Give it a size.
    Object.defineProperty(region, 'clientWidth', { value: 100 });
    Object.defineProperty(region, 'clientHeight', { value: 100 });
    pointer('pointerdown', 10, 10, child);
    expect(reached).toBe(false);
    expect(region.style.cursor).toBe('grabbing');
    pointer('pointermove', 4, 7, region);
    expect(region.scrollLeft).toBe(56);
    expect(region.scrollTop).toBe(53);
    pointer('pointerup', 4, 7, region);
    expect(region.style.cursor).toBe('grab');
    useUi.setState({ activeTool: 'select' });
    expect(region.style.cursor).toBe('');
  });
});

describe('the lens', () => {
  it('puts the page point under the pointer at the lens centre', () => {
    expect(lensOffset(10, 20)).toEqual({ x: LENS_SIZE / 2 - 10 * LENS_ZOOM, y: LENS_SIZE / 2 - 20 * LENS_ZOOM });
    expect(LENS_SIZE).toBe(160);
    expect(LENS_ZOOM).toBe(2);
  });

  const region = () => {
    const element = document.createElement('div');
    const page = document.createElement('div');
    page.dataset.page = '1';
    element.append(page);
    document.body.append(element);
    Object.defineProperty(element, 'clientWidth', { value: 400 });
    Object.defineProperty(element, 'clientHeight', { value: 400 });
    element.getBoundingClientRect = () => ({ left: 0, top: 0, width: 400, height: 400 }) as DOMRect;
    page.getBoundingClientRect = () => ({ left: 0, top: 0, width: 200, height: 200 }) as DOMRect;
    return { element, page };
  };
  const move = (target: Element, x: number, y: number) =>
    act(() => {
      const event = new Event('pointermove', { bubbles: true }) as Event & { clientX: number; clientY: number };
      event.clientX = x;
      event.clientY = y;
      target.dispatchEvent(event);
    });

  it('fades in over a page, out when the pointer leaves, and is gone with the tool', () => {
    const { element, page } = region();
    useUi.setState({ activeTool: 'magnifier' });
    const { unmount } = render(<Magnifier region={{ current: element }} />);
    const lens = document.body.querySelector<HTMLElement>('[data-magnifier]') as HTMLElement;
    move(page, 50, 50);
    expect(lens.hasAttribute('data-shown')).toBe(true);
    act(() => {
      element.dispatchEvent(new Event('pointerleave'));
    });
    expect(lens.hasAttribute('data-shown')).toBe(false);
    move(page, 60, 60);
    expect(lens.hasAttribute('data-shown')).toBe(true);
    act(() => useUi.setState({ activeTool: 'select' }));
    expect(lens.hasAttribute('data-shown')).toBe(false);
    unmount();
    element.remove();
  });

  it('opens at the last pointer place when Z is pressed without a move', () => {
    const { element, page } = region();
    render(<Magnifier region={{ current: element }} />);
    const lens = document.body.querySelector<HTMLElement>('[data-magnifier]') as HTMLElement;
    move(page, 50, 50);
    expect(lens.hasAttribute('data-shown')).toBe(false);
    const original = document.elementFromPoint;
    document.elementFromPoint = () => page;
    act(() => useLesen.setState({ zHeld: true }));
    document.elementFromPoint = original;
    expect(lens.hasAttribute('data-shown')).toBe(true);
    element.remove();
  });

  it('is aria-hidden, takes no pointer and starts hidden', () => {
    render(<Magnifier region={{ current: null }} />);
    const lens = document.body.querySelector<HTMLElement>('[data-magnifier]');
    expect(lens?.getAttribute('aria-hidden')).toBe('true');
    expect(lens?.hasAttribute('data-shown')).toBe(false);
    expect(lens?.getAttribute('style')).toBeNull();
    expect(lens?.className).toContain('pointer-events-none');
  });
});
