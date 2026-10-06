import { Check, RotateCcw, TriangleAlert, X } from 'lucide-react';
import { type KeyboardEvent, type Ref, useId, useLayoutEffect, useRef } from 'react';

import { Icon, IconButton, Toggle } from '../../components';
import { isOwnEvent, itemsOf, rovingTarget } from '../../components/roving';
import { formatNumber, useLocale, useT } from '../../i18n';
import { Divider } from '../minibar/Controls';
import { cancelEdit, commitEdit, retryEdit } from './actions';
import { FontPopover } from './FontPopover';
import { paragraphOf, useLines } from './lines';
import { setReflow, useTextEdit } from './store';

const ITEMS = '[data-mb-item]';
const SQUARE = 'size-8!';
/** Where Esc in the bar returns to: the edit box. */
const EDIT_BOX = '[data-action-scope="canvas"] [role="textbox"]';

/** Moves focus into the edit box (Esc in the bar, DESIGN 3.10 E7). */
export function focusEditBox(): void {
  document.querySelector<HTMLElement>(EDIT_BOX)?.focus();
}

/**
 * The mini bar while a line is edited (DESIGN 3.10 E3, E6): Font, the size read-out, the Umbrechen toggle (paragraphs of 2+ lines), the overflow caption, the busy and error captions
 * with Retry, Cancel and Commit. A `toolbar` with one tab stop like the properties bar. Placement belongs to `EditBarHost`.
 */
export function TextEditBar({ ref }: { ref?: Ref<HTMLDivElement> }) {
  const t = useT();
  const locale = useLocale();
  const session = useTextEdit((s) => s.session);
  const reflow = useTextEdit((s) => s.reflow);
  const labelId = useId();
  const lines = useLines(session?.docId ?? 0, session?.pageId ?? 0, session !== null);
  const own = useRef<HTMLDivElement | null>(null);
  const stop = useRef<HTMLElement | null>(null);

  // One tab stop: the control focus was last on, else the first.
  useLayoutEffect(() => {
    const root = own.current;
    if (root === null) return;
    const items = itemsOf(root, ITEMS);
    const active = stop.current !== null && items.includes(stop.current) ? stop.current : items[0];
    for (const item of items) item.tabIndex = item === active ? 0 : -1;
  });

  if (session === null) return null;
  const { status, overflowPt, line } = session;
  const busy = status === 'busy';
  const failed = status === 'error';
  // Umbrechen only makes sense for a paragraph of two or more lines.
  const multi = lines !== null && paragraphOf(lines, line).length >= 2;
  const showOverflow = overflowPt > 0 && !busy && !failed;
  const size = Math.round(line.font.size * 10) / 10;

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    const root = event.currentTarget;
    // The Font popover's events bubble through the React tree: they are the popover's.
    if (!isOwnEvent(root, event) || event.defaultPrevented) return;
    if (event.key === 'Escape') {
      event.preventDefault();
      event.stopPropagation();
      focusEditBox();
      return;
    }
    if (event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return;
    const items = itemsOf(root, ITEMS);
    const current = items.findIndex((item) => item.contains(event.target as Node));
    const target = rovingTarget(event.key, current, items.length, { orientation: 'horizontal', wrap: false });
    if (target === null) return;
    event.preventDefault();
    items[target]?.focus();
  };

  return (
    <div
      ref={(node) => {
        own.current = node;
        if (typeof ref === 'function') ref(node);
        else if (ref !== undefined && ref !== null) ref.current = node;
      }}
      role="toolbar"
      aria-orientation="horizontal"
      aria-label={t('editText.tool')}
      aria-busy={busy || undefined}
      data-minibar=""
      data-surface="textedit-bar"
      data-protect="notice"
      onKeyDown={onKeyDown}
      onFocus={(event) => {
        const item = event.target instanceof Element ? event.target.closest<HTMLElement>(ITEMS) : null;
        if (item !== null) stop.current = item;
      }}
      className="pointer-events-auto flex h-control-lg max-w-[calc(100vw-var(--space-4))] items-center gap-1 rounded-md border border-border-subtle bg-surface p-1 shadow-floating"
    >
      <FontPopover />
      <span className="t-caption px-1 tabular-nums text-text-muted">
        {t('minibar.fontSizeValue', { n: formatNumber(size, locale) })}
      </span>
      {multi && (
        <>
          <Divider />
          <div role="group" aria-labelledby={labelId} className="flex shrink-0 items-center gap-2 px-1">
            <span id={labelId} className="t-label whitespace-nowrap text-text">
              {t('editText.reflow')}
            </span>
            <Toggle data-mb-item="" checked={reflow} onCheckedChange={setReflow} aria-labelledby={labelId} />
          </div>
        </>
      )}
      {showOverflow && (
        <>
          <Divider />
          <span className="t-caption flex items-center gap-1 px-1 tabular-nums text-danger">
            <Icon icon={TriangleAlert} size={16} />
            {t('editText.overflow', { n: formatNumber(Math.ceil(overflowPt), locale) })}
          </span>
        </>
      )}
      {session.previewRefused === true && !busy && !failed && (
        <>
          <Divider />
          <span role="status" className="t-caption px-1 text-text-muted">
            {t('editText.previewRefused')}
          </span>
        </>
      )}
      {busy && (
        <>
          <Divider />
          <span role="status" className="t-caption px-1 text-text-muted">
            {t('editText.busy')}
          </span>
        </>
      )}
      {failed && (
        <>
          <Divider />
          <span role="alert" className="t-caption flex items-center gap-1 px-1 text-danger">
            <Icon icon={TriangleAlert} size={16} />
            {t('editText.error')}
          </span>
          <IconButton
            data-mb-item=""
            icon={RotateCcw}
            label={t('save.retry')}
            onClick={() => void retryEdit()}
            className={SQUARE}
          />
        </>
      )}
      {/* DESIGN E3: the overflow caption sits right before Cancel, no divider between. */}
      {!showOverflow && <Divider />}
      <IconButton data-mb-item="" icon={X} label={t('editText.cancel')} onClick={cancelEdit} className={SQUARE} />
      <IconButton
        data-mb-item=""
        icon={Check}
        label={t('editText.commit')}
        disabled={busy}
        focusableWhenDisabled
        onClick={() => void commitEdit()}
        className={SQUARE}
      />
    </div>
  );
}
