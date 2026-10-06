import { AnimatePresence, motion, useIsPresent } from 'motion/react';
import { Wand } from 'lucide-react';
import { useRef } from 'react';
import { createPortal } from 'react-dom';

import { Icon } from '../../components';
import { useFloatingPosition } from '../../components/useFloatingPosition';
import { EASE_OUT } from '../../lib/motion';
import { DURATION } from '../../components/motion';

/**
 * The link preview (DESIGN 3.11 L5): a tooltip-class card with the "Detected" hint on every link, every time. White, hairline border,
 * radius md, floating shadow, `role="tooltip"`, not focusable and not interactive. The header names the kind and the target page; the
 * body is the target's text (cut by Rust); the footer says how to jump and how to return. Placement is the tooltip's (Q8); with no fit
 * it is not shown (the link still works). It only fades (spell 16), also under reduced motion.
 */
export interface LinkPreviewProps {
  id: string;
  /** The run the card hangs off. */
  anchor: HTMLElement | null;
  /** `smartlinks.detected` and the kind, page and physical page, already as text. */
  detected: string;
  kind: string;
  page: string;
  /** The target's text; empty for a page target without a heading. */
  body: string;
  /** The footer with the key chip's place marked by `chip`: text before and after it. */
  hintBefore: string;
  hintKey: string;
  hintAfter: string;
}

/** The marker the hint's key is replaced with while the text is split around it. */
export const KEY_MARK = '\u0000';

/** Splits the hint text `before {back} after` around the key. */
export function splitHint(text: string): { before: string; after: string } {
  const at = text.indexOf(KEY_MARK);
  return at < 0 ? { before: text, after: '' } : { before: text.slice(0, at), after: text.slice(at + 1) };
}

const variants = {
  hidden: { opacity: 0 },
  shown: {
    opacity: 1,
    transition: { duration: DURATION.fast, ease: [...EASE_OUT] as [number, number, number, number] },
  },
  gone: {
    opacity: 0,
    transition: { duration: DURATION.fast, ease: [...EASE_OUT] as [number, number, number, number] },
  },
};

function Card({
  id,
  anchor,
  detected,
  kind,
  page,
  body,
  hintBefore,
  hintKey,
  hintAfter,
  onNoFit,
}: LinkPreviewProps & { onNoFit?: () => void }) {
  const ref = useRef<HTMLDivElement>(null);
  const present = useIsPresent();
  useFloatingPosition({
    anchor,
    floatingRef: ref,
    active: present,
    side: 'bottom',
    align: 'start',
    kind: 'tooltip',
    onNoFit,
  });
  return (
    <div
      ref={ref}
      role="tooltip"
      id={id}
      data-link-preview=""
      data-surface="link-preview"
      className="pointer-events-none fixed start-0 top-0 z-tooltip"
    >
      <motion.div
        variants={variants}
        initial="hidden"
        animate="shown"
        exit="gone"
        className="flex w-max min-w-popover-min max-w-link-preview-max flex-col gap-1 rounded-md border border-border-subtle bg-panel p-3 text-text shadow-floating"
      >
        <div className="flex min-h-5 items-center gap-1 text-text-muted">
          <Icon icon={Wand} size={16} />
          <span className="t-caption">
            {detected} · {kind} · {page}
          </span>
        </div>
        {body !== '' && <p className="t-body m-0 text-text">{body}</p>}
        <p className="t-caption m-0 text-text-muted">
          {hintBefore}
          <kbd className="mx-1 inline-flex h-5 min-w-5 items-center justify-center rounded-sm border border-border bg-subtle px-1 font-sans text-xs font-medium tabular-nums">
            {hintKey}
          </kbd>
          {hintAfter}
        </p>
      </motion.div>
    </div>
  );
}

/** The preview of the link whose run is `props.anchor`; nothing without an anchor. `onNoFit` hears that it found no place. */
export function LinkPreview(props: LinkPreviewProps & { open: boolean; onNoFit?: () => void }) {
  const { open, ...card } = props;
  return createPortal(
    <AnimatePresence>{open && card.anchor !== null && <Card key={card.id} {...card} />}</AnimatePresence>,
    document.body,
  );
}
