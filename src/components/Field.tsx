import type { ComponentProps } from 'react';

import { FIELD_BASE, FIELD_SIZES, type FieldSize } from './controlStyles';
import { cx } from './cx';

export interface FieldProps extends Omit<ComponentProps<'input'>, 'size'> {
  /** `sm` 24 high (beside a slider) or `md` 32 high (in a form). Default `md`. */
  size?: FieldSize;
  /** Where the text sits. `end` for a number beside a slider, `start` otherwise. Default `start`. */
  align?: 'start' | 'end';
}

/**
 * Field (DESIGN 3.7): the one-line number field of the slider and of the forms in popovers. It is a plain `<input>` with
 * the look of the design system, so it takes every input attribute (`type`, `min`, `max`, `value`, `ref`, ...). It has no
 * label of its own: name it with a `<label>` around it or `htmlFor`, or `aria-label`.
 */
export function Field({ size = 'md', align = 'start', className, ...rest }: FieldProps) {
  return <input {...rest} className={cx(FIELD_BASE, FIELD_SIZES[size], align === 'end' && 'text-end', className)} />;
}
