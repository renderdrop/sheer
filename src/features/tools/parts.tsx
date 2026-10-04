import type { LucideIcon } from 'lucide-react';
import type { ReactNode } from 'react';

import { Icon, Tooltip } from '../../components';
import { cx } from '../../components/cx';

/** Row geometry of the disclosure's action rows: 32 high, radius md. */
const ACTION_ROW =
  'group flex h-8 w-full cursor-pointer items-center gap-2 rounded-md px-2 text-start t-label text-text transition-colors duration-fast ' +
  'aria-disabled:cursor-not-allowed aria-disabled:opacity-(--opacity-disabled) not-aria-disabled:hover:bg-control-hover ' +
  'not-aria-disabled:active:bg-control-pressed aria-pressed:bg-selected aria-pressed:font-semibold';

export interface ActionRowProps {
  icon: LucideIcon;
  label: string;
  onActivate: () => void;
  /** Soft-disabled: stays focusable, does nothing. */
  disabled?: boolean;
  /** For a choice (the kind of text): the chosen one. */
  pressed?: boolean;
  /** The tooltip's key chip and one-line hint. */
  shortcut?: string;
  hint?: string;
  trailing?: ReactNode;
}

/** An action row (DESIGN v2 3.2): icon 16, `.t-label`, 32 high. Its tooltip carries the hint and the shortcut. */
export function ActionRow({
  icon,
  label,
  onActivate,
  disabled = false,
  pressed,
  shortcut,
  hint,
  trailing,
}: ActionRowProps) {
  const row = (
    <button
      type="button"
      aria-pressed={pressed}
      aria-disabled={disabled ? true : undefined}
      onClick={() => {
        if (!disabled) onActivate();
      }}
      className={ACTION_ROW}
    >
      <Icon icon={icon} />
      <span className="min-w-0 flex-1 truncate">{label}</span>
      {trailing}
    </button>
  );
  if (hint === undefined && shortcut === undefined) return row;
  return (
    <Tooltip label={label} note={hint} shortcut={shortcut} side="left">
      {row}
    </Tooltip>
  );
}

/** A quiet explanation under a row's options. */
export function Hint({ children, className }: { children: ReactNode; className?: string }) {
  return <p className={cx('m-0 t-caption', className)}>{children}</p>;
}

/** A labelled group of rows: the label is `.t-caption`, the rows sit 2 apart. */
export function Group({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div role="group" aria-label={label} className="flex flex-col gap-half">
      <span className="t-caption flex h-6 items-center px-2">{label}</span>
      {children}
    </div>
  );
}
