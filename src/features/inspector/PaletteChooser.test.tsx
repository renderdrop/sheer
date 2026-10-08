// @vitest-environment jsdom
import { screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';

import { setup } from '../../test/render';
import { PaletteChooser } from './PaletteChooser';
import { PALETTE_SET_KEY, usePaletteSet } from './palette';

afterEach(() => {
  localStorage.clear();
  usePaletteSet.setState({ set: 'iris' });
});

describe('PaletteChooser (F19.19)', () => {
  it('lists four palettes by number, marks the current one and switches on click', async () => {
    const { user } = setup(<PaletteChooser />);
    await user.click(screen.getByRole('button', { name: 'Choose a palette' }));
    const rows = screen.getAllByRole('radio');
    expect(rows.map((r) => r.getAttribute('aria-label'))).toEqual(['Palette 1', 'Palette 2', 'Palette 3', 'Palette 4']);
    expect(rows[0]?.getAttribute('aria-checked')).toBe('true');
    expect(rows[0]?.textContent).toBe('');
    await user.click(screen.getByRole('radio', { name: 'Palette 3' }));
    expect(usePaletteSet.getState().set).toBe('berry');
    expect(localStorage.getItem(PALETTE_SET_KEY)).toBe('berry');
  });
});
