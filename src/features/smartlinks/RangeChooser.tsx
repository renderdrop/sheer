import { motion, useIsPresent, useReducedMotion } from 'motion/react';
import { Wand } from 'lucide-react';
import {
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
  type KeyboardEvent,
  type ReactNode,
} from 'react';
import { createPortal } from 'react-dom';

import { Icon } from '../../components';
import { DISMISS_PRIORITY, registerDismissLayer } from '../../components/dismiss';
import { useFloatingPosition } from '../../components/useFloatingPosition';
import { useT } from '../../i18n';
import { TWEEN } from '../../lib/motion';
import { Modal } from '../jobs/Modal';
import { fitOneLine } from './fit';
import { isDigit, moveCurrent, rowForDigits, TYPE_MS } from './rangeNav';

/**
 * The range chooser (DESIGN 3.11 L14): a popover next to a range run ("[3-5]") with one row per resolved number: the number, the entry
 * fitted to one line by measurement, the target page. Down/Up, Home/End, PageDown/PageUp, typed digits, Enter chooses, Esc and Tab
 * close. Light only, no glass. With no placement that fits it becomes a dialog titled `smartlinks.range.title` (Q7).
 */
export interface ChooserRow {
  number: number;
  /** The entry, cut by Rust to 120 characters. */
  preview: string;
  /** The target page as shown ("p. 12"), with the file's page in parentheses when it differs. */
  page: string;
  /** The accessible name of the option (`smartlinks.aria.rangeEntry`). */
  name: string;
}

/** Why the chooser closed: decides where focus goes (the run, except after a click outside or a choice). */
export type ChooserClose = 'escape' | 'tab' | 'outside' | 'other';

export interface RangeChooserProps {
  /** The range run the chooser hangs off. */
  anchor: HTMLElement;
  /** The printed range ("3-5"), for the title and the list's name. */
  range: string;
  rows: readonly ChooserRow[];
  onChoose: (number: number) => void;
  onClose: (reason: ChooserClose) => void;
}

/** The list's rows shown at most before it scrolls. */
const VISIBLE_ROWS = 12;

/**
 * One line of text fitted by measurement. The text is set on the element itself, so React never owns its children. Re-measured when the
 * text or the language changes and when fonts finish loading.
 */
function OneLine({ text }: { text: string }) {
  const t = useT();
  const ref = useRef<HTMLSpanElement>(null);
  const [fontTick, setFontTick] = useState(0);
  useEffect(() => {
    const fonts = typeof document === 'undefined' ? undefined : document.fonts;
    if (fonts === undefined) return;
    const bump = () => setFontTick((tick) => tick + 1);
    void fonts.ready.then(bump);
    fonts.addEventListener('loadingdone', bump);
    return () => fonts.removeEventListener('loadingdone', bump);
  }, []);
  useLayoutEffect(() => {
    const el = ref.current;
    if (el === null) return;
    el.textContent = fitOneLine(text, (candidate) => {
      el.textContent = candidate;
      return el.scrollWidth <= el.clientWidth;
    });
  }, [text, t, fontTick]);
  return (
    <span
      ref={ref}
      aria-hidden="true"
      className="t-body block min-w-0 flex-1 overflow-hidden whitespace-nowrap text-text"
    />
  );
}

function ChooserList({
  id,
  range,
  rows,
  onChoose,
  onClose,
}: Pick<RangeChooserProps, 'range' | 'rows' | 'onChoose' | 'onClose'> & { id: string }) {
  const t = useT();
  const list = useRef<HTMLDivElement>(null);
  const [current, setCurrent] = useState(0);
  const typed = useRef<{ text: string; at: number }>({ text: '', at: 0 });
  const optionId = (number: number) => `${id}-o${number}`;

  useLayoutEffect(() => {
    list.current?.focus({ preventScroll: true });
  }, []);
  useLayoutEffect(() => {
    const row = rows[current];
    if (row !== undefined) document.getElementById(optionId(row.number))?.scrollIntoView?.({ block: 'nearest' });
    // eslint-disable-next-line react-hooks/exhaustive-deps -- optionId is a pure function of id
  }, [current, rows, id]);

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.altKey || event.ctrlKey || event.metaKey) return;
    if (event.key === 'Tab') {
      event.preventDefault();
      event.stopPropagation();
      onClose('tab');
      return;
    }
    if (event.key === 'Enter') {
      event.preventDefault();
      event.stopPropagation();
      const row = rows[current];
      if (row !== undefined) onChoose(row.number);
      return;
    }
    const to = moveCurrent(event.key, current, rows.length);
    if (to !== null) {
      event.preventDefault();
      event.stopPropagation();
      setCurrent(to);
      return;
    }
    if (isDigit(event.key)) {
      event.preventDefault();
      event.stopPropagation();
      const now = Date.now();
      const numbers = rows.map((row) => row.number);
      const before = now - typed.current.at > TYPE_MS ? '' : typed.current.text;
      let text = before + event.key;
      let at = rowForDigits(text, numbers);
      if (at === null) {
        text = event.key;
        at = rowForDigits(text, numbers);
      }
      typed.current = { text, at: now };
      if (at !== null) setCurrent(at);
    }
  };

  return (
    <div
      ref={list}
      role="listbox"
      tabIndex={-1}
      aria-label={t('smartlinks.aria.rangeList', { range })}
      aria-activedescendant={rows[current] === undefined ? undefined : optionId(rows[current].number)}
      onKeyDown={onKeyDown}
      className="flex flex-col overflow-y-auto outline-none"
      style={{ maxHeight: `calc(${VISIBLE_ROWS} * var(--space-8))` }}
    >
      {rows.map((row, index) => (
        <div
          key={row.number}
          id={optionId(row.number)}
          role="option"
          aria-selected={index === current}
          aria-label={row.name}
          aria-describedby={`${optionId(row.number)}-d`}
          data-range-row=""
          data-current={index === current ? '' : undefined}
          onClick={() => onChoose(row.number)}
          className="flex h-8 shrink-0 cursor-default items-center gap-2 rounded-sm px-2 text-text transition-colors duration-fast hover:bg-subtle active:bg-pressed data-[current]:bg-subtle"
        >
          <span aria-hidden="true" className="t-label w-8 shrink-0 text-end tabular-nums text-text">
            {row.number}
          </span>
          <OneLine text={row.preview} />
          <span aria-hidden="true" className="t-caption shrink-0 text-end tabular-nums text-text-muted">
            {row.page}
          </span>
          <span id={`${optionId(row.number)}-d`} className="sr-only">
            {row.preview}
          </span>
        </div>
      ))}
    </div>
  );
}

function Header({ count }: { count: number }) {
  const t = useT();
  return (
    <div className="flex h-control-sm shrink-0 items-center gap-1 px-2 text-text-muted">
      <Icon icon={Wand} size={16} />
      <span className="t-caption">
        {t('smartlinks.detected')} · {t('smartlinks.range.count', { n: count })}
      </span>
    </div>
  );
}

function FloatingSurface({
  anchor,
  range,
  rows,
  onChoose,
  onClose,
  onNoFit,
}: RangeChooserProps & { onNoFit?: () => void }) {
  const id = useId();
  const present = useIsPresent();
  const reduce = useReducedMotion() === true;
  const positioner = useRef<HTMLDivElement>(null);
  const surface = useRef<HTMLDivElement>(null);
  // Enters from the anchor's side by 4 px: an anchor in the lower half has the card above it (it settles from below), else below it.
  const [from] = useState(() => (anchor.getBoundingClientRect().bottom > window.innerHeight / 2 ? 1 : -1));
  useFloatingPosition({
    anchor,
    floatingRef: positioner,
    active: present,
    side: 'bottom',
    align: 'start',
    kind: 'popover',
    onNoFit,
  });

  const close = useRef(onClose);
  useEffect(() => {
    close.current = onClose;
  });
  useEffect(() => {
    if (!present) return;
    return registerDismissLayer(DISMISS_PRIORITY.popover, () => close.current('escape'));
  }, [present]);
  useEffect(() => {
    if (!present) return;
    const onPointerDown = (event: PointerEvent) => {
      const target = event.target;
      if (!(target instanceof Node) || surface.current?.contains(target)) return;
      // A press on the run itself is the run's own toggle.
      const box = anchor.getBoundingClientRect();
      const inside =
        event.clientX >= box.left &&
        event.clientX <= box.right &&
        event.clientY >= box.top &&
        event.clientY <= box.bottom;
      if (!inside) close.current('outside');
    };
    // Scrolling the page (not the list), a resize of the canvas or a zoom moves the run: the chooser closes (L14).
    const onScroll = (event: Event) => {
      if (event.target instanceof Node && surface.current?.contains(event.target)) return;
      close.current('other');
    };
    document.addEventListener('pointerdown', onPointerDown, true);
    document.addEventListener('scroll', onScroll, { capture: true, passive: true });
    return () => {
      document.removeEventListener('pointerdown', onPointerDown, true);
      document.removeEventListener('scroll', onScroll, { capture: true });
    };
  }, [present, anchor]);

  const dy = reduce ? 0 : 4 * from;
  return (
    <div
      ref={positioner}
      data-surface="range-chooser"
      className={`fixed start-0 top-0 z-popover flex flex-col ${present ? '' : 'pointer-events-none'}`}
    >
      <motion.div
        ref={surface}
        initial={{ opacity: 0, y: dy }}
        animate={{ opacity: 1, y: 0, transition: TWEEN.fast }}
        exit={{ opacity: 0, transition: TWEEN.fast }}
        className="flex w-link-preview-max flex-col rounded-md border border-border-subtle bg-panel p-2 text-text shadow-floating"
      >
        <Header count={rows.length} />
        <ChooserList id={id} range={range} rows={rows} onChoose={onChoose} onClose={onClose} />
      </motion.div>
    </div>
  );
}

function AsDialog({ range, rows, onChoose, onClose }: RangeChooserProps): ReactNode {
  const t = useT();
  const id = useId();
  const titleId = useId();
  return (
    <Modal labelledBy={titleId} width="w-dialog-md" onClose={() => onClose('escape')}>
      <h2 id={titleId} className="t-h3 m-0 mb-4">
        {t('smartlinks.range.title', { range })}
      </h2>
      <Header count={rows.length} />
      <ChooserList id={id} range={range} rows={rows} onChoose={onChoose} onClose={onClose} />
    </Modal>
  );
}

/** The chooser of a range run. Render it inside an `AnimatePresence`; it unmounts to close. */
export function RangeChooser(props: RangeChooserProps) {
  const [asDialog, setAsDialog] = useState(false);
  const noFit = useCallback(() => setAsDialog(true), []);
  if (asDialog) return <AsDialog {...props} />;
  return createPortal(<FloatingSurface {...props} onNoFit={noFit} />, document.body);
}
