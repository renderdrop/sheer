import { AnimatePresence, motion, useIsPresent } from 'motion/react';
import { memo, type CSSProperties } from 'react';

import { Panel, PanelSection } from '../../components';
import { LAYOUT } from '../../components/tokens';
import { useT } from '../../i18n';
import { usePanelSlide } from './usePanelSlide';

/**
 * The inspector slot (DESIGN 3.9): a 288 px G1 `<aside>` that slides in (MOTION 4.2) and never takes focus by itself. Its header names the selection, or says "Tool options"; the body is a placeholder until
 * the annotation tools (M2) put their properties here.
 */
export const Inspector = memo(function Inspector() {
  const t = useT();
  return (
    <Panel label={t('inspector.label')} title={t('inspector.title')}>
      <PanelSection>
        <p className="m-0 text-sm text-text-muted">{t('inspector.empty')}</p>
      </PanelSection>
    </Panel>
  );
});

export interface InspectorSlotProps {
  /** The inspector has its track (a selection, a tool, or the user opened it). A change fades it in or out and is gone once faded. */
  present: boolean;
  /** `grid-column` of the slot. */
  style: CSSProperties;
}

/**
 * The inspector's slot of the main grid, handled like the left panel's (`LeftPanelSlot`): the track animates in `MainGrid`, the
 * panel slides in from the trailing edge at its final width (opacity only under reduced motion) and leaves the page once it has gone.
 */
export function InspectorSlot({ present, style }: InspectorSlotProps) {
  return (
    <div style={style} className="grid min-h-0 min-w-0 group-data-[animating]/main:overflow-clip">
      <AnimatePresence initial={false}>{present && <InspectorFrame key="inspector" />}</AnimatePresence>
    </div>
  );
}

function InspectorFrame() {
  const motionProps = usePanelSlide('end', LAYOUT.inspector);
  const present = useIsPresent();
  return (
    <motion.div
      {...motionProps}
      inert={!present}
      style={{ width: LAYOUT.inspector }}
      className="grid min-h-0 grid-cols-[minmax(0,1fr)] grid-rows-[minmax(0,1fr)] justify-self-end"
    >
      <Inspector />
    </motion.div>
  );
}
