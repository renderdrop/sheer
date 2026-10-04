// @vitest-environment jsdom
import { createRef } from 'react';
import { describe, expect, it, vi } from 'vitest';

import { setup } from '../test/render';
import { Field } from './Field';

describe('Field (DESIGN 3.7)', () => {
  it('is a plain input that takes the input attributes, a ref and a label', async () => {
    const onChange = vi.fn();
    const ref = createRef<HTMLInputElement>();
    const { user, getByLabelText } = setup(
      <label>
        Page number
        <Field ref={ref} type="number" min={1} max={9} defaultValue={3} onChange={onChange} />
      </label>,
    );
    const field = getByLabelText('Page number') as HTMLInputElement;
    expect(field).toBe(ref.current);
    expect(field.type).toBe('number');
    expect(field.min).toBe('1');
    expect(field.value).toBe('3');
    await user.type(field, '4');
    expect(onChange).toHaveBeenCalled();
  });

  it('is 56 wide through the token and does not shrink, in both sizes', () => {
    const { getByLabelText, rerender } = setup(<Field aria-label="A" />);
    for (const size of ['sm', 'md'] as const) {
      rerender(<Field aria-label="A" size={size} />);
      expect(getByLabelText('A').className).toContain('w-field');
      expect(getByLabelText('A').className).toContain('shrink-0');
    }
  });

  it('sm is 24 high with small type and md 32 high with body type; md is the default', () => {
    const { getByLabelText, rerender } = setup(<Field aria-label="A" />);
    expect(getByLabelText('A').className).toContain('h-control-md');
    expect(getByLabelText('A').className).toContain('text-md');
    rerender(<Field aria-label="A" size="sm" />);
    expect(getByLabelText('A').className).toContain('h-control-sm');
    expect(getByLabelText('A').className).toContain('text-sm');
    expect(getByLabelText('A').className).not.toContain('h-control-md');
  });

  it('puts the text at the end on request', () => {
    const { getByLabelText, rerender } = setup(<Field aria-label="A" />);
    expect(getByLabelText('A').className).not.toContain('text-end');
    rerender(<Field aria-label="A" align="end" />);
    expect(getByLabelText('A').className).toContain('text-end');
  });

  it('has the states of a control through tokens: the border, disabled, invalid; the focus ring is the global one', () => {
    const { getByLabelText } = setup(<Field aria-label="A" />);
    const classes = getByLabelText('A').className;
    expect(classes).toContain('border-control-border');
    expect(classes).toContain('bg-surface-solid');
    expect(classes).toContain('disabled:border-divider');
    expect(classes).toContain('disabled:text-text-disabled');
    expect(classes).toContain('aria-invalid:border-error-icon');
    // No class of its own for the focus ring, and none that removes the global one.
    expect(classes).not.toMatch(/outline|ring/);
  });

  it('a disabled field cannot be typed into, and an invalid one says so to assistive technology', async () => {
    const onChange = vi.fn();
    const { user, getByLabelText, rerender } = setup(<Field aria-label="A" disabled onChange={onChange} />);
    await user.type(getByLabelText('A'), 'x');
    expect(onChange).not.toHaveBeenCalled();
    rerender(<Field aria-label="A" aria-invalid="true" />);
    expect(getByLabelText('A').getAttribute('aria-invalid')).toBe('true');
  });

  it('keeps the classes of the caller after its own', () => {
    const { getByLabelText } = setup(<Field aria-label="A" className="mt-2" />);
    expect(getByLabelText('A').className.endsWith('mt-2')).toBe(true);
  });
});
