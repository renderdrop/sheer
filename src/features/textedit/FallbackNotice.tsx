import { AnimatePresence, motion, useIsPresent } from 'motion/react';
import { Info, X } from 'lucide-react';
import { useEffect, useId, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';

import { Icon, IconButton } from '../../components';
import { usePopoverMotion } from '../../components/motion';
import { useNoticeSlot } from '../../components/notices';
import { tokenPx } from '../../components/tokens';
import { useFloatingPosition } from '../../components/useFloatingPosition';
import { useT } from '../../i18n';
import { FACE_NAME, listChars } from './model';
import { useTextEdit, type FallbackNotice as NoticeState } from './store';

const CANVAS_SCROLLER = '[data-action-scope="canvas"] > [role="region"]';
const FONT_BUTTON = '[data-surface="textedit-bar"] [data-textedit-font]';

/** The Font button of the edit bar, found again when the bar mounts or moves (it may dock). */
function useFontButton(active: boolean): HTMLElement | null {
  const [button, setButton] = useState<HTMLElement | null>(null);
  useLayoutEffect(() => {
    if (!active) return;
    let frame = 0;
    const find = () => {
      const next = document.querySelector<HTMLElement>(FONT_BUTTON);
      setButton((old) => (old === next ? old : next));
    };
    find();
    const observer = new MutationObserver(() => {
      if (frame === 0) {
        frame = requestAnimationFrame(() => {
          frame = 0;
          find();
        });
      }
    });
    observer.observe(document.body, { childList: true, subtree: true });
    return () => {
      cancelAnimationFrame(frame);
      observer.disconnect();
    };
  }, [active]);
  return active ? button : null;
}

/** An invisible marker over a rect the notice must not cover (the edit box, the paragraph rule): `data-protect="notice"`. */
function Guard({ rect }: { rect: { x: number; y: number; w: number; h: number } | null }) {
  if (rect === null) return null;
  return (
    <div
      aria-hidden="true"
      data-protect="notice"
      className="pointer-events-none fixed"
      style={{ left: rect.x, top: rect.y, width: rect.w, height: rect.h }}
    />
  );
}

function Card({ notice, button }: { notice: NoticeState; button: HTMLElement }) {
  const t = useT();
  const positioner = useRef<HTMLDivElement>(null);
  const present = useIsPresent();
  const motionProps = usePopoverMotion();
  const textId = useId();
  const text =
    notice.kind === 'notEmbedded'
      ? t('editText.notice.notEmbedded', { font: FACE_NAME[notice.face] })
      : t('editText.notice.missingGlyphs', { chars: listChars(notice.chars), font: FACE_NAME[notice.face] });

  useFloatingPosition({
    anchor: button,
    floatingRef: positioner,
    active: present,
    side: 'bottom',
    align: 'start',
    kind: 'tip',
    clampTo: { selector: CANVAS_SCROLLER, inset: tokenPx('--space-2', 8) },
  });

  // The button is described by the notice while it shows.
  useEffect(() => {
    button.setAttribute('aria-describedby', textId);
    return () => {
      if (button.getAttribute('aria-describedby') === textId) button.removeAttribute('aria-describedby');
    };
  }, [button, textId]);

  const hide = () => useTextEdit.getState().set({ notice: null });

  return (
    <div
      ref={positioner}
      className={`fixed start-0 top-0 z-popover flex flex-col ${present ? '' : 'pointer-events-none'}`}
    >
      <motion.section
        {...motionProps}
        role="region"
        aria-label={t('tip.region')}
        data-surface="textedit-notice"
        onKeyDown={(event) => {
          if (event.key !== 'Escape') return;
          event.preventDefault();
          event.stopPropagation();
          hide();
          button.focus({ preventScroll: true });
        }}
        className="bg-panel border border-border-subtle shadow-floating flex w-(--note-width) max-w-full items-center gap-2 rounded-panel p-3 text-md text-text"
      >
        <Icon icon={Info} size={16} className="text-text" />
        <p id={textId} className="m-0 min-w-0 flex-1 text-md">
          {text}
        </p>
        <IconButton label={t('tip.dismiss')} icon={X} size="sm" onClick={hide} />
      </motion.section>
    </div>
  );
}

/**
 * The one info notice of a line edit on a substitute font (DESIGN 3.10 E4, notice queue 3.9 Q8 priority 3). Anchored to the bar's
 * Font button; the edit box, the paragraph rule and the whole bar are protected, so it waits (hidden) until it fits. It ends with
 * Hide, Esc, commit or cancel (the edit layer clears `notice`). Mounted once, with the tips.
 */
export function FallbackNotice() {
  const notice = useTextEdit((s) => s.notice);
  const anchor = useTextEdit((s) => s.anchor);
  const rule = useTextEdit((s) => s.rule);
  const session = useTextEdit((s) => s.session !== null);
  const button = useFontButton(notice !== null && session);
  const shown = useNoticeSlot('textedit-notice', 'info', notice !== null && session && button !== null);
  return createPortal(
    <>
      {shown && <Guard rect={anchor} />}
      {shown && <Guard rect={rule} />}
      <AnimatePresence>
        {shown && notice !== null && button !== null && <Card key={notice.kind} notice={notice} button={button} />}
      </AnimatePresence>
    </>,
    document.body,
  );
}
