// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest';

import { setup } from '../test/render';
import { Checkbox, Radio } from './Checkbox';

describe('Checkbox and Radio', () => {
  it('keep the native input: named by the label, toggled by click and Space', async () => {
    const onChange = vi.fn();
    const { user, getByRole } = setup(
      <label>
        <Checkbox checked={false} onChange={(event) => onChange(event.target.checked)} />
        Remember
      </label>,
    );
    const box = getByRole('checkbox', { name: 'Remember' });
    await user.click(box);
    expect(onChange).toHaveBeenLastCalledWith(true);
    box.focus();
    await user.keyboard(' ');
    expect(onChange).toHaveBeenCalledTimes(2);
  });

  it('draw a 16 px box (radius sm) and a round radio', () => {
    const { getByRole } = setup(
      <>
        <Checkbox aria-label="a" defaultChecked />
        <Radio aria-label="b" name="g" defaultChecked />
      </>,
    );
    expect(getByRole('checkbox').className).toContain('rounded-sm');
    expect(getByRole('checkbox').className).toContain('size-4');
    expect(getByRole('radio').className).toContain('rounded-pill');
  });

  it('do not react while disabled', async () => {
    const onChange = vi.fn();
    const { user, getByRole } = setup(<Checkbox aria-label="a" disabled onChange={onChange} />);
    await user.click(getByRole('checkbox'));
    expect(onChange).not.toHaveBeenCalled();
  });
});
