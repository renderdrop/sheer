import { Check } from 'lucide-react';
import type { ComponentProps } from 'react';

import { cx } from './cx';
import { Icon } from './Icon';

type InputProps = Omit<ComponentProps<'input'>, 'type' | 'size'>;

/** Wrapper of the box and its mark; `peer` lets the mark follow the native input's state. */
const WRAP = 'relative inline-flex size-4 shrink-0 items-center justify-center';
const BOX =
  'peer m-0 size-4 shrink-0 cursor-pointer appearance-none border bg-surface-solid ' +
  'border-control-border not-disabled:hover:border-text checked:border-text checked:bg-accent ' +
  'disabled:cursor-not-allowed disabled:opacity-(--opacity-disabled) aria-disabled:cursor-not-allowed ' +
  'transition-[background-color,border-color] duration-fast';
const MARK =
  'pointer-events-none invisible absolute text-text peer-checked:visible peer-disabled:opacity-(--opacity-disabled)';

/**
 * The checkbox control (DESIGN 4, 2.6): a native `<input type="checkbox">` drawn as a 16 px box, radius sm. Stone border;
 * checked = Solar fill, Ink border, Ink check. Put it inside the `<label>` that names it. `className` goes to the wrapper.
 */
export function Checkbox({ className, ...input }: InputProps) {
  return (
    <span className={cx(WRAP, className)}>
      <input {...input} type="checkbox" className={cx(BOX, 'rounded-sm')} />
      <Icon icon={Check} className={MARK} />
    </span>
  );
}

/** The radio control (DESIGN 4, 2.6): like `Checkbox`, round, with an Ink dot. */
export function Radio({ className, ...input }: InputProps) {
  return (
    <span className={cx(WRAP, className)}>
      <input {...input} type="radio" className={cx(BOX, 'rounded-pill')} />
      <span aria-hidden="true" className={cx(MARK, 'size-2 rounded-pill bg-text')} />
    </span>
  );
}
