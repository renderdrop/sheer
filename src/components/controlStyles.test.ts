import { describe, expect, it } from 'vitest';

import {
  BUTTON_VARIANTS,
  CONTROL_BASE,
  ICON_BUTTON_SIZES,
  ICON_BUTTON_VARIANTS,
  SELECTED_FORCED_COLORS,
} from './controlStyles';

describe('the on look of an icon button under forced colors', () => {
  const classesOf = (variant: keyof typeof ICON_BUTTON_VARIANTS) =>
    ICON_BUTTON_VARIANTS[variant].on.split(/\s+/).filter((name) => name !== '');

  it('the cue is a border in the highlight color, not a box-shadow, outline or fill', () => {
    const cue = SELECTED_FORCED_COLORS.split(' ');
    expect(cue).toEqual(['forced-colors:border-(length:--focus-width)', 'forced-colors:border-accent']);
  });

  it('the toggle on look carries the cue (Sand fill is dropped by forced colors), so it survives them', () => {
    const classes = classesOf('toggle');
    for (const cue of SELECTED_FORCED_COLORS.split(' ')) expect(classes, cue).toContain(cue);
  });

  it('the cue is not an outline, which the focus ring owns', () => {
    expect(SELECTED_FORCED_COLORS).not.toMatch(/outline/);
  });

  it('the tool look is a fill in system colors, which forced colors keeps', () => {
    expect(classesOf('tool')).toEqual(expect.arrayContaining(['bg-accent', 'text-on-accent']));
  });
});

describe('the DESIGN 4 state matrix', () => {
  const has = (classes: string, name: string) => classes.split(/\s+/).includes(name);

  it('every button variant dims when disabled and keeps its fill', () => {
    for (const [name, classes] of Object.entries(BUTTON_VARIANTS)) {
      expect(has(classes, 'disabled:opacity-(--opacity-disabled)'), name).toBe(true);
      expect(has(classes, 'aria-disabled:opacity-(--opacity-disabled)'), name).toBe(true);
    }
  });

  it('hover and press only apply to enabled controls', () => {
    for (const classes of [BUTTON_VARIANTS.primary, BUTTON_VARIANTS.secondary, BUTTON_VARIANTS.ghost]) {
      for (const name of classes.split(/\s+/).filter((c) => /(^|:)(hover|active):/.test(c))) {
        expect(name, name).toMatch(/^not-aria-disabled:enabled:/);
      }
    }
  });

  it('primary: Solar, Solar-bright on hover; secondary and ghost: Sand on hover, pressed on press', () => {
    expect(BUTTON_VARIANTS.primary).toContain('bg-accent');
    expect(BUTTON_VARIANTS.primary).toContain('hover:bg-accent-hover');
    expect(BUTTON_VARIANTS.secondary).toContain('bg-subtle');
    expect(BUTTON_VARIANTS.secondary).toContain('active:bg-pressed');
    expect(BUTTON_VARIANTS.ghost).toContain('hover:bg-subtle');
    expect(BUTTON_VARIANTS.ghost).toContain('active:bg-pressed');
  });

  it('the press scales through the token and the base keeps the cursor and focusable-disabled rules', () => {
    expect(CONTROL_BASE).toContain('active:scale-(--scale-press)');
    expect(CONTROL_BASE).toContain('disabled:cursor-not-allowed');
    expect(CONTROL_BASE).toContain('aria-disabled:cursor-not-allowed');
  });

  it('icon buttons: rest is transparent with Sand hover and pressed press; sm is the 28 px square', () => {
    for (const variant of ['plain', 'toggle', 'tool'] as const) {
      const off = ICON_BUTTON_VARIANTS[variant].off;
      expect(off).toContain('bg-transparent');
      expect(off).toContain('hover:bg-subtle');
      expect(off).toContain('active:bg-pressed');
      expect(off).toContain('disabled:opacity-(--opacity-disabled)');
    }
    expect(ICON_BUTTON_SIZES.sm.square).toContain('size-control-sm');
    expect(ICON_BUTTON_SIZES.md.square).toContain('size-control-md');
  });
});
