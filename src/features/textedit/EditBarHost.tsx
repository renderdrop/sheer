import { motion, useReducedMotion } from 'motion/react';
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';

import { DURATION, spring } from '../../lib/motion';
import { useMiniBarDock } from '../minibar/dock';
import { unionOf, type Box, type Placement } from '../minibar/placement';
import { obstaclesOf, placeEditBar } from './barPlacement';
import { loadLines, type Align } from './lines';
import { boxOf } from './model';
import type { TextLineInfo } from '../../api/textEdit';
import { focusEditBox, TextEditBar } from './TextEditBar';
import { useTextEdit } from './store';

const CANVAS = '[data-action-scope="canvas"] > [role="region"]';
const EDIT_BOX = '[data-action-scope="canvas"] [role="textbox"]';

const same = (a: Placement | null, b: Placement | null): boolean =>
  a === b ||
  (a !== null &&
    b !== null &&
    a.mode === b.mode &&
    (a.mode === 'dock' || (b.mode !== 'dock' && a.left === b.left && a.top === b.top)));

/**
 * Places the edit bar (DESIGN 3.3, 3.10 E3): above the edit box, else below, else docked, always clear of the box and the
 * paragraph rule (both are in client pixels in the store). Mounted by `MiniBarSlot` while a line is being edited.
 */
export function EditBarHost() {
  const reduce = useReducedMotion() === true;
  const anchor = useTextEdit((s) => s.anchor);
  const rule = useTextEdit((s) => s.rule);
  const wrapRef = useRef<HTMLDivElement>(null);
  const barRef = useRef<HTMLDivElement>(null);
  const [placement, setPlacement] = useState<Placement | null>(null);
  // The page's other lines, to put the bar where it covers the least text.
  const lineKey = useTextEdit((s) => (s.session === null ? null : `${s.session.docId}:${s.session.pageId}`));
  const [lines, setLines] = useState<readonly TextLineInfo[]>([]);
  useEffect(() => {
    const open = useTextEdit.getState().session;
    if (open === null) return;
    let current = true;
    void loadLines(open.docId, open.pageId).then((all) => {
      if (current) setLines(all);
    });
    return () => {
      current = false;
    };
  }, [lineKey]);
  const target = useMiniBarDock((s) => s.target);
  const setDocked = useMiniBarDock((s) => s.setDocked);

  const measure = useCallback(() => {
    const wrap = wrapRef.current;
    const bar = barRef.current;
    if (wrap === null || bar === null || anchor === null) {
      setPlacement((old) => (old === null ? old : null));
      return;
    }
    const wrapBox = wrap.getBoundingClientRect();
    const canvas = document.querySelector(CANVAS)?.getBoundingClientRect();
    const bounds: Box =
      canvas === undefined
        ? { left: wrapBox.left, top: wrapBox.top, right: wrapBox.right, bottom: wrapBox.bottom }
        : { left: canvas.left, top: canvas.top, right: canvas.right, bottom: canvas.bottom };
    const box = unionOf([boxOf(anchor), ...(rule === null ? [] : [boxOf(rule)])]);
    if (box === null) return;
    const size = bar.getBoundingClientRect();
    const open = useTextEdit.getState().session;
    const attr = document.querySelector(EDIT_BOX)?.getAttribute('data-align');
    const align: Align = attr === 'right' || attr === 'center' ? attr : 'left';
    const obstacles = open === null ? [] : obstaclesOf(lines, open.line, anchor, align);
    const next = placeEditBar(box, { width: size.width, height: size.height }, bounds, obstacles);
    const local: Placement =
      next.mode === 'dock' ? next : { mode: next.mode, left: next.left - wrapBox.left, top: next.top - wrapBox.top };
    setPlacement((old) => (same(old, local) ? old : local));
  }, [anchor, rule, lines]);

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
    if (barRef.current !== null) resize?.observe(barRef.current);
    return () => {
      cancelAnimationFrame(frame);
      document.removeEventListener('scroll', schedule, true);
      window.removeEventListener('resize', schedule);
      resize?.disconnect();
    };
  }, [measure]);

  const docked = placement?.mode === 'dock' && target !== null;
  useEffect(() => {
    setDocked(docked);
    return () => setDocked(false);
  }, [docked, setDocked]);

  // F6 from the edit box focuses the first control; Shift+F6 from the bar goes back (Esc is the bar's own).
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'F6' || event.defaultPrevented || event.isComposing) return;
      if (event.ctrlKey || event.metaKey || event.altKey) return;
      const bar = barRef.current;
      const active = document.activeElement;
      if (bar === null || active === null) return;
      if (bar.contains(active)) {
        if (!event.shiftKey) return;
        event.preventDefault();
        focusEditBox();
      } else if (!event.shiftKey && active.closest(EDIT_BOX) !== null) {
        const first = bar.querySelector<HTMLElement>('[data-mb-item]');
        if (first === null) return;
        event.preventDefault();
        first.focus();
      }
    };
    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, []);

  const floating = !(docked && target !== null);
  const visible = placement !== null;
  const style =
    floating && placement !== null && placement.mode !== 'dock'
      ? { left: placement.left, top: placement.top }
      : { left: 0, top: 0 };
  const rise = reduce ? 0 : 4;
  const bar = (
    <motion.div
      data-minibar-motion=""
      initial={{ opacity: 0, y: rise }}
      animate={visible ? { opacity: 1, y: 0 } : { opacity: 0, y: rise }}
      transition={spring(DURATION.fast)}
      inert={!visible}
      style={floating ? { position: 'absolute', ...style } : undefined}
      className={visible ? undefined : 'pointer-events-none'}
    >
      <TextEditBar ref={barRef} />
    </motion.div>
  );

  return floating ? (
    <div ref={wrapRef} data-minibar-layer="" className="pointer-events-none absolute inset-0 z-popover">
      {bar}
    </div>
  ) : (
    <>
      <div ref={wrapRef} className="pointer-events-none absolute inset-0" />
      {createPortal(bar, target)}
    </>
  );
}
