import { AnimatePresence, motion, useIsPresent, useReducedMotion } from 'motion/react';
import { Lightbulb, RotateCcw, X } from 'lucide-react';
import { useCallback, useEffect, useId, useLayoutEffect, useRef, useState, type KeyboardEvent } from 'react';
import { createPortal } from 'react-dom';

import { Icon, IconButton, announce } from '../../components';
import { usePopoverMotion } from '../../components/motion';
import { useNoticeSlot } from '../../components/notices';
import { intersects, type Align } from '../../components/position';
import { protectedRects } from '../../components/protect';
import { tokenPx } from '../../components/tokens';
import { useFloatingPosition } from '../../components/useFloatingPosition';
import { useT } from '../../i18n';
import { modifierLabel } from '../../lib/shortcuts';
import { useSettings } from '../../stores/settings';
import { resolveToolbarItem, type ResolvedAnchor } from '../tour/anchors';
import { clipOf, type Clip } from './clips';
import { isClipTip, toolbarItemsOf, type ClipTipId, type TipId } from './model';
import { useTips } from './store';

/** The canvas's scroller: the slot the tip stays inside (the coach mark's, DESIGN 3.47 "Slot and layer"). */
const CANVAS_SCROLLER = '[data-action-scope="canvas"] > [role="region"], [data-organize]';

/** The red redact band in the banner slot. */
const REDACT_BAND = '[data-banner="redact"]';

/** The banner row above the canvas: the anchored card sits below it, never over a banner (DESIGN 3.13 C2). */
const BANNER_SLOT = '[data-region="banner"]';

/** The form banner's "first field" link, and the Fill & Sign segment the form tip falls back to (DESIGN 3.13 C1). */
const FORM_LINK = '[data-banner="form"] button';
const FILL_SEGMENT = '[data-tour-anchor="mode-fill"]';

/** Popovers, menus and dialogs are portaled to the body; the tip goes when one opens after it. */
const OVERLAYS = '[role="menu"], [role="dialog"], [aria-modal="true"]';

/** How long the card waits for its clip to decode before it enters (DESIGN 3.13 C3 "Loading"). */
export const CLIP_DECODE_MS = 400;

/** The dock: bottom-end of the canvas, this far from its edges (DESIGN 3.6, 3.13 C2). */
const DOCK_INSET = 16;

/** The element to point at (the pressed tool of a family), else the ⋯ button when the row moved it into More. */
function resolveTipAnchor(id: TipId): ResolvedAnchor | null {
  // Redact mode has a red band under the toolbar: the tip sits below the band, never over its label.
  if (id === 'redact') {
    const band = document.querySelector<HTMLElement>(REDACT_BAND);
    if (band !== null) return { element: band, spec: { selector: REDACT_BAND, side: 'bottom', align: 'center' } };
  }
  // The form tip points at the banner's first-field link, else at the Fill & Sign segment.
  if (id === 'form') {
    const link = document.querySelector<HTMLElement>(FORM_LINK);
    if (link !== null) return { element: link, spec: { selector: FORM_LINK, side: 'bottom', align: 'start' } };
    const segment = document.querySelector<HTMLElement>(FILL_SEGMENT);
    return segment === null
      ? null
      : { element: segment, spec: { selector: FILL_SEGMENT, side: 'bottom', align: 'center' } };
  }
  const found = toolbarItemsOf(id)
    .map((item) => resolveToolbarItem(item))
    .filter((anchor): anchor is ResolvedAnchor => anchor !== null);
  const pressed = found.find((anchor) => anchor.element.getAttribute('aria-pressed') === 'true');
  return pressed ?? found[0] ?? resolveToolbarItem('overflow');
}

/** The anchor of the tip, looked up again after a resize or a banner change, since the toolbar may move it into More. */
function useAnchor(id: TipId): ResolvedAnchor | null {
  const [anchor, setAnchor] = useState<ResolvedAnchor | null>(null);
  useLayoutEffect(() => {
    const find = () =>
      setAnchor((previous) => {
        const next = resolveTipAnchor(id);
        return previous?.element === next?.element && previous?.spec.align === next?.spec.align ? previous : next;
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
    // The banner comes and goes in the document, the tool row's items inside the toolbar.
    const root = id === 'form' ? document.body : document.querySelector('[role="toolbar"]');
    if (root !== null) observer.observe(root, { childList: true, subtree: true });
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

/**
 * The placement candidates of DESIGN 3.13 C2, as stages: 0 clip card at the anchor, 1 clip card in the dock, 2 text-only card at
 * the anchor, 3 text-only card in the dock, 4 nothing fits (the card waits, hidden, until the window changes).
 */
const LAST_STAGE = 4;

/** Stage 1 and 3: bottom-end of the canvas, inset 16; collides with a protected rect → the next stage. */
function useDock(
  floatingRef: React.RefObject<HTMLElement | null>,
  active: boolean,
  next: () => void,
  stage: number,
): void {
  useLayoutEffect(() => {
    const floating = floatingRef.current;
    if (!active || floating === null) return;
    // A detached element stands for the anchor: the dock has none, so every visible input and button is protected.
    const none = document.createElement('div');
    const place = () => {
      const slot = document.querySelector<HTMLElement>(CANVAS_SCROLLER);
      const box = slot?.getBoundingClientRect() ?? {
        right: window.innerWidth,
        bottom: window.innerHeight,
        left: 0,
        top: 0,
      };
      const own = floating.getBoundingClientRect();
      const left = box.right - DOCK_INSET - own.width;
      const top = box.bottom - DOCK_INSET - own.height;
      const rect = { left, top, width: own.width, height: own.height };
      if (
        left < box.left ||
        top < box.top ||
        protectedRects('tip', none, floating).some((hit) => intersects(rect, hit))
      ) {
        next();
        return;
      }
      floating.style.left = `${left}px`;
      floating.style.top = `${top}px`;
      floating.dataset.side = 'dock';
    };
    place();
    window.addEventListener('resize', place);
    const slot = document.querySelector<HTMLElement>(CANVAS_SCROLLER);
    const observer = new ResizeObserver(place);
    if (slot !== null) observer.observe(slot);
    observer.observe(floating);
    return () => {
      window.removeEventListener('resize', place);
      observer.disconnect();
    };
  }, [floatingRef, active, next, stage]);
}

function Card({ id, anchor, clip }: { id: TipId; anchor: ResolvedAnchor; clip: Clip | null }) {
  const t = useT();
  const platform = useSettings((state) => state.platform);
  const positioner = useRef<HTMLDivElement>(null);
  const present = useIsPresent();
  const motionProps = usePopoverMotion();
  const reduce = useReducedMotion() === true;
  const textId = useId();
  const titleId = useId();
  const dismiss = useTips((state) => state.dismiss);
  const clipTip = isClipTip(id);
  const firstStage = clipTip && clip !== null ? 0 : 2;
  const [stage, setStage] = useState(firstStage);
  const next = useCallback(() => setStage((current) => Math.min(LAST_STAGE, current + 1)), []);
  const withClip = clipTip && clip !== null && stage < 2;
  const docked = stage === 1 || stage === 3;
  const hidden = stage === LAST_STAGE;
  const [started, setStarted] = useState(false);
  const [playKey, setPlayKey] = useState(0);
  const [animationFailed, setAnimationFailed] = useState(false);
  const [loaded, setLoaded] = useState(false);
  // Edit text's tip is catalogued with the tool's own keys (`editText.tip`).
  const mod = modifierLabel(platform, 'primary', t);
  const text = id === 'editText' ? t('editText.tip') : t(`tip.${id}`, { mod });
  const title = withClip ? t(`tip.${id as ClipTipId}.title`) : null;
  const anchorEl = anchor.element;

  // Nothing fits (stage 4): try again from the start when the window changes.
  useEffect(() => {
    if (!hidden) return;
    const retry = () => setStage(firstStage);
    window.addEventListener('resize', retry);
    const slot = document.querySelector<HTMLElement>(CANVAS_SCROLLER);
    const observer = new ResizeObserver(retry);
    if (slot !== null) observer.observe(slot);
    return () => {
      window.removeEventListener('resize', retry);
      observer.disconnect();
    };
  }, [hidden, firstStage]);

  // The card is at most as wide as the canvas minus 16 (C3).
  useLayoutEffect(() => {
    const floating = positioner.current;
    if (floating === null) return;
    const limit = () => {
      const slot = document.querySelector<HTMLElement>(CANVAS_SCROLLER);
      floating.style.maxWidth = slot === null ? '' : `${slot.clientWidth - tokenPx('--space-4', 16)}px`;
    };
    limit();
    window.addEventListener('resize', limit);
    return () => window.removeEventListener('resize', limit);
  }, []);

  useFloatingPosition({
    anchor: anchorEl,
    floatingRef: positioner,
    active: present && !docked && !hidden,
    side: 'bottom',
    align: anchor.spec.align as Align,
    kind: 'tip',
    clampTo: { selector: CANVAS_SCROLLER, inset: tokenPx('--space-2', 8) },
    clearOf: BANNER_SLOT,
    onNoFit: next,
  });
  useDock(positioner, present && docked, next, stage);

  // The anchor is described by the tip while it shows (DESIGN 3.47).
  useEffect(() => {
    anchorEl.setAttribute('aria-describedby', textId);
    return () => {
      if (anchorEl.getAttribute('aria-describedby') === textId) anchorEl.removeAttribute('aria-describedby');
    };
  }, [anchorEl, textId]);

  // Title and text go once to the status bar's polite live region, when the card is in sight.
  const announcement = title === null ? text : `${title}. ${text}`;
  useEffect(() => {
    if (!hidden) announce(t('tip.announce', { text: announcement }));
  }, [t, announcement, hidden]);

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

  const replay = () => {
    setAnimationFailed(false);
    setLoaded(false);
    setStarted(true);
    setPlayKey((key) => key + 1);
  };
  const poster = reduce || animationFailed;

  return (
    <div
      ref={positioner}
      className={`fixed start-0 top-0 z-popover flex flex-col ${present ? '' : 'pointer-events-none'} ${hidden ? 'invisible' : ''}`}
    >
      <motion.section
        {...motionProps}
        role="region"
        aria-label={withClip ? undefined : t('tip.region')}
        aria-labelledby={withClip ? titleId : undefined}
        data-surface="tip"
        data-tip-card=""
        data-tip-id={id}
        onKeyDown={onKeyDown}
        // The clip starts when the enter motion ends (C3 "Playing"); reduced motion shows the poster at once.
        onAnimationComplete={() => present && setStarted(true)}
        className={`bg-panel border border-border-subtle shadow-floating flex max-w-full rounded-panel p-3 text-md text-text ${
          withClip ? 'w-tip-card-clip flex-col' : 'w-(--note-width) items-center gap-2'
        }`}
      >
        {withClip && clip !== null ? (
          <>
            <div className="relative h-tip-clip-h w-tip-clip-w max-w-full shrink-0 overflow-hidden rounded-md border border-border-subtle bg-subtle">
              {(started || reduce) && (
                <img
                  key={`${playKey}-${poster ? 'poster' : 'clip'}`}
                  src={poster ? clip.poster : clip.src}
                  alt={t(`tip.${id as ClipTipId}.clip`)}
                  draggable={false}
                  onLoad={() => setLoaded(true)}
                  onError={() => (poster ? next() : setAnimationFailed(true))}
                  className={`size-full object-cover transition-opacity duration-fast ${loaded ? 'opacity-100' : 'opacity-0'}`}
                />
              )}
            </div>
            <div className="mt-2 flex h-[var(--control-sm)] items-center gap-2">
              <Icon icon={Lightbulb} size={16} className="text-text" />
              <span id={titleId} className="t-label min-w-0 flex-1 truncate font-medium text-text">
                {title}
              </span>
              <div className="flex items-center gap-1">
                {!reduce && <IconButton label={t('tip.replay')} icon={RotateCcw} size="sm" onClick={replay} />}
                <IconButton label={t('tip.dismiss')} icon={X} size="sm" onClick={dismiss} />
              </div>
            </div>
            <p id={textId} className="t-body mx-0 mb-0 mt-1 text-text">
              {text}
            </p>
          </>
        ) : (
          <>
            <Icon icon={Lightbulb} size={16} className="text-text" />
            <p id={textId} className="m-0 min-w-0 flex-1 text-md">
              {text}
            </p>
            <IconButton label={t('tip.dismiss')} icon={X} size="sm" onClick={dismiss} />
          </>
        )}
      </motion.section>
    </div>
  );
}

/** The tip (DESIGN 3.47, 3.13): one compact card under its anchor, never taking focus, with no timeout; the four clip tips carry a clip. */
export function Tip() {
  const id = useTips((state) => state.current);
  return <TipBody key={id ?? 'none'} id={id} />;
}

type Decode = 'pending' | 'ok' | 'failed';

/** Waits until the clip has decoded or 400 ms have passed (the card then enters and the image fades in when it arrives). */
function useClipReady(id: TipId | null, clip: Clip | null, reduce: boolean): Decode {
  const [state, setState] = useState<Decode>(id !== null && isClipTip(id) && clip !== null ? 'pending' : 'ok');
  useEffect(() => {
    if (id === null || !isClipTip(id) || clip === null) return;
    let live = true;
    const image = new Image();
    image.src = reduce ? clip.poster : clip.src;
    const timer = setTimeout(() => live && setState('ok'), CLIP_DECODE_MS);
    // Without `decode` (an old engine) the 400 ms are the wait; a failed decode makes the card text only.
    const decoded = typeof image.decode === 'function' ? image.decode() : Promise.resolve();
    decoded.then(
      () => live && setState('ok'),
      () => live && setState('failed'),
    );
    return () => {
      live = false;
      clearTimeout(timer);
    };
  }, [id, clip, reduce]);
  return state;
}

function TipBody({ id }: { id: TipId | null }) {
  const anchor = useAnchor(id ?? 'highlight');
  const reduce = useReducedMotion() === true;
  const clip = id !== null && isClipTip(id) ? clipOf(id) : null;
  const decode = useClipReady(id, clip, reduce);
  useDismissOnOverlay(id !== null);
  // One notice at a time (DESIGN 3.9 Q8): the tip waits in the queue behind a toast or the coach mark.
  const shown = useNoticeSlot('tip', 'tip', id !== null && anchor !== null && decode !== 'pending');
  return createPortal(
    <AnimatePresence>
      {shown && id !== null && anchor !== null && (
        <Card key={id} id={id} anchor={anchor} clip={decode === 'ok' ? clip : null} />
      )}
    </AnimatePresence>,
    document.body,
  );
}
