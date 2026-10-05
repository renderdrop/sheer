import { motion, useReducedMotion } from 'motion/react';
import { useCallback, useEffect, useId, useLayoutEffect, useRef, useState, type RefObject } from 'react';
import { createPortal } from 'react-dom';

import { cx } from '../../components/cx';
import { useUi } from '../../stores/ui';
import { useT } from '../../i18n';
import { DURATION, spring } from '../../lib/motion';
import { useMiniBarDock } from './dock';
import { MiniBar } from './MiniBar';
import { barKindOf, type MiniObject } from './model';
import { placeBar, unionOf, type Box, type Placement } from './placement';
import { useMiniSelection } from './useMiniSelection';

/** The bar rises this many px as it enters (DESIGN v2 3.3); reduced motion: opacity only. */
const RISE = 4;
/** The bar is back this long after the pointer is released (DESIGN v2 3.3), in ms. */
const RELEASE_DELAY_MS = 120;

const CANVAS = '[data-action-scope="canvas"] > [role="region"]';
const PRESSABLE = '[data-action-scope="canvas"]';

/** The elements that draw the selection on the canvas (the layers own them; the bar only reads them). */
function selectionElements(objects: readonly MiniObject[]): HTMLElement[] {
  const found: HTMLElement[] = [];
  for (const object of objects) {
    const selector =
      object.kind === 'textBox' || object.kind === 'image'
        ? `[data-insert-frame="${object.id}"]`
        : object.kind === 'redactMark'
          ? `[data-redact-mark="${object.id}"]`
          : `[data-annot-frame="${object.id}"]`;
    for (const element of document.querySelectorAll<HTMLElement>(selector)) found.push(element);
  }
  return found;
}

/** What takes focus for a selection element: the frame itself, or for a redaction mark the button around its boxes. */
const focusTargetOf = (element: HTMLElement): HTMLElement => element.closest<HTMLElement>('[role="button"]') ?? element;

const boxOf = (element: Element): Box | null => {
  const r = element.getBoundingClientRect();
  // An element that is not laid out (hidden, detached) has no box.
  return r.width === 0 && r.height === 0 && r.left === 0 && r.top === 0
    ? null
    : { left: r.left, top: r.top, right: r.right, bottom: r.bottom };
};

/** The box of the selection including its handles. */
function selectionBox(elements: readonly HTMLElement[]): Box | null {
  const boxes: Box[] = [];
  for (const element of elements) {
    const own = boxOf(element);
    if (own !== null) boxes.push(own);
    for (const handle of element.querySelectorAll('[data-annot-handle]')) {
      const box = boxOf(handle);
      if (box !== null) boxes.push(box);
    }
  }
  if (elements.some((element) => element.hasAttribute('data-redact-mark'))) {
    for (const handle of document.querySelectorAll('[data-redact-handle]')) {
      const box = boxOf(handle);
      if (box !== null) boxes.push(box);
    }
  }
  return unionOf(boxes);
}

/** True while the pointer is down on the canvas (a drag, a resize, a stroke) and for 120 ms after it is released. */
function usePressed(): boolean {
  const [pressed, setPressed] = useState(false);
  useEffect(() => {
    let timer: number | undefined;
    const down = (event: PointerEvent) => {
      const target = event.target;
      if (
        !(target instanceof Element) ||
        target.closest(PRESSABLE) === null ||
        target.closest('[data-minibar]') !== null
      ) {
        return;
      }
      window.clearTimeout(timer);
      setPressed(true);
    };
    const up = () => {
      window.clearTimeout(timer);
      timer = window.setTimeout(() => setPressed(false), RELEASE_DELAY_MS);
    };
    document.addEventListener('pointerdown', down, true);
    window.addEventListener('pointerup', up, true);
    window.addEventListener('pointercancel', up, true);
    return () => {
      window.clearTimeout(timer);
      document.removeEventListener('pointerdown', down, true);
      window.removeEventListener('pointerup', up, true);
      window.removeEventListener('pointercancel', up, true);
    };
  }, []);
  return pressed;
}

const OVERLAYS = '[role="menu"], [role="dialog"], [aria-modal="true"]';

/**
 * True while a popover, menu or dialog that the bar did not open is on screen (the crop popover, a tool's options, a dialog): no two
 * floating surfaces may overlap (DESIGN Q8/Q9), so the bar steps aside. What the bar's own controls opened (a colour popover, a
 * dropdown) is found through the trigger's `aria-controls` and keeps the bar. Overlays are direct children of the body.
 */
function useForeignOverlay(barRef: RefObject<HTMLElement | null>): boolean {
  const [foreign, setForeign] = useState(false);
  useEffect(() => {
    const update = () => {
      const bar = barRef.current;
      const open = Array.from(document.querySelectorAll<HTMLElement>(OVERLAYS)).filter(
        (overlay) =>
          !(bar?.contains(overlay) ?? false) &&
          (overlay.id === '' || bar?.querySelector(`[aria-controls="${CSS.escape(overlay.id)}"]`) === null),
      );
      setForeign(open.length > 0);
    };
    update();
    const observer = new MutationObserver(update);
    observer.observe(document.body, { childList: true });
    return () => observer.disconnect();
  }, [barRef]);
  return foreign;
}

const same = (a: Placement | null, b: Placement | null): boolean =>
  a === b ||
  (a !== null &&
    b !== null &&
    a.mode === b.mode &&
    (a.mode === 'dock' || (b.mode !== 'dock' && a.left === b.left && a.top === b.top)));

/** The bar of one selection. Remounted when the controls change, so that its size is measured again before it is placed. */
function MiniBarHost({ docId, objects }: { docId: number; objects: readonly MiniObject[] }) {
  const t = useT();
  const hintId = useId();
  const reduce = useReducedMotion() === true;
  const pressed = usePressed();
  const wrapRef = useRef<HTMLDivElement>(null);
  const barRef = useRef<HTMLDivElement>(null);
  const shown = useRef(false);
  const [placement, setPlacement] = useState<Placement | null>(null);
  const target = useMiniBarDock((s) => s.target);
  const setDocked = useMiniBarDock((s) => s.setDocked);

  const measure = useCallback(() => {
    const wrap = wrapRef.current;
    const bar = barRef.current;
    const elements = selectionElements(objects);
    // The selection says F6 reaches the bar (DESIGN v2 3.3).
    for (const element of elements) {
      const target = focusTargetOf(element);
      const ids = (target.getAttribute('aria-describedby') ?? '').split(/\s+/).filter((id) => id !== '');
      if (!ids.includes(hintId)) target.setAttribute('aria-describedby', [...ids, hintId].join(' '));
    }
    if (wrap === null || bar === null) return;
    const box = selectionBox(elements);
    const wrapBox = wrap.getBoundingClientRect();
    const canvas = document.querySelector(CANVAS);
    const bounds = (canvas === null ? null : boxOf(canvas)) ?? {
      left: wrapBox.left,
      top: wrapBox.top,
      right: wrapBox.right,
      bottom: wrapBox.bottom,
    };
    // Not on screen (scrolled away, or its page is not drawn): no bar.
    const visible =
      box !== null &&
      box.right > bounds.left &&
      box.left < bounds.right &&
      box.bottom > bounds.top &&
      box.top < bounds.bottom;
    if (!visible) {
      setPlacement((old) => (old === null ? old : null));
      return;
    }
    const size = bar.getBoundingClientRect();
    const next = placeBar(box, { width: size.width, height: size.height }, bounds);
    const local: Placement =
      next.mode === 'dock' ? next : { mode: next.mode, left: next.left - wrapBox.left, top: next.top - wrapBox.top };
    setPlacement((old) => (same(old, local) ? old : local));
  }, [objects, hintId]);

  // Placed before paint, then kept with the page: scroll and window resize, size changes of the canvas or the selection and
  // new or removed nodes in the canvas re-measure (coalesced to one read per frame, unanimated); a drag ends with the release.
  useLayoutEffect(() => {
    measure();
    let frame = 0;
    const schedule = () => {
      if (frame !== 0) return;
      frame = requestAnimationFrame(() => {
        frame = 0;
        measure();
      });
    };
    document.addEventListener('scroll', schedule, true);
    window.addEventListener('resize', schedule);
    const resize = typeof ResizeObserver === 'function' ? new ResizeObserver(schedule) : null;
    const mutation = typeof MutationObserver === 'function' ? new MutationObserver(schedule) : null;
    const canvas = document.querySelector(CANVAS);
    if (canvas !== null) {
      resize?.observe(canvas);
      mutation?.observe(canvas, { childList: true, subtree: true });
    }
    for (const element of selectionElements(objects)) resize?.observe(element);
    return () => {
      cancelAnimationFrame(frame);
      document.removeEventListener('scroll', schedule, true);
      window.removeEventListener('resize', schedule);
      resize?.disconnect();
      mutation?.disconnect();
      for (const element of selectionElements(objects)) {
        const el = focusTargetOf(element);
        const ids = (el.getAttribute('aria-describedby') ?? '').split(/\s+/).filter((id) => id !== '' && id !== hintId);
        if (ids.length === 0) el.removeAttribute('aria-describedby');
        else el.setAttribute('aria-describedby', ids.join(' '));
      }
    };
  }, [measure, objects, hintId]);

  // The bar comes back after a drag or resize: read the new position then.
  useEffect(() => {
    if (!pressed) measure();
  }, [pressed, measure]);

  const docked = placement?.mode === 'dock' && target !== null;
  useEffect(() => {
    setDocked(docked);
    return () => setDocked(false);
  }, [docked, setDocked]);

  const foreign = useForeignOverlay(barRef);
  const visible = placement !== null && !pressed && !foreign;
  useEffect(() => {
    shown.current = visible;
  }, [visible]);

  const returnToSelection = useCallback(() => {
    const [first] = selectionElements(objects);
    if (first !== undefined) focusTargetOf(first).focus();
  }, [objects]);

  // F6 from the selection focuses the first control; Shift+F6 from the bar goes back (Esc is the bar's own).
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'F6' || event.defaultPrevented || event.isComposing) return;
      if (event.ctrlKey || event.metaKey || event.altKey || !shown.current) return;
      const bar = barRef.current;
      const active = document.activeElement;
      if (bar === null || active === null) return;
      if (bar.contains(active)) {
        if (!event.shiftKey) return;
        event.preventDefault();
        returnToSelection();
      } else if (!event.shiftKey && selectionElements(objects).some((el) => focusTargetOf(el).contains(active))) {
        const first = bar.querySelector<HTMLElement>('[data-mb-item]');
        if (first === null) return;
        event.preventDefault();
        first.focus();
      }
    };
    // The document sees the key before the window, where the region cycling listens: it then skips a key that was taken.
    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, [objects, returnToSelection]);

  const floating = !(docked && target !== null);
  const style =
    floating && placement !== null
      ? placement.mode === 'dock'
        ? { left: 0, top: 0 }
        : { left: placement.left, top: placement.top }
      : { left: 0, top: 0 };
  const bar = (
    <motion.div
      data-minibar-motion=""
      initial={{ opacity: 0, y: reduce ? 0 : RISE }}
      animate={visible ? { opacity: 1, y: 0 } : { opacity: 0, y: reduce ? 0 : RISE }}
      transition={spring(DURATION.fast)}
      inert={!visible}
      style={floating ? { position: 'absolute', ...style } : undefined}
      className={cx(!visible && 'pointer-events-none')}
    >
      <MiniBar ref={barRef} docId={docId} objects={objects} onReturn={returnToSelection} />
    </motion.div>
  );

  return (
    <>
      <span id={hintId} className="sr-only">
        {t('minibar.hint')}
      </span>
      {floating ? (
        <div ref={wrapRef} data-minibar-layer="" className="pointer-events-none absolute inset-0 z-popover">
          {bar}
        </div>
      ) : (
        <>
          <div ref={wrapRef} className="pointer-events-none absolute inset-0" />
          {createPortal(bar, target)}
        </>
      )}
    </>
  );
}

/**
 * The properties mini bar (DESIGN v2 3.3, ADR-102): floats above the selection inside the canvas column (an overlay of it, the
 * parent must be positioned), or docks in the banner slot's second row. It shows only while canvas objects are selected.
 */
export function MiniBarSlot() {
  const { docId, objects } = useMiniSelection();
  const mode = useUi((s) => s.mode);
  // Seiten has no canvas selection (leaving it clears it); a stale one shows no bar.
  if (docId === null || objects.length === 0 || mode === 'pages') return null;
  const signature = objects.map((object) => barKindOf(object)).join();
  return <MiniBarHost key={`${docId}:${signature}:${objects.length}`} docId={docId} objects={objects} />;
}
