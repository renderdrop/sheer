import { cx } from './cx';

export interface SkeletonProps {
  /** Shape of the thing it stands for. Default `block`. */
  shape?: 'block' | 'line' | 'circle';
  /** Size classes (`h-4 w-24`, `size-swatch`): layout, not looks. */
  className?: string;
}

const SHAPES = { block: 'rounded-md', line: 'h-4 rounded-sm', circle: 'rounded-pill' } as const;

/** A placeholder (DESIGN 4): a Sand block in the shape of its target. Static; the shimmer comes with R5. Hidden from assistive tech. */
export function Skeleton({ shape = 'block', className }: SkeletonProps) {
  return <div aria-hidden="true" data-skeleton="" className={cx('bg-subtle', SHAPES[shape], className)} />;
}
