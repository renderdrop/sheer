// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest';

import { setup } from '../test/render';
import { Toggle } from './Toggle';

describe('Toggle', () => {
  it('is a switch with its state, toggled by click and Space', async () => {
    const onChange = vi.fn();
    const { user, getByRole } = setup(<Toggle aria-label="Dark" checked={false} onCheckedChange={onChange} />);
    const toggle = getByRole('switch', { name: 'Dark' });
    expect(toggle.getAttribute('aria-checked')).toBe('false');
    await user.click(toggle);
    expect(onChange).toHaveBeenLastCalledWith(true);
    toggle.focus();
    await user.keyboard(' ');
    expect(onChange).toHaveBeenCalledTimes(2);
  });

  it('is 36 x 20 and does nothing while disabled', async () => {
    const onChange = vi.fn();
    const { user, getByRole } = setup(<Toggle aria-label="x" checked disabled onCheckedChange={onChange} />);
    const toggle = getByRole('switch');
    expect(toggle.className).toContain('w-(--toggle-width)');
    expect(toggle.className).toContain('h-5');
    await user.click(toggle);
    expect(onChange).not.toHaveBeenCalled();
  });
});

describe('Toggle knob travel', () => {
  it('on: 20 px, so the 12 px knob has the same 2 px gap on both sides of the 34 px inner track', () => {
    const { getByRole } = setup(<Toggle aria-label="x" checked onCheckedChange={() => undefined} />);
    const knob = getByRole('switch').firstElementChild as HTMLElement;
    expect(knob.className).toContain('translate-x-5');
    expect(knob.className).not.toContain('translate-x-4');
  });
});
