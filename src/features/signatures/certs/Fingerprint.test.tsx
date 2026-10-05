// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';

import { setup } from '../../../test/render';
import { Fingerprint, fingerprintBlocks, fingerprintPlain } from './Fingerprint';

describe('fingerprint grouping', () => {
  it('groups pairs in blocks of four, uppercase', () => {
    expect(fingerprintBlocks('abcdef0123456789')).toEqual(['AB:CD:EF:01', '23:45:67:89']);
    expect(fingerprintPlain('abcdef01')).toBe('AB:CD:EF:01');
  });
  it('keeps a short last block when the pair count is not a multiple of four', () => {
    expect(fingerprintBlocks('abcdef0123')).toEqual(['AB:CD:EF:01', '23']);
  });
  it('keeps a trailing odd nibble as its own pair and handles empty input', () => {
    expect(fingerprintBlocks('abcde')).toEqual(['AB:CD:E']);
    expect(fingerprintBlocks('')).toEqual([]);
  });
  it('renders one nowrap span per block', () => {
    setup(<Fingerprint hex="abcdef0123" />);
    const spans = document.querySelectorAll('[data-fingerprint] .whitespace-nowrap');
    expect(Array.from(spans).map((s) => s.textContent)).toEqual(['AB:CD:EF:01', '23']);
  });
});
