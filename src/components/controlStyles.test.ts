import { describe, expect, it } from 'vitest';

import { ICON_BUTTON_VARIANTS, SELECTED_FORCED_COLORS } from './controlStyles';

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
