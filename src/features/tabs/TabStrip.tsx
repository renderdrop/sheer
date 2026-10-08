import { ChevronDown, X } from 'lucide-react';
import { motion } from 'motion/react';
import { useEffect, useLayoutEffect, useMemo, useRef, useState, type KeyboardEvent, type MouseEvent } from 'react';

import { isModalOpen } from '../../actions/dispatch';
import { IconButton, Menu, Tooltip, type MenuEntry } from '../../components';
import { cx } from '../../components/cx';
import { SPRING } from '../../components/motion';
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

/** Whether the strip is wider than its box, so the all-documents menu is offered. */
function useOverflow(strip: React.RefObject<HTMLDivElement | null>, count: number): boolean {
  const [overflowing, setOverflowing] = useState(false);
  useLayoutEffect(() => {
    const element = strip.current;
    if (element === null) return;
    const measure = () => setOverflowing(element.scrollWidth > element.clientWidth + 1);
    measure();
    if (typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => observer.disconnect();
  }, [strip, count]);
  return overflowing;
}

/**
 * The document tabs (DESIGN v2 3.2, 2.8), in the top bar from two open documents on: 28 high, 128 to 200 wide, the close x on hover or for the active tab, the active tab in Ink with a 2 px Solar underline. Click
 * selects, middle click or the x closes, Left and Right move with automatic activation, Delete closes the focused tab. The strip
 * scrolls when the tabs reach their minimum width and then offers a menu of all documents. No drag reorder in M1.
 */
export function TabStrip() {
  const t = useT();
  const order = useDocuments((state) => state.order);
  const byId = useDocuments((state) => state.byId);
  const activeId = useDocuments((state) => state.activeId);
  const annotationsByDoc = useAnnotations((state) => state.byDoc);
  const ocrRuns = useOcr((state) => state.runs);
  const strip = useRef<HTMLDivElement>(null);
  const overflowing = useOverflow(strip, order.length);
  useTabCycleKeys();

  // Keep the whole active tab (with its close button) in view. Runs again when the strip starts overflowing: the overflow menu
  // narrows the strip after a new tab mounted, which left the new tab's end clipped (v1.4.1 acceptance).
  useEffect(() => {
    const list = strip.current;
    const active = list?.querySelector<HTMLElement>('[role="tab"][aria-selected="true"]');
    const item = list && active ? Array.from(list.children).find((child) => child.contains(active)) : undefined;
    if (!list || !item) return;
    const box = item.getBoundingClientRect();
    const view = list.getBoundingClientRect();
    if (box.right > view.right) list.scrollLeft += box.right - view.right;
    else if (box.left < view.left) list.scrollLeft -= view.left - box.left;
  }, [activeId, order.length, overflowing]);

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
      const id = Number(tabs[current]?.dataset.id);
      closeTab(id);
      return;
    }
    const target = rovingTarget(event.key, current, tabs.length, { orientation: 'horizontal', wrap: true });
    if (target === null) return;
    event.preventDefault();
    const next = tabs[target];
    next?.focus();
    if (next?.dataset.id !== undefined) useDocuments.getState().setActive(Number(next.dataset.id));
  };

  const menu: MenuEntry[] = names.map(({ id, name }) => ({
    id: String(id),
    label: name,
    checked: id === activeId,
    onSelect: () => useDocuments.getState().setActive(id),
  }));

  if (order.length === 0) return null;
  return (
    <div className="flex min-w-0 flex-1 items-center gap-1" data-tabs="">
      <div
        ref={strip}
        role="tablist"
        aria-label={t('tabs.label')}
        aria-orientation="horizontal"
        onKeyDown={onKeyDown}
        className="flex min-w-0 flex-1 gap-1 overflow-x-auto [scrollbar-width:none]"
      >
        {names.map(({ id, name }) => {
          const selected = id === activeId;
          const recovered = byId[id]?.kind === 'recovered';
          const edited = byId[id]?.kind !== 'welcome' && (recovered || isDirty({ byDoc: annotationsByDoc }, id));
          return (
            <motion.div
              key={id}
              role="presentation"
              initial={{ opacity: 0 }}
              animate={{ opacity: 1, transition: SPRING.fast }}
              className={cx(
                'group/tab relative flex h-control-sm min-w-tab-min max-w-tab-max items-center rounded-sm ps-2 pe-1',
                // The active tab keeps its width (up to the maximum) so its name stays readable; the others give way and the strip scrolls.
                selected ? 'flex-none' : 'flex-1',
                selected ? 'text-text' : 'text-text-muted hover:bg-subtle hover:text-text',
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
                  className="flex h-full min-w-0 flex-1 cursor-pointer items-center gap-2 rounded-sm text-start"
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
                    className={cx('t-label min-w-0 flex-1 truncate', selected && 'font-medium')}
                  >
                    {middleTruncate(name)}
                  </span>
                </button>
              </Tooltip>
              <IconButton
                size="sm"
                icon={X}
                label={t('tabs.close', { name })}
                // A tablist owns only tabs (ARIA); keyboard users close with Delete or Primary+W, so the pointer x is hidden from AT.
                aria-hidden="true"
                tabIndex={-1}
                // A text recognition run writes into the tab: it closes after the run (DESIGN 3.12 O3; `closeTab` says why).
                disabled={ocrRuns[id] !== undefined}
                className={cx(
                  'opacity-0 group-focus-within/tab:opacity-100 group-hover/tab:opacity-100',
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
            </motion.div>
          );
        })}
      </div>
      {overflowing && (
        <Menu
          label={t('tabs.all')}
          entries={menu}
          side="bottom"
          align="end"
          trigger={(trigger) => <IconButton {...trigger} size="sm" icon={ChevronDown} label={t('tabs.all')} />}
        />
      )}
    </div>
  );
}
