import { describe, expect, it } from 'vitest';

import { strokePartner } from './citation';

describe('the stroke partner of a citation fill (DESIGN 3.7 C1)', () => {
  it('is the matching stroke colour for Mint, Sky, Rose and Lavender', () => {
    expect(strokePartner([125, 235, 181])).toEqual([31, 158, 106]);
    expect(strokePartner([163, 222, 255])).toEqual([61, 143, 209]);
    expect(strokePartner([255, 199, 215])).toEqual([225, 92, 134]);
    expect(strokePartner([220, 207, 255])).toEqual([146, 120, 230]);
  });

  it('is Ink for Solar and for a custom fill', () => {
    expect(strokePartner([255, 248, 77])).toEqual([15, 15, 15]);
    expect(strokePartner([1, 2, 3])).toEqual([15, 15, 15]);
  });
});
