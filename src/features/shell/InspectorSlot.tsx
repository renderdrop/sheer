import type { CSSProperties, ReactNode } from 'react';

import { cx } from '../../components/cx';

export interface InspectorSlotProps {
  /** The inspector column is open: the track is 300 wide, else 0 and the slot is inert. */
  open: boolean;
  /** `grid-column` of the slot. */
  style: CSSProperties;
  /** The inspector content (DESIGN 3.18 E5); the tool inspector package renders it here. */
  children?: ReactNode;
}

/**
 * The inspector's slot of the editor body (DESIGN 3.18 E1): White, border on its left, the column right of the canvas. The track is
 * `--inspector-width` while a tool inspector or the history list is open and 0 otherwise (it snaps, no width tween); the slot is always
 * in the grid so no other slot moves. Closed, it is inert and empty to assistive technology.
 */
export function InspectorSlot({ open, style, children }: InspectorSlotProps) {
  return (
    <div
      data-slot="inspector"
      data-open={open ? '' : undefined}
      inert={!open}
      style={style}
      className={cx(
        'bg-panel relative flex min-h-0 min-w-0 flex-col overflow-hidden',
        open && 'border-s border-border-subtle',
      )}
    >
      {open ? children : null}
    </div>
  );
}
