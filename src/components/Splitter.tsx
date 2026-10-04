import { useRef, useState, type KeyboardEvent, type PointerEvent } from 'react';

import { useT } from '../i18n';
import { cx } from './cx';
import { PANEL } from './tokens';

export interface SplitterProps {
  /** Accessible name ("Resize left panel"). */
  label: string;
  /** Id of the pane this separator resizes (`aria-controls`). */
  controls: string;
  /** Width of the controlled pane in px. While `collapsed` it is the width that comes back on restore. */
  value: number;
  collapsed: boolean;
  onValueChange: (value: number) => void;
  onCollapsedChange: (collapsed: boolean) => void;
  /** Range, step, Shift step, double-click reset and collapse threshold; the defaults are the left panel's (`PANEL`, DESIGN 3.8). */
  min?: number;
  max?: number;
  step?: number;
  largeStep?: number;
  defaultValue?: number;
  /** Releasing a drag with the pane narrower than this collapses it. */
  collapseBelow?: number;
  /** Which side of the separator the controlled pane is on. `before`: dragging right widens it. Default `before`. */
  pane?: 'before' | 'after';
  /** Text for `aria-valuetext`. */
  valueText?: (value: number, collapsed: boolean) => string;
  className?: string;
}

interface Drag {
  startX: number;
  /** Pane width when the drag began; 0 when it began collapsed. */
  startWidth: number;
  /** Width the pointer asks for, before clamping. */
  raw: number;
}

const clamp = (value: number, low: number, high: number) => Math.min(high, Math.max(low, value));

/**
 * Window splitter (DESIGN 3.8, WAI-ARIA window splitter pattern): the 8 px gutter beside a panel. `role=separator`, one
 * tab stop. Left and Right resize by `step` (Shift: `largeStep`), Home and End jump to the ends of the range, Enter
 * collapses or restores, double click resets to `defaultValue`. A drag snaps to `step` and collapses the pane when
 * released narrower than `collapseBelow`. `aria-valuenow` is 0 while collapsed. The component only reports values;
 * the parent owns the width, persists it and animates the collapse.
 */
export function Splitter({
  label,
  controls,
  value,
  collapsed,
  onValueChange,
  onCollapsedChange,
  min = PANEL.min,
  max = PANEL.max,
  step = PANEL.step,
  largeStep = PANEL.largeStep,
  defaultValue = PANEL.default,
  collapseBelow = PANEL.collapseBelow,
  pane = 'before',
  valueText,
  className,
}: SplitterProps) {
  const t = useT();
  const drag = useRef<Drag | null>(null);
  const [dragging, setDragging] = useState(false);
  // Which arrow widens the pane follows the side it is on.
  const grow = pane === 'before' ? 'ArrowRight' : 'ArrowLeft';
  const shrink = pane === 'before' ? 'ArrowLeft' : 'ArrowRight';
  const direction = pane === 'before' ? 1 : -1;

  const snap = (width: number) => clamp(Math.round(width / step) * step, min, max);

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key === 'Enter') {
      event.preventDefault();
      onCollapsedChange(!collapsed);
      return;
    }
    if (collapsed) {
      // A collapsed pane comes back on the key that would widen it, or on End.
      if (event.key === grow || event.key === 'End') {
        event.preventDefault();
        onCollapsedChange(false);
      }
      return;
    }
    const size = event.shiftKey ? largeStep : step;
    let next: number;
    switch (event.key) {
      case grow:
        next = value + size;
        break;
      case shrink:
        next = value - size;
        break;
      case 'Home':
        next = min;
        break;
      case 'End':
        next = max;
        break;
      default:
        return;
    }
    event.preventDefault();
    const clamped = clamp(next, min, max);
    if (clamped !== value) onValueChange(clamped);
  };

  const onPointerDown = (event: PointerEvent<HTMLDivElement>) => {
    if (event.button !== 0) return;
    event.currentTarget.setPointerCapture(event.pointerId);
    const startWidth = collapsed ? 0 : value;
    drag.current = { startX: event.clientX, startWidth, raw: startWidth };
    setDragging(true);
  };

  const onPointerMove = (event: PointerEvent<HTMLDivElement>) => {
    const current = drag.current;
    if (current === null) return;
    current.raw = current.startWidth + direction * (event.clientX - current.startX);
    // Narrower than the collapse threshold the pane waits at its current width; the release decides.
    if (current.raw < collapseBelow) return;
    if (collapsed) onCollapsedChange(false);
    const next = snap(current.raw);
    if (next !== value) onValueChange(next);
  };

  const onPointerUp = (event: PointerEvent<HTMLDivElement>) => {
    const current = drag.current;
    if (current === null) return;
    drag.current = null;
    setDragging(false);
    event.currentTarget.releasePointerCapture(event.pointerId);
    if (current.raw < collapseBelow) {
      // Keep the width from before the drag, so restoring brings back what the user had.
      if (current.startWidth > 0 && current.startWidth !== value) onValueChange(current.startWidth);
      if (!collapsed) onCollapsedChange(true);
    }
  };

  return (
    <div
      role="separator"
      aria-orientation="vertical"
      aria-label={label}
      aria-controls={controls}
      aria-valuemin={0}
      aria-valuemax={max}
      aria-valuenow={collapsed ? 0 : value}
      aria-valuetext={
        valueText !== undefined
          ? valueText(value, collapsed)
          : collapsed
            ? t('component.collapsed')
            : t('component.splitterValue', { count: value })
      }
      tabIndex={0}
      data-dragging={dragging ? 'true' : undefined}
      onKeyDown={onKeyDown}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onPointerCancel={onPointerUp}
      onDoubleClick={() => {
        if (collapsed) onCollapsedChange(false);
        onValueChange(defaultValue);
      }}
      className={cx(
        'group relative flex w-splitter shrink-0 cursor-col-resize touch-none items-center justify-center self-stretch',
        className,
      )}
    >
      {/* The 4 x 32 px grip: hidden at rest, control border on hover, accent while dragging or focused. */}
      <span
        aria-hidden="true"
        className={cx(
          'h-8 w-1 rounded-pill transition-[background-color]',
          dragging ? 'bg-accent' : 'bg-transparent group-hover:bg-control-border group-focus-visible:bg-accent',
        )}
      />
    </div>
  );
}
