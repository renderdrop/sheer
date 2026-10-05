// @vitest-environment jsdom
import { screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import { setup } from '../test/render';
import { ColourPopover, type ColourEntry } from './ColourPopover';

const PALETTE: ColourEntry[] = [
  { id: 'a', rgb: [15, 15, 15], label: 'Ink', fillClass: 'bg-stroke-ink' },
  { id: 'b', rgb: [31, 158, 106], label: 'Mint', fillClass: 'bg-stroke-mint' },
];

async function open(recent: [number, number, number][] = []) {
  const onPick = vi.fn();
  const onApply = vi.fn();
  const view = setup(
    <ColourPopover palette={PALETTE} recent={recent} value={[15, 15, 15]} onPick={onPick} onApply={onApply} />,
  );
  await view.user.click(screen.getByRole('button', { name: 'More colours' }));
  return { ...view, onPick, onApply };
}

describe('ColourPopover (DESIGN 3.9 Q4)', () => {
  const check = () => screen.getByRole('button', { name: 'Apply' });

  it('shows the palette and a full-width hex field; the check is off until the hex is valid', async () => {
    await open();
    expect(screen.getByRole('radio', { name: 'Mint' })).not.toBeNull();
    expect(check().getAttribute('aria-disabled')).toBe('true');
    expect(screen.getByRole('textbox', { name: 'Hex colour' }).className).toContain('w-full');
  });

  it('marks an invalid hex only after Enter, explains it, and applies a valid one', async () => {
    const { user, onApply } = await open();
    const field = screen.getByRole('textbox', { name: 'Hex colour' });
    await user.type(field, 'ZZ');
    expect(field.getAttribute('aria-invalid')).toBeNull();
    await user.keyboard('{Enter}');
    expect(field.getAttribute('aria-invalid')).toBe('true');
    expect(screen.getByRole('alert').textContent).toBe('Use 3 or 6 hex digits, e.g. 1F9E6A');
    expect(onApply).not.toHaveBeenCalled();
    await user.clear(field);
    await user.type(field, '#1f9e6a{Enter}');
    expect(onApply).toHaveBeenCalledWith([31, 158, 106]);
  });

  it('strips a pasted # and spaces, and confirms with the check', async () => {
    const { user, onApply } = await open();
    const field = screen.getByRole('textbox', { name: 'Hex colour' });
    await user.click(field);
    await user.paste(' #1F9E6A ');
    expect((field as HTMLInputElement).value).toBe('1F9E6A');
    await user.click(check());
    expect(onApply).toHaveBeenCalledWith([31, 158, 106]);
  });

  it('Esc closes without applying', async () => {
    const { user, onApply } = await open();
    await user.type(screen.getByRole('textbox', { name: 'Hex colour' }), '1F9E6A');
    await user.keyboard('{Escape}');
    expect(screen.queryByRole('textbox', { name: 'Hex colour' })).toBeNull();
    expect(onApply).not.toHaveBeenCalled();
  });

  it('warns about low contrast without blocking', async () => {
    const { user, onApply } = await open();
    await user.type(screen.getByRole('textbox', { name: 'Hex colour' }), 'FFF84D');
    expect(screen.getByText('Low contrast on white')).not.toBeNull();
    await user.click(check());
    expect(onApply).toHaveBeenCalled();
  });

  it('puts the recent colours in the palette grid and picks one', async () => {
    const { user, onPick } = await open([[1, 2, 3]]);
    expect(screen.queryByText('Recently used')).toBeNull();
    await user.click(screen.getByRole('radio', { name: '#010203' }));
    expect(onPick).toHaveBeenCalledWith([1, 2, 3]);
  });

  it('arrow keys move over the swatches', async () => {
    const { user } = await open();
    screen.getByRole('radio', { name: 'Ink' }).focus();
    await user.keyboard('{ArrowRight}');
    expect(document.activeElement).toBe(screen.getByRole('radio', { name: 'Mint' }));
  });
});
