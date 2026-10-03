import { AnimatePresence, motion, useIsPresent } from 'motion/react';
import { memo, type CSSProperties } from 'react';

import { Panel, PanelSection } from '../../components';
import { usePanelFade } from '../../components/motion';
import { useT } from '../../i18n';

/**
 * The inspector slot (DESIGN 3.9): a 288 px G1 `<aside>` that fades in (opacity 250) without moving the canvas and
 * never takes focus by itself. Its header names the selection, or says "Tool options"; the body is a placeholder until
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
 * panel fades over 250 ms beside it (opacity only under reduced motion) and leaves the page once it has faded.
 */
export function InspectorSlot({ present, style }: InspectorSlotProps) {
  return (
    <AnimatePresence initial={false}>{present && <InspectorFrame key="inspector" style={style} />}</AnimatePresence>
  );
}

function InspectorFrame({ style }: { style: CSSProperties }) {
  const motionProps = usePanelFade();
  const present = useIsPresent();
  return (
    <motion.div
      {...motionProps}
      inert={!present}
      style={style}
      className="grid min-h-0 min-w-0 grid-cols-[minmax(0,1fr)] grid-rows-[minmax(0,1fr)]"
    >
      <Inspector />
    </motion.div>
  );
}
