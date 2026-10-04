import { FileText } from 'lucide-react';
import { motion, useReducedMotion } from 'motion/react';
import { useEffect, useRef } from 'react';

import { Icon } from '../../components/Icon';
import { DROP_LIFT_FALLBACK, SPRING } from '../../lib/motion';
import { registerDropCard } from './openTransition';

/** The label of the sheet: the format's name, not a translatable word. */
const FILE_KIND = 'PDF';

/** The sheet of the preview card: a white page with a file tile and the format. The clone of the opening transition draws it too. */
export function DropCardFace() {
  return (
    <div className="flex size-full flex-col items-center justify-center gap-2 rounded-sm bg-surface-solid text-text-muted">
      <Icon icon={FileText} size={24} />
      <span className="text-sm">{FILE_KIND}</span>
    </div>
  );
}

/** The lift in px and scale, from the tokens (`--offset-enter`, `--scale-lift`; reduced motion resets them to 0 and 1). */
function lift(): { y: number; scale: number } {
  if (typeof document === 'undefined') return DROP_LIFT_FALLBACK;
  const style = getComputedStyle(document.documentElement);
  const y = Number.parseFloat(style.getPropertyValue('--offset-enter'));
  const scale = Number.parseFloat(style.getPropertyValue('--scale-lift'));
  return {
    y: Number.isFinite(y) ? y : DROP_LIFT_FALLBACK.y,
    scale: Number.isFinite(scale) ? scale : DROP_LIFT_FALLBACK.scale,
  };
}

/**
 * The preview card of a drag over the window (MOTION 4.5): 160 x 208, centred in its slot, lifted (up 8 px, scale 1.04, the large
 * shadow at full opacity) while the drag is over the window; when the drop is accepted it falls to rest (`falling`) and the large
 * shadow fades to the small one. The shadows are layers of their own, so only opacity animates. It never follows the pointer.
 */
export function DropCard({ falling = false }: { falling?: boolean }) {
  const reduce = useReducedMotion() === true;
  const ref = useRef<HTMLDivElement | null>(null);
  const { y, scale } = lift();
  const rest = reduce ? { y: 0, scale: 1 } : { y: -y, scale };

  useEffect(
    () =>
      registerDropCard(() => {
        const box = ref.current?.getBoundingClientRect();
        return box === undefined
          ? null
          : { rect: { left: box.left, top: box.top, width: box.width, height: box.height }, kind: 'card' };
      }),
    [],
  );

  return (
    <motion.div
      ref={ref}
      data-drop-card=""
      aria-hidden="true"
      initial={{ opacity: 0, ...rest }}
      animate={{
        opacity: reduce && falling ? 0 : 1,
        y: falling ? 0 : rest.y,
        scale: falling ? 1 : rest.scale,
        transition: reduce && falling ? SPRING.fast : SPRING.base,
      }}
      exit={{ opacity: 0, transition: SPRING.fast }}
      className="relative h-(--drag-card-height) w-(--drag-card-width) rounded-sm"
    >
      <span className="absolute inset-0 rounded-sm shadow-standard" />
      <motion.span
        className="absolute inset-0 rounded-sm shadow-floating"
        initial={false}
        animate={{ opacity: falling ? 0 : 1, transition: SPRING.base }}
      />
      <div className="relative size-full">
        <DropCardFace />
      </div>
    </motion.div>
  );
}
