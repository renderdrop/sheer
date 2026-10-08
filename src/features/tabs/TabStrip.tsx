import { ChevronLeft, ChevronRight, X } from 'lucide-react';
import { useReducedMotion } from 'motion/react';
import {
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type KeyboardEvent,
  type MouseEvent,
  type RefObject,
} from 'react';

import { isModalOpen } from '../../actions/dispatch';
import { IconButton, Tooltip } from '../../components';
import { cx } from '../../components/cx';
import { isOwnEvent, itemsOf, rovingTarget } from '../../components/roving';
import { useT } from '../../i18n';
import { isDirty, useAnnotations } from '../../stores/annotations';
import { useDocuments } from '../../stores/documents';
import { useOcr } from '../ocr/store';
import { closeTab, cycleTab } from './nav';

/** Names longer than this are cut in the middle, so both the start and the extension stay readable. */
export const MAX_TAB_CHARS = 28;
/** A name is never cut below this many characters (counting the ellipsis): no unreadable stubs. */
export const MIN_TAB_CHARS = 8;
/** From this many open documents the strip scrolls and shows its arrows (DESIGN 3.18 E3). */
export const SCROLL_FROM = 6;
/** The tabs that share the strip's width before it scrolls: width = available / min(n, 5). */
const TABS_VISIBLE = 5;

/** `name` shortened in the middle to at most `max` characters (counting the ellipsis). */
export function middleTruncate(name: string, requested = MAX_TAB_CHARS): string {
  const max = Math.max(MIN_TAB_CHARS, requested);
  const chars = Array.from(name);
  if (chars.length <= max) return name;
  const keep = max - 1;
  const tail = Math.floor(keep / 2);
  const head = keep - tail;
  return `${chars.slice(0, head).join('')}…${chars.slice(chars.length - tail).join('')}`;
}

/** Ctrl+Tab and Ctrl+Shift+Tab cycle the tabs on both platforms (Cmd+Tab belongs to the macOS app switcher). */
function useTabCycleKeys(): void {
  useEffect(() => {
    const onKeyDown = (event: globalThis.KeyboardEvent) => {
      if (event.key !== 'Tab' || !event.ctrlKey || event.metaKey || event.altKey || event.defaultPrevented) return;
      if (isModalOpen()) return;
      event.preventDefault();
      if (!event.repeat) cycleTab(event.shiftKey ? -1 : 1);
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, []);
}

/** Whether there is room to scroll each way; the arrows are disabled at the ends. */
function useScrollEnds(strip: RefObject<HTMLDivElement | null>, count: number): { start: boolean; end: boolean } {
  const [ends, setEnds] = useState({ start: false, end: false });
  useLayoutEffect(() => {
    const element = strip.current;
    if (element === null) return;
    const measure = () => {
      const next = {
        start: element.scrollLeft > 0,
        end: element.scrollLeft + element.clientWidth < element.scrollWidth - 1,
      };
      setEnds((last) => (last.start === next.start && last.end === next.end ? last : next));
    };
    measure();
    element.addEventListener('scroll', measure, { passive: true });
    if (typeof ResizeObserver === 'undefined') return () => element.removeEventListener('scroll', measure);
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => {
      element.removeEventListener('scroll', measure);
      observer.disconnect();
    };
  }, [strip, count]);
  return ends;
}

/**
 * The document tabs (DESIGN 3.18 E3): 36 high, bottom-aligned in the 42 strip, width clamp(120, available / min(n, 5), 240). Inactive
 * tabs are Sand, the active one White with a 2 px Solar underline and its close always shown. From 6 tabs the strip scrolls and 32 wide
 * arrows appear. Click or Enter selects, middle click or the x closes, Left/Right/Home/End move focus (the tab scrolls into view),
 * Delete closes the focused tab, Ctrl+Tab cycles.
 */
export function TabStrip() {
  const t = useT();
  const order = useDocuments((state) => state.order);
  const byId = useDocuments((state) => state.byId);
  const activeId = useDocuments((state) => state.activeId);
  const annotationsByDoc = useAnnotations((state) => state.byDoc);
  const ocrRuns = useOcr((state) => state.runs);
  const reduce = useReducedMotion() === true;
  const strip = useRef<HTMLDivElement>(null);
  const scrolls = order.length >= SCROLL_FROM;
  const ends = useScrollEnds(strip, order.length);
  useTabCycleKeys();

  // Keep the whole active tab (with its close button) in view.
  useEffect(() => {
    const list = strip.current;
    const active = list?.querySelector<HTMLElement>('[role="tab"][aria-selected="true"]');
    const item = list && active ? Array.from(list.children).find((child) => child.contains(active)) : undefined;
    if (!list || !item) return;
    const box = item.getBoundingClientRect();
    const view = list.getBoundingClientRect();
    if (box.right > view.right) list.scrollLeft += box.right - view.right;
    else if (box.left < view.left) list.scrollLeft -= view.left - box.left;
  }, [activeId, order.length]);

  const names = useMemo(
    () =>
      order.map((id) => {
        const name = byId[id]?.displayName ?? '';
        return { id, name: name === '' ? t('status.untitled') : name };
      }),
    [order, byId, t],
  );

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    const list = event.currentTarget;
    if (!isOwnEvent(list, event)) return;
    const tabs = itemsOf(list, '[role="tab"]');
    const current = tabs.findIndex((tab) => tab === event.target);
    if (event.key === 'Delete' && current >= 0) {
      event.preventDefault();
      closeTab(Number(tabs[current]?.dataset.id));
      return;
    }
    const target = rovingTarget(event.key, current, tabs.length, { orientation: 'horizontal', wrap: true });
    if (target === null) return;
    event.preventDefault();
    // Roving moves focus only; Enter (the button's click) activates.
    const next = tabs[target];
    next?.focus();
    next?.scrollIntoView?.({ block: 'nearest', inline: 'nearest' });
  };

  const scrollBy = (direction: 1 | -1) => {
    const list = strip.current;
    const first = list?.querySelector<HTMLElement>('[role="presentation"]');
    if (!list || !first) return;
    const gap = parseFloat(getComputedStyle(list).columnGap) || 0;
    const left = direction * (first.getBoundingClientRect().width + gap);
    if (typeof list.scrollBy === 'function') list.scrollBy({ left, behavior: reduce ? 'auto' : 'smooth' });
    else list.scrollLeft += left;
  };

  if (order.length === 0) return null;
  const arrow = 'size-8! shrink-0 self-center';
  return (
    <div className="flex min-w-0 flex-1 items-end" data-tabs="">
      {scrolls && (
        <IconButton
          size="sm"
          icon={ChevronLeft}
          label={t('tabs.scrollLeft')}
          tabIndex={-1}
          disabled={!ends.start}
          className={arrow}
          onClick={() => scrollBy(-1)}
        />
      )}
      <div
        ref={strip}
        role="tablist"
        aria-label={t('tabs.label')}
        aria-orientation="horizontal"
        onKeyDown={onKeyDown}
        style={{ '--tabs-n': Math.min(order.length, TABS_VISIBLE) } as CSSProperties}
        className="flex min-w-0 items-end gap-(--tab-gap) overflow-x-auto [scrollbar-width:none]"
      >
        {names.map(({ id, name }) => {
          const selected = id === activeId;
          const recovered = byId[id]?.kind === 'recovered';
          const edited = byId[id]?.kind !== 'welcome' && (recovered || isDirty({ byDoc: annotationsByDoc }, id));
          return (
            <div
              key={id}
              role="presentation"
              className={cx(
                'group/tab relative flex h-doc-tab w-doc-tab-fit shrink-0 items-center rounded-t-sm ps-3 pe-2',
                selected ? 'bg-panel text-text' : 'bg-subtle text-text-muted focus-within:text-text hover:text-text',
              )}
              onAuxClick={(event: MouseEvent) => {
                if (event.button === 1) {
                  event.preventDefault();
                  closeTab(id);
                }
              }}
            >
              <Tooltip label={name}>
                <button
                  type="button"
                  role="tab"
                  aria-selected={selected}
                  aria-description={recovered ? t('recover.recovered') : edited ? t('tabs.edited') : undefined}
                  tabIndex={selected ? 0 : -1}
                  data-id={id}
                  onClick={() => useDocuments.getState().setActive(id)}
                  className="flex h-full min-w-0 flex-1 cursor-pointer items-center gap-2 text-start"
                >
                  {edited && (
                    <span
                      aria-hidden="true"
                      data-edited=""
                      className="size-[calc(var(--space-1)+var(--space-1)/2)] shrink-0 rounded-pill bg-text"
                    />
                  )}
                  <span
                    data-tour-anchor={selected ? 'topbar-file-name' : undefined}
                    className={cx('t-body min-w-0 flex-1 truncate', selected ? 'font-medium' : 'font-normal')}
                  >
                    {middleTruncate(name)}
                  </span>
                </button>
              </Tooltip>
              <IconButton
                size="sm"
                icon={X}
                iconSize={16}
                label={t('tabs.close', { name })}
                // A tablist owns only tabs (ARIA); keyboard users close with Delete or Primary+W, so the pointer x is hidden from AT.
                aria-hidden="true"
                tabIndex={-1}
                // A text recognition run writes into the tab: it closes after the run (DESIGN 3.12 O3; `closeTab` says why).
                disabled={ocrRuns[id] !== undefined}
                className={cx(
                  'size-5! opacity-0 group-focus-within/tab:opacity-100 group-hover/tab:opacity-100',
                  selected && 'opacity-100',
                )}
                onClick={() => closeTab(id)}
              />
              {selected && (
                <span
                  aria-hidden="true"
                  className="pointer-events-none absolute inset-x-0 bottom-0 h-[calc(var(--space-1)/2)] bg-accent"
                />
              )}
            </div>
          );
        })}
      </div>
      {scrolls && (
        <IconButton
          size="sm"
          icon={ChevronRight}
          label={t('tabs.scrollRight')}
          tabIndex={-1}
          disabled={!ends.end}
          className={arrow}
          onClick={() => scrollBy(1)}
        />
      )}
    </div>
  );
}
