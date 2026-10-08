import { describe, expect, it } from 'vitest';

import { PALETTE_SETS } from '../../inspector/palette';
import { strokePartner } from './citation';

const [c1, c2, c3, solar, c5] = PALETTE_SETS.iris.highlight.map((c) => c.rgb);

describe('the stroke partner of a citation fill (DESIGN 3.7 C1)', () => {
  it('is the fill itself at full opacity for the colours of the set', () => {
    for (const fill of [c1, c2, c3, c5]) expect(strokePartner(fill ?? [0, 0, 0])).toEqual(fill);
  });

  it('is Ink for the Solar position and for a custom fill', () => {
    expect(strokePartner(solar ?? [0, 0, 0])).toEqual([15, 15, 15]);
    expect(strokePartner([1, 2, 3])).toEqual([15, 15, 15]);
  });
});
