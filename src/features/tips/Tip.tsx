import { AnimatePresence, motion, useIsPresent } from 'motion/react';
import { Lightbulb, X } from 'lucide-react';
import { useEffect, useId, useLayoutEffect, useRef, useState, type KeyboardEvent } from 'react';
import { createPortal } from 'react-dom';

import { Icon, IconButton, announce } from '../../components';
import { usePopoverMotion } from '../../components/motion';
import { useNoticeSlot } from '../../components/notices';
import { tokenPx } from '../../components/tokens';
import { useFloatingPosition } from '../../components/useFloatingPosition';
import { useT } from '../../i18n';
import { modifierLabel } from '../../lib/shortcuts';
import { useSettings } from '../../stores/settings';
import { resolveToolbarItem, type ResolvedAnchor } from '../tour/anchors';
import { toolbarItemsOf, type TipId } from './model';
import { useTips } from './store';

/** The canvas's scroller: the slot the tip stays inside (the coach mark's, DESIGN 3.47 "Slot and layer"). */
const CANVAS_SCROLLER = '[data-action-scope="canvas"] > [role="region"]';

/** The red redact band in the banner slot. */
const REDACT_BAND = '[data-banner="redact"]';

/** Popovers, menus and dialogs are portaled to the body; the tip goes when one opens after it. */
const OVERLAYS = '[role="menu"], [role="dialog"], [aria-modal="true"]';

/** The tool item to point at (the pressed one of a family), else the ⋯ button when the row moved it into More. */
function resolveTipAnchor(id: TipId): ResolvedAnchor | null {
  // Redact mode has a red band under the toolbar: the tip sits below the band, never over its label.
  if (id === 'redact') {
    const band = document.querySelector<HTMLElement>(REDACT_BAND);
    if (band !== null) return { element: band, spec: { selector: REDACT_BAND, side: 'bottom', align: 'center' } };
  }
  const found = toolbarItemsOf(id)
    .map((item) => resolveToolbarItem(item))
    .filter((anchor): anchor is ResolvedAnchor => anchor !== null);
  const pressed = found.find((anchor) => anchor.element.getAttribute('aria-pressed') === 'true');
  return pressed ?? found[0] ?? resolveToolbarItem('overflow');
}

/** The toolbar item of the tip, looked up again after a resize, since the toolbar may move it into More. */
function useAnchor(id: TipId): ResolvedAnchor | null {
  const [anchor, setAnchor] = useState<ResolvedAnchor | null>(null);
  useLayoutEffect(() => {
    const find = () =>
      setAnchor((previous) => {
        const next = resolveTipAnchor(id);
        return previous?.element === next?.element ? previous : next;
      });
    find();
    window.addEventListener('resize', find);
    let frame = 0;
    const observer = new MutationObserver(() => {
      if (frame === 0) {
        frame = requestAnimationFrame(() => {
          frame = 0;
          find();
        });
      }
    });
    const toolbar = document.querySelector('[role="toolbar"]');
    if (toolbar !== null) observer.observe(toolbar, { childList: true, subtree: true });
    return () => {
      window.removeEventListener('resize', find);
      observer.disconnect();
      cancelAnimationFrame(frame);
    };
  }, [id]);
  return anchor;
}

/** Ends the tip when a popover, menu or dialog opens after it showed. */
function useDismissOnOverlay(active: boolean): void {
  useEffect(() => {
    if (!active) return;
    const before = new Set(document.querySelectorAll(OVERLAYS));
    const observer = new MutationObserver(() => {
      for (const overlay of document.querySelectorAll(OVERLAYS)) {
        if (!before.has(overlay)) {
          useTips.getState().dismiss();
          return;
        }
      }
    });
    observer.observe(document.body, { childList: true });
    return () => observer.disconnect();
  }, [active]);
}

function Card({ id, anchor }: { id: TipId; anchor: ResolvedAnchor }) {
  const t = useT();
  const platform = useSettings((state) => state.platform);
  const positioner = useRef<HTMLDivElement>(null);
  const present = useIsPresent();
  const motionProps = usePopoverMotion();
  const textId = useId();
  const dismiss = useTips((state) => state.dismiss);
  const text = t(`tip.${id}`, { mod: modifierLabel(platform, 'primary', t) });
  const anchorEl = anchor.element;

  useFloatingPosition({
    anchor: anchorEl,
    floatingRef: positioner,
    active: present,
    side: 'bottom',
    align: 'center',
    kind: 'tip',
    clampTo: { selector: CANVAS_SCROLLER, inset: tokenPx('--space-2', 8) },
  });

  // The tool is described by the tip while it shows (DESIGN 3.47).
  useEffect(() => {
    anchorEl.setAttribute('aria-describedby', textId);
    return () => {
      if (anchorEl.getAttribute('aria-describedby') === textId) anchorEl.removeAttribute('aria-describedby');
    };
  }, [anchorEl, textId]);

  // The text goes once to the status bar's polite live region.
  useEffect(() => {
    announce(t('tip.announce', { text }));
  }, [t, text]);

  const onKeyDown = (event: KeyboardEvent<HTMLElement>) => {
    // Esc with focus inside ends the tip and returns focus to the canvas; elsewhere Esc is not ours (DESIGN 2.3).
    if (event.key !== 'Escape') return;
    event.preventDefault();
    event.stopPropagation();
    dismiss();
    const canvas = document.querySelector<HTMLElement>(CANVAS_SCROLLER);
    if (canvas !== null) canvas.focus({ preventScroll: true });
    else if (document.activeElement instanceof HTMLElement) document.activeElement.blur();
  };

  return (
    <div
      ref={positioner}
      className={`fixed start-0 top-0 z-popover flex flex-col ${present ? '' : 'pointer-events-none'}`}
    >
      <motion.section
        {...motionProps}
        role="region"
        aria-label={t('tip.region')}
        data-tip-card=""
        onKeyDown={onKeyDown}
        className="bg-panel border border-border-subtle shadow-floating flex w-(--note-width) max-w-full items-center gap-2 rounded-panel p-3 text-md text-text"
      >
        <Icon icon={Lightbulb} size={16} className="text-text" />
        <p id={textId} className="m-0 min-w-0 flex-1 text-md">
          {text}
        </p>
        <IconButton label={t('tip.dismiss')} icon={X} size="sm" onClick={dismiss} />
      </motion.section>
    </div>
  );
}

/** The tool tip (DESIGN 3.47): one compact card under the tool, never taking focus, with no timeout. */
export function Tip() {
  const id = useTips((state) => state.current);
  return <TipBody key={id ?? 'none'} id={id} />;
}

function TipBody({ id }: { id: TipId | null }) {
  const anchor = useAnchor(id ?? 'highlight');
  useDismissOnOverlay(id !== null);
  // One notice at a time (DESIGN 3.9 Q8): the tip waits in the queue behind a toast or the coach mark.
  const shown = useNoticeSlot('tip', 'tip', id !== null && anchor !== null);
  return createPortal(
    <AnimatePresence>
      {shown && id !== null && anchor !== null && <Card key={id} id={id} anchor={anchor} />}
    </AnimatePresence>,
    document.body,
  );
}
