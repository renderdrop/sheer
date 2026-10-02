import { describe, expect, it } from 'vitest';

import { ICON_BUTTON_VARIANTS, SELECTED_FORCED_COLORS } from './controlStyles';

describe('the on look of an icon button under forced colors', () => {
  const classesOf = (variant: keyof typeof ICON_BUTTON_VARIANTS) =>
    ICON_BUTTON_VARIANTS[variant].on.split(/\s+/).filter((name) => name !== '');

  it('the cue is a border in the highlight color, not a box-shadow, outline or fill', () => {
    const cue = SELECTED_FORCED_COLORS.split(' ');
    expect(cue).toEqual(['forced-colors:border-(length:--focus-width)', 'forced-colors:border-accent']);
  });

  it('a look that is drawn with the box-shadow ring also carries the cue, so it survives forced colors', () => {
    const ringed = Object.keys(ICON_BUTTON_VARIANTS).filter((name) =>
      classesOf(name as keyof typeof ICON_BUTTON_VARIANTS).includes('inset-ring-1'),
    );
    expect(ringed).toContain('toggle');
    for (const name of ringed) {
      const classes = classesOf(name as keyof typeof ICON_BUTTON_VARIANTS);
      for (const cue of SELECTED_FORCED_COLORS.split(' ')) expect(classes, `${name}: ${cue}`).toContain(cue);
    }
  });

  it('the cue is not an outline, which the focus ring owns', () => {
    expect(SELECTED_FORCED_COLORS).not.toMatch(/outline/);
  });

  it('the tool look is a fill in system colors, which forced colors keeps', () => {
    expect(classesOf('tool')).toEqual(expect.arrayContaining(['bg-accent', 'text-on-accent']));
  });
});
