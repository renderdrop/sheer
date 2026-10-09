// @vitest-environment jsdom
import { fireEvent, render } from '@testing-library/react';
import { Check } from 'lucide-react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { Icon } from './Icon';

type Anim = { cancel: () => void };
let animate: ReturnType<typeof vi.fn>;
let running: Anim[];
let reduced = false;

beforeEach(() => {
  running = [];
  reduced = false;
  animate = vi.fn(() => {
    const anim: Anim = { cancel: vi.fn() };
    running.push(anim);
    return anim;
  });
  // jsdom has neither getTotalLength nor animate.
  Object.defineProperty(SVGElement.prototype, 'getTotalLength', { configurable: true, value: () => 10 });
  Object.defineProperty(SVGElement.prototype, 'animate', { configurable: true, value: animate });
  Object.defineProperty(SVGElement.prototype, 'getAnimations', { configurable: true, value: () => running });
  window.matchMedia = ((query: string) => ({
    matches: reduced && query.includes('prefers-reduced-motion'),
    media: query,
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
  })) as unknown as typeof window.matchMedia;
});

afterEach(() => {
  Reflect.deleteProperty(SVGElement.prototype, 'getTotalLength');
  Reflect.deleteProperty(SVGElement.prototype, 'animate');
  Reflect.deleteProperty(SVGElement.prototype, 'getAnimations');
});

const shapes = () => document.querySelectorAll('svg path, svg line, svg circle, svg rect, svg polyline').length;

describe('Icon hover draw', () => {
  it('draws every shape once when the host is entered', () => {
    const { getByRole } = render(
      <button type="button">
        <Icon icon={Check} />
      </button>,
    );
    fireEvent.pointerEnter(getByRole('button'));
    expect(animate).toHaveBeenCalledTimes(shapes());
    const [frames, options] = animate.mock.calls[0] as [Record<string, string>[], { easing: string }];
    expect(frames[0]?.strokeDashoffset).toBe(frames[0]?.strokeDasharray);
    expect(frames[1]?.strokeDashoffset).toBe('0px');
    expect(options.easing).toContain('cubic-bezier');
  });

  it('cancels a running draw on re-entry', () => {
    const { getByRole } = render(
      <button type="button">
        <Icon icon={Check} />
      </button>,
    );
    fireEvent.pointerEnter(getByRole('button'));
    const first = [...running];
    fireEvent.pointerEnter(getByRole('button'));
    for (const anim of first) expect(anim.cancel).toHaveBeenCalled();
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
    add.mockRestore();
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
