// @vitest-environment jsdom
import { act, render } from '@testing-library/react';
import { readFileSync } from 'node:fs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { FocusRing } from './FocusRing';

/** jsdom has no layout and no Web Animations: boxes come from `data-box="left,top,width,height"`, `animate` is recorded. */
interface Recorded {
  keyframes: Keyframe[];
  cancel: ReturnType<typeof vi.fn>;
}
let recorded: Recorded[] = [];
let live: Recorded[] = [];
let reduced = false;
let keyboard = true;

const ring = () => document.querySelector<HTMLElement>('[data-focus-ring]');
const frame = () => act(() => new Promise<void>((resolve) => requestAnimationFrame(() => resolve())));

beforeEach(() => {
  recorded = [];
  live = [];
  reduced = false;
  keyboard = true;
  window.matchMedia = ((query: string) => ({
    matches: reduced && query.includes('prefers-reduced-motion'),
    media: query,
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
    addListener: () => undefined,
    removeListener: () => undefined,
  })) as unknown as typeof window.matchMedia;
  vi.spyOn(Element.prototype, 'getBoundingClientRect').mockImplementation(function (this: Element) {
    const el = this as HTMLElement;
    const [left = 0, top = 0, width = 0, height = 0] = (el.dataset.box ?? '').split(',').map(Number);
    if (el.dataset.focusRing !== undefined) {
      const [x = 0, y = 0] = (el.style.translate || '0px 0px').split(' ').map(Number.parseFloat);
      return {
        left: x,
        top: y,
        width: Number.parseFloat(el.style.width || '0'),
        height: Number.parseFloat(el.style.height || '0'),
      } as DOMRect;
    }
    return { left, top, width, height, right: left + width, bottom: top + height } as DOMRect;
  });
  const matches = Element.prototype.matches;
  vi.spyOn(Element.prototype, 'matches').mockImplementation(function (this: Element, selector: string) {
    if (selector === ':focus-visible') return keyboard && this === document.activeElement;
    return matches.call(this, selector);
  });
  HTMLElement.prototype.getAnimations = () => live as unknown as Animation[];
  HTMLElement.prototype.animate = function (keyframes: Keyframe[] | PropertyIndexedKeyframes) {
    const entry: Recorded = {
      keyframes: keyframes as Keyframe[],
      cancel: vi.fn(() => {
        live = live.filter((other) => other !== entry);
      }),
    };
    recorded.push(entry);
    live.push(entry);
    return entry as unknown as Animation;
  } as HTMLElement['animate'];
});

afterEach(() => vi.restoreAllMocks());

function Page() {
  return (
    <>
      <FocusRing />
      <div role="toolbar" aria-label="A">
        <button type="button" data-box="0,0,40,30" style={{ borderRadius: '6px' }}>
          a
        </button>
        <button type="button" data-box="50,0,60,30">
          b
        </button>
        <button type="button" data-box="120,0,40,30">
          c
        </button>
        <button type="button" data-box="0,0,0,0">
          zero
        </button>
      </div>
      <button type="button" data-box="0,900,40,30">
        far
      </button>
      <div role="toolbar" aria-label="B">
        <button type="button" data-box="200,0,40,30">
          other
        </button>
      </div>
    </>
  );
}

const focus = async (name: string) => {
  const button = [...document.querySelectorAll('button')].find((el) => el.textContent === name);
  if (button === undefined) throw new Error(name);
  act(() => button.focus());
  await frame();
};

describe('FocusRing (MOTION spell 18)', () => {
  it('shows no ring before keyboard focus and no ring for pointer focus', async () => {
    render(<Page />);
    expect(ring()?.style.opacity).toBe('0');
    keyboard = false;
    await focus('a');
    expect(ring()?.style.opacity).toBe('0');
    expect(recorded).toHaveLength(0);
  });

  it('appears at a keyboard-focused target, then glides to the next one by transform at the new size', async () => {
    render(<Page />);
    await focus('a');
    expect(ring()?.style.opacity).toBe('1');
    expect(recorded).toHaveLength(0);
    await focus('b');
    expect(ring()?.style.width).toBe('60px');
    expect(ring()?.style.translate).toBe('50px 0px');
    expect(recorded).toHaveLength(1);
    expect(Object.keys(recorded[0]?.keyframes[0] ?? {})).toEqual(['transform']);
  });

  it('retargets in mid-glide: the running glide is cancelled', async () => {
    render(<Page />);
    await focus('a');
    await focus('b');
    const first = recorded[0];
    await focus('c');
    expect(first?.cancel).toHaveBeenCalled();
    expect(recorded).toHaveLength(2);
    expect(ring()?.style.translate).toBe('120px 0px');
  });

  it('fades instead of gliding for jumps over 400 px and across containers', async () => {
    render(<Page />);
    await focus('a');
    await focus('far');
    expect(recorded.at(-1)?.keyframes).toEqual([{ opacity: 0 }, { opacity: 1 }]);
    await focus('a');
    recorded = [];
    await focus('other');
    expect(recorded.at(-1)?.keyframes).toEqual([{ opacity: 0 }, { opacity: 1 }]);
  });

  it('reduced motion: the ring is at the target at once, nothing animates', async () => {
    reduced = true;
    render(<Page />);
    await focus('a');
    await focus('b');
    expect(ring()?.style.translate).toBe('50px 0px');
    expect(recorded).toHaveLength(0);
  });

  it('hides on blur and on pointer down, and switches the native ring off while mounted', async () => {
    const { unmount } = render(<Page />);
    expect(document.documentElement.hasAttribute('data-focus-glide')).toBe(true);
    await focus('a');
    act(() => document.dispatchEvent(new Event('pointerdown', { bubbles: true })));
    expect(ring()?.style.opacity).toBe('0');
    unmount();
    expect(document.documentElement.hasAttribute('data-focus-glide')).toBe(false);
  });

  it('marks only the drawn target as owned; a zero-rect target keeps the native ring', async () => {
    render(<Page />);
    await focus('a');
    expect(document.querySelectorAll('[data-focus-owned]')).toHaveLength(1);
    await focus('b');
    expect(document.querySelectorAll('[data-focus-owned]')).toHaveLength(1);
    expect(document.querySelector('[data-focus-owned]')?.textContent).toBe('b');
    await focus('zero');
    expect(ring()?.style.opacity).toBe('0');
    expect(document.querySelector('[data-focus-owned]')).toBeNull();
  });

  it('turns the native ring off for owned elements only (tokens.css R5-A), leaving the forced-colors outline', () => {
    const css = readFileSync('src/styles/tokens.css', 'utf8');
    const block = css.slice(css.indexOf('R5-A: the focus ring overlay'));
    expect(block).toContain(':focus-visible[data-focus-owned]');
    expect(block.slice(0, 700)).not.toContain(':root[data-focus-glide]');
  });

  it('a pointer press hides the ring; the next navigation key brings it back on the focused element', async () => {
    render(<Page />);
    await focus('a');
    act(() => document.dispatchEvent(new Event('pointerdown', { bubbles: true })));
    expect(ring()?.style.opacity).toBe('0');
    act(() => {
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }));
    });
    await frame();
    expect(ring()?.style.opacity).toBe('1');
  });

  it('forced colors: the shadow ring is dropped and a transparent outline (system Highlight there) carries it', () => {
    const css = readFileSync('src/styles/tokens.css', 'utf8');
    const forced = css.slice(css.indexOf('@media (forced-colors: active)'));
    expect(forced.slice(0, 1500)).toContain('--ring-focus: 0 0 transparent');
    render(<Page />);
    expect(ring()?.className).toContain('outline-transparent');
  });
});
