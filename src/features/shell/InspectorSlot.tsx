import type { CSSProperties, ReactNode } from 'react';

import { Splitter } from '../../components';
import { cx } from '../../components/cx';
import { INSPECTOR } from '../../components/tokens';
import { useT } from '../../i18n';
import { useUi } from '../../stores/ui';
import { INSPECTOR_ID } from './ids';

export interface InspectorSlotProps {
  /** The inspector column is open: the track is the chosen width (240 to 480, default 300), else 0 and the slot is inert. */
  open: boolean;
  /** `grid-column` of the slot. */
  style: CSSProperties;
  /** The inspector content (DESIGN 3.18 E5); the tool inspector package renders it here. */
  children?: ReactNode;
}

const resizeInspector = (width: number) => useUi.getState().setInspectorWidth(width);
const keepOpen = () => undefined;

/**
 * The inspector's slot of the editor body (DESIGN 3.18 E1): the chrome background, border on its left, the column right of the canvas. The
 * track is `ui.inspectorWidth` (F20.8) while a tool inspector or the history list is open and 0 otherwise (it snaps, no width tween); the slot
 * is always in the grid so no other slot moves. Closed, it is inert and empty to assistive technology. The splitter sits on its left edge
 * and resizes it from 240 to 480 by drag or keys; it never collapses the column.
 */
export function InspectorSlot({ open, style, children }: InspectorSlotProps) {
  const t = useT();
  const width = useUi((state) => state.inspectorWidth);
  return (
    <div
      id={INSPECTOR_ID}
      data-slot="inspector"
      data-open={open ? '' : undefined}
      inert={!open}
      style={style}
      className={cx('bg-chrome relative flex min-h-0 min-w-0 flex-row overflow-hidden')}
    >
      {open && (
        <>
          <Splitter
            label={t('inspector.resize')}
            controls={INSPECTOR_ID}
            value={width}
            collapsed={false}
            pane="after"
            min={INSPECTOR.min}
            max={INSPECTOR.max}
            step={INSPECTOR.step}
            largeStep={INSPECTOR.largeStep}
            defaultValue={INSPECTOR.default}
            collapseBelow={0}
            onValueChange={resizeInspector}
            onCollapsedChange={keepOpen}
          />
          <div className="flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden">{children}</div>
        </>
      )}
    </div>
  );
}
