// @vitest-environment jsdom
import { useState } from 'react';
import { describe, expect, it } from 'vitest';

import { setup } from '../test/render';
import { Segmented } from './Segmented';

const OPTIONS = [
  { value: 'a', label: 'One' },
  { value: 'b', label: 'Two' },
  { value: 'c', label: 'Three' },
] as const;

function Demo() {
  const [value, setValue] = useState<'a' | 'b' | 'c'>('a');
  return <Segmented label="Pick" value={value} options={OPTIONS} onValueChange={setValue} />;
}

describe('Segmented', () => {
  it('is a radiogroup with one tab stop', () => {
    const { getByRole, getAllByRole } = setup(<Demo />);
    expect(getByRole('radiogroup', { name: 'Pick' })).not.toBeNull();
    expect(getAllByRole('radio').map((radio) => radio.tabIndex)).toEqual([0, -1, -1]);
    expect(getByRole('radio', { name: 'One' }).getAttribute('aria-checked')).toBe('true');
  });

  it('chooses with the arrows (wrapping), Home and End, and with a click', async () => {
    const { user, getByRole } = setup(<Demo />);
    await user.tab();
    await user.keyboard('{ArrowRight}');
    expect(getByRole('radio', { name: 'Two' }).getAttribute('aria-checked')).toBe('true');
    await user.keyboard('{End}{ArrowRight}');
    expect(getByRole('radio', { name: 'One' }).getAttribute('aria-checked')).toBe('true');
    await user.click(getByRole('radio', { name: 'Three' }));
    expect(getByRole('radio', { name: 'Three' }).getAttribute('aria-checked')).toBe('true');
  });

  it('segments keep their whole label and wrap to a second row instead of cutting it', () => {
    const { getByRole, getAllByRole } = setup(<Demo />);
    expect(getByRole('radiogroup', { name: 'Pick' }).className).toContain('flex-wrap');
    for (const radio of getAllByRole('radio')) {
      expect(radio.className).toContain('whitespace-nowrap');
      expect(radio.className).toContain('min-w-fit');
    }
  });
});
