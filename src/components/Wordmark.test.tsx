// @vitest-environment jsdom
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import { WORDMARK_PATH, WORDMARK_VIEW_BOX, Wordmark } from './Wordmark';

const file = readFileSync(join(process.cwd(), 'assets', 'brand', 'wordmark-secondary.svg'), 'utf8');

describe('Wordmark', () => {
  it('is an image named "sheer." in currentColor', () => {
    render(<Wordmark />);
    const mark = screen.getByRole('img', { name: 'sheer.' });
    expect(mark.getAttribute('fill')).toBe('currentColor');
    expect(mark.querySelector('path')?.getAttribute('d')).toBe(WORDMARK_PATH);
  });

  it('carries the outlines of assets/brand/wordmark-secondary.svg, cropped to its ink', () => {
    expect(file).toContain(` d="${WORDMARK_PATH}"`);
    const box = /viewBox="0 0 ([\d.]+) ([\d.]+)"/.exec(file);
    const [x = 0, y = 0, w = 0, h = 0] = WORDMARK_VIEW_BOX.split(' ').map(Number);
    expect(x).toBe(y);
    expect(w).toBeCloseTo(Number(box?.[1]) - 2 * x, 2);
    expect(h).toBeCloseTo(Number(box?.[2]) - 2 * y, 2);
  });
});
