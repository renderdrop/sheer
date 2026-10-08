// @vitest-environment jsdom
import { Pencil } from 'lucide-react';
import { describe, expect, it } from 'vitest';

import { setup } from '../../test/render';
import type { SlotDef } from './model';
import { ToolItem } from './ToolItem';

const slot = (on: boolean): SlotDef => ({
  id: 'draw',
  label: 'Draw',
  icon: Pencil,
  kind: 'tool',
  on,
  variants: [{ id: 'a', label: 'A', run: () => undefined }],
  run: () => undefined,
});

/** The classes that decide the look in a state: hover and active are variants of the same classes (Tailwind), so they are read off the class lists. */
function parts(on: boolean) {
  const { container } = setup(<ToolItem slot={slot(on)} iconOnly={false} stop="draw" />);
  const outer = container.querySelector<HTMLElement>('[data-split]');
  const buttons = [...(outer?.querySelectorAll<HTMLElement>('button') ?? [])];
  return { outer, main: buttons[0], chevron: buttons[1] };
}

const BORDERISH = /(^|\s)(?:[\w-]+:)*(?:border(?!-s\b|-border-subtle\b)|outline|ring|shadow)(?:-|\s|$)/;

describe('split item contour (F19.27)', () => {
  it.each([false, true])('has one outer contour and two plain halves when on=%s', (on) => {
    const { outer, main, chevron } = parts(on);
    expect(outer?.getAttribute('data-on')).toBe(String(on));
    expect(outer?.className).toContain('overflow-hidden');
    expect(outer?.className).toContain('rounded-(--tool-item-radius)');
    // The active edge is drawn once, on the wrapper, above both halves (its ::after), and only while the tool is on.
    expect(outer?.className).toContain('data-[on=true]:after:shadow-(--tool-active-edge)');
    expect(outer?.className).toContain('data-[on=true]:bg-accent');
    // Neither half has a border (the chevron's divider excepted), outline, ring or shadow of its own, in any state variant.
    expect(main?.className).not.toMatch(BORDERISH);
    expect(chevron?.className.replace('border-s border-border-subtle', '')).not.toMatch(BORDERISH);
  });

  it('keeps the divider a hairline on the chevron in every state and gives hover only a background', () => {
    const { chevron, main } = parts(true);
    expect(chevron?.className).toContain('border-s border-border-subtle');
    expect(chevron?.className).not.toMatch(/hover:(border|shadow|outline|ring)/);
    expect(main?.className).not.toMatch(/hover:(border|shadow|outline|ring)/);
    expect(chevron?.className).toContain('not-aria-disabled:hover:bg-panel');
    expect(chevron?.className).toContain('group-data-[on=true]:not-aria-disabled:hover:bg-accent-hover');
    expect(main?.className).toContain('not-aria-disabled:hover:bg-panel');
    expect(main?.className).toContain('not-aria-disabled:data-[on=true]:hover:bg-accent-hover');
  });
});
