// @vitest-environment jsdom
import { fireEvent, render } from '@testing-library/react';
import { Check, RotateCw, Trash2 } from 'lucide-react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { Icon } from './Icon';
import { FAMILY_FACTOR, MOTION_ICON_MS } from './iconMotion';

type Anim = { cancel: () => void };
let animate: ReturnType<typeof vi.fn>;
let running: Anim[];
let reduced = false;
let now = 0;

beforeEach(() => {
  running = [];
  reduced = false;
  now = 1000;
  vi.spyOn(performance, 'now').mockImplementation(() => now);
  animate = vi.fn(() => {
    const anim: Anim = { cancel: vi.fn() };
    running.push(anim);
    return anim;
  });
  // jsdom has neither getTotalLength nor animate.
  Object.defineProperty(SVGElement.prototype, 'getTotalLength', { configurable: true, value: () => 20 });
  Object.defineProperty(SVGElement.prototype, 'animate', { configurable: true, value: animate });
  window.matchMedia = ((query: string) => ({
    matches: reduced && query.includes('prefers-reduced-motion'),
    media: query,
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
  })) as unknown as typeof window.matchMedia;
});

afterEach(() => {
  vi.restoreAllMocks();
  Reflect.deleteProperty(SVGElement.prototype, 'getTotalLength');
  Reflect.deleteProperty(SVGElement.prototype, 'animate');
});

type Call = [Keyframe[], KeyframeAnimationOptions];
const calls = () => animate.mock.calls as Call[];

describe('Icon geometry', () => {
  it('sets the stroke in user units per size and no non-scaling stroke', () => {
    const { container } = render(
      <>
        <Icon icon={Check} />
        <Icon icon={Check} size={20} />
      </>,
    );
    const [small, tool] = Array.from(container.querySelectorAll('svg'));
    expect(small?.getAttribute('class')).toContain('[stroke-width:var(--icon-stroke-16)]');
    expect(tool?.getAttribute('class')).toContain('[stroke-width:var(--icon-stroke-20)]');
    expect(container.querySelector('[vector-effect]')).toBeNull();
  });
});

describe('Icon hover motion', () => {
  it('plays the catalogue motion of the icon once when the host is entered', () => {
    const { getByRole } = render(
      <button type="button">
        <Icon icon={Trash2} />
      </button>,
    );
    fireEvent.pointerEnter(getByRole('button'));
    // The lid: the two lid elements move, nothing else.
    expect(animate).toHaveBeenCalledTimes(2);
    const [frames, options] = calls()[0] as Call;
    expect(String(frames[1]?.transform)).toContain('translate(0px, -2.5px)');
    expect(options.duration).toBeCloseTo(MOTION_ICON_MS * FAMILY_FACTOR.lid);
    expect(options.fill).not.toBe('forwards');
    expect(options.fill).not.toBe('both');
  });

  it('does not restart while running, and plays again on an entry after the end', () => {
    const { getByRole } = render(
      <button type="button">
        <Icon icon={RotateCw} />
      </button>,
    );
    const button = getByRole('button');
    fireEvent.pointerEnter(button);
    const first = animate.mock.calls.length;
    now += 300;
    fireEvent.pointerLeave(button);
    fireEvent.pointerEnter(button);
    expect(animate.mock.calls.length).toBe(first);
    for (const anim of running) expect(anim.cancel).not.toHaveBeenCalled();
    now += MOTION_ICON_MS * FAMILY_FACTOR.spin;
    fireEvent.pointerEnter(button);
    expect(animate.mock.calls.length).toBe(first * 2);
  });

  it('cancels what runs on unmount', () => {
    const { getByRole, unmount } = render(
      <button type="button">
        <Icon icon={RotateCw} />
      </button>,
    );
    fireEvent.pointerEnter(getByRole('button'));
    unmount();
    for (const anim of running) expect(anim.cancel).toHaveBeenCalled();
  });

  it('does nothing on leave', () => {
    const { getByRole } = render(
      <button type="button">
        <Icon icon={Check} />
      </button>,
    );
    fireEvent.pointerLeave(getByRole('button'));
    expect(animate).not.toHaveBeenCalled();
  });

  it('does nothing for a disabled host', () => {
    const { getByRole } = render(
      <>
        <button type="button" disabled>
          <Icon icon={Check} />
        </button>
        <div role="menuitem" aria-disabled="true">
          <Icon icon={Check} />
        </div>
      </>,
    );
    fireEvent.pointerEnter(getByRole('button'));
    fireEvent.pointerEnter(getByRole('menuitem'));
    expect(animate).not.toHaveBeenCalled();
  });

  it('only changes the colour under reduced motion', () => {
    reduced = true;
    const { getByRole } = render(
      <button type="button">
        <Icon icon={Check} />
      </button>,
    );
    fireEvent.pointerEnter(getByRole('button'));
    expect(animate).not.toHaveBeenCalled();
  });

  it('listens to a role host and ignores an icon without a host', () => {
    const add = vi.spyOn(HTMLElement.prototype, 'addEventListener');
    const { getByRole, unmount } = render(
      <div role="tab" aria-selected="false">
        <Icon icon={Check} />
      </div>,
    );
    expect(add.mock.calls.filter(([type]) => type === 'pointerenter')).toHaveLength(1);
    fireEvent.pointerEnter(getByRole('tab'));
    expect(animate).toHaveBeenCalled();
    unmount();
    add.mockClear();
    animate.mockClear();
    const bare = render(
      <div data-testid="bare">
        <Icon icon={Check} />
      </div>,
    );
    expect(add.mock.calls.filter(([type]) => type === 'pointerenter')).toHaveLength(0);
    fireEvent.pointerEnter(bare.getByTestId('bare'));
    expect(animate).not.toHaveBeenCalled();
  });

  it('marks an icon with its own colour class', () => {
    const { container } = render(
      <button type="button">
        <Icon icon={Check} className="text-error-icon" />
        <Icon icon={Check} className="text-sm" />
      </button>,
    );
    const [own, plain] = Array.from(container.querySelectorAll('svg'));
    expect(own?.hasAttribute('data-icon-colour')).toBe(true);
    expect(plain?.hasAttribute('data-icon-colour')).toBe(false);
  });
});
