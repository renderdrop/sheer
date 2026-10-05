import { Check, Lock, TriangleAlert } from 'lucide-react';
import { motion, useReducedMotion } from 'motion/react';
import { useEffect, useState } from 'react';

import { runAction } from '../../actions/dispatch';
import { currentPlatform } from '../../actions/keys';
import { shortcutFor } from '../../actions/registry';
import { Icon, Tooltip } from '../../components';
import { SPRING } from '../../components/motion';
import { EASE_OUT } from '../../lib/motion';
import { cx } from '../../components/cx';
import { errorText, useT } from '../../i18n';
import { selectActiveId, useDocuments } from '../../stores/documents';
import { useSettings } from '../../stores/settings';
import { useSignatureLock } from '../lock/useSignatureLock';
import { useSave } from '../save/state';
import { useActiveEdited } from './useEdited';

/** "Saving…" shows only when a save takes longer than this (`--saving-delay`, MOTION spell 6). */
export const SAVING_DELAY_MS = 200;

/** `--motion-check` (a test keeps them equal): the check draws in 240 ms, the one duration above 180 (MOTION spell 6). */
export const CHECK_DRAW_S = 0.24;

/** `true` once `on` has been true for `delay` ms; false at once when it ends. */
function useAfter(on: boolean, delay: number): boolean {
  const [late, setLate] = useState(false);
  useEffect(() => {
    if (!on) return;
    const timer = window.setTimeout(() => setLate(true), delay);
    return () => {
      window.clearTimeout(timer);
      setLate(false);
    };
  }, [on, delay]);
  return on && late;
}

/**
 * The Saved glyph (MOTION spell 6): the Ink dot that was there fades out (fast) on the check's spot while the Lucide check draws
 * itself by `stroke-dashoffset` (`pathLength`). Under reduced motion the check fades in and the dot fades out, both fast.
 */
function DrawnCheck({ fromDot }: { fromDot: boolean }) {
  const reduce = useReducedMotion() === true;
  const check = (
    <motion.svg
      aria-hidden="true"
      focusable="false"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={2}
      strokeLinecap="round"
      strokeLinejoin="round"
      data-drawn-check=""
      className="size-4 shrink-0"
      {...(reduce ? { initial: { opacity: 0 }, animate: { opacity: 1 } } : {})}
    >
      <motion.path
        d="M20 6 9 17l-5-5"
        {...(reduce
          ? {}
          : {
              initial: { pathLength: 0 },
              animate: { pathLength: 1 },
              transition: { duration: CHECK_DRAW_S, ease: EASE_OUT },
            })}
      />
    </motion.svg>
  );
  if (!fromDot) return check;
  return (
    <span className="relative inline-flex shrink-0">
      {check}
      <motion.span
        aria-hidden="true"
        data-dot-out=""
        initial={{ opacity: 1 }}
        animate={{ opacity: 0, transition: SPRING.fast }}
        className="absolute inset-0 m-auto size-[calc(var(--space-1)+var(--space-1)/2)] rounded-pill bg-text"
      />
    </span>
  );
}

type Status = 'signed' | 'saved' | 'edited' | 'new' | 'saving' | 'failed';

/**
 * The save status next to the file name (DESIGN 3.5 B1): a Ghost button 28 high. Saved (check, inactive), Edited (Ink dot, click
 * saves), Not saved yet (a document without a file: click is Save As), Saving… (after 200 ms), Not saved (failed, click retries,
 * the tooltip says why). Below 1100 px of window width the label hides and only the glyph stays; the text stays for assistive technology.
 */
export function SaveStatus() {
  const t = useT();
  const platform = useSettings((state) => state.platform) ?? currentPlatform();
  const docId = useDocuments(selectActiveId);
  const edited = useActiveEdited();
  const fresh = useDocuments((state) => docId !== null && state.byId[docId]?.kind === 'recovered');
  const saving = useSave((state) => docId !== null && state.saving[docId] === true);
  const failed = useSave((state) => (docId === null ? null : (state.failed[docId] ?? null)));
  const justSaved = useSave((state) => docId !== null && state.saved === docId);
  const showSaving = useAfter(saving, SAVING_DELAY_MS);
  const locked = useSignatureLock(docId ?? undefined).locked;
  if (docId === null) return null;

  const status: Status = locked
    ? 'signed'
    : saving
      ? 'saving'
      : failed !== null
        ? 'failed'
        : fresh
          ? 'new'
          : edited
            ? 'edited'
            : 'saved';
  const inert = status === 'saved' || status === 'saving' || status === 'signed';
  const shortcut = shortcutFor('save', platform, t);
  // While a quick save runs the previous state stays on screen: Saving… appears only after the delay.
  const shown: Status = status === 'saving' && !showSaving ? (fresh ? 'new' : 'edited') : status;
  const shownLabel = t(`save.status.${shown}`);
  const tip =
    status === 'failed' && failed !== null
      ? { label: errorText(t, failed), note: t('save.retry'), shortcut: shortcut?.label }
      : status === 'signed'
        ? { label: t('cert.locked.tool') }
        : status === 'edited' || status === 'new'
          ? { label: t('save.save'), shortcut: shortcut?.label }
          : null;

  const button = (
    <button
      type="button"
      data-save-status={shown}
      aria-label={shownLabel}
      aria-disabled={inert ? true : undefined}
      aria-keyshortcuts={shortcut?.aria}
      onClick={() => {
        if (!inert) void runAction('save');
      }}
      className={cx(
        't-caption inline-flex h-save-status shrink-0 items-center gap-1 rounded-sm px-2 transition-colors duration-fast',
        shown === 'failed'
          ? 'text-error-text'
          : shown === 'saved' || shown === 'saving' || shown === 'signed'
            ? 'text-text-muted'
            : 'text-text',
        inert ? 'cursor-default' : 'cursor-pointer hover:bg-subtle active:bg-pressed',
      )}
    >
      {shown === 'saved' &&
        (justSaved ? <DrawnCheck key="drawn" fromDot /> : <Icon icon={Check} size={16} className="text-text-muted" />)}
      {shown === 'signed' && <Icon icon={Lock} size={16} className="text-text-muted" />}
      {shown === 'failed' && <Icon icon={TriangleAlert} size={16} />}
      {(shown === 'edited' || shown === 'new') && (
        <span
          aria-hidden="true"
          data-edited=""
          className="size-[calc(var(--space-1)+var(--space-1)/2)] shrink-0 rounded-pill bg-text"
        />
      )}
      {shown === 'saved' && justSaved ? (
        <motion.span
          key="saved-text"
          aria-hidden="true"
          data-saved-text=""
          initial={{ opacity: 0 }}
          animate={{ opacity: 1, transition: SPRING.fast }}
          className="max-save-label:sr-only"
        >
          {shownLabel}
        </motion.span>
      ) : (
        <span aria-hidden="true" className="max-save-label:sr-only">
          {shownLabel}
        </span>
      )}
    </button>
  );
  return (
    <span className="ms-1 flex shrink-0 items-center">
      <span role="status" className="sr-only">
        {shownLabel}
      </span>
      {tip === null ? button : <Tooltip {...tip}>{button}</Tooltip>}
    </span>
  );
}
