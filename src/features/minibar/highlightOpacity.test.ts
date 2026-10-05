import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

import { HIGHLIGHT_OPACITY } from '../inspector/palette';

describe('highlight opacity', () => {
  it('the data constant is the value of the --hl-opacity token (one source)', () => {
    const css = readFileSync(resolve(__dirname, '../../styles/tokens.css'), 'utf8');
    const match = /--hl-opacity:\s*([0-9.]+)\s*;/.exec(css);
    expect(match).not.toBeNull();
    expect(HIGHLIGHT_OPACITY).toBe(Number(match?.[1]));
  });
});
