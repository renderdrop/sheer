import { cx } from '../../components/cx';

export interface ProgressBarProps {
  /** Accessible name. */
  label: string;
  done: number;
  /** 0 or unknown: the bar is indeterminate. */
  total: number;
  className?: string;
}

/**
 * The progress bar shared by every new-file job (DESIGN 3.30): a 4 high pill on `--color-track` with an accent fill. Under reduced
 * motion the fill steps instead of gliding and the indeterminate bar does not pulse.
 */
export function ProgressBar({ label, done, total, className }: ProgressBarProps) {
  const known = total > 0;
  const ratio = known ? Math.min(1, Math.max(0, done / total)) : 1;
  return (
    <div
      role="progressbar"
      aria-label={label}
      aria-valuemin={0}
      aria-valuemax={known ? total : undefined}
      aria-valuenow={known ? Math.min(done, total) : undefined}
      className={cx('h-0-5 w-full overflow-hidden rounded-full bg-track', className)}
    >
      <div
        className={cx(
          'h-full rounded-full bg-accent transition-[width] duration-base motion-reduce:transition-none',
          !known && 'animate-pulse motion-reduce:animate-none',
        )}
        style={{ width: `${Math.round(ratio * 100)}%` }}
      />
    </div>
  );
}
