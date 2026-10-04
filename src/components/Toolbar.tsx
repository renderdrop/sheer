import { Ellipsis, type LucideIcon } from 'lucide-react';
import { Fragment, useEffect, useLayoutEffect, useRef, useState, type KeyboardEvent, type ReactNode } from 'react';

import { useT } from '../i18n';
import { cx } from './cx';
import { IconButton, type IconButtonProps } from './IconButton';
import type { IconButtonVariant } from './controlStyles';
import { Menu, type MenuEntries, type MenuEntry } from './Menu';
import { isOwnEvent, itemsOf, rovingTarget } from './roving';

export interface ToolbarItem {
  /** Stable id: the roving tab stop and the overflow menu use it. */
  id: string;
  /** Accessible name and tooltip text. */
  label: string;
  icon?: LucideIcon;
  /**
   * Text instead of an icon, in a 56 px wide button (the zoom readout). An element that follows some state by itself
   * (the zoom readout) keeps the toolbar from re-rendering when that state changes.
   */
  text?: ReactNode;
  /**
   * `action` runs and is done; `toggle` shows a panel on or off (selected look); `tool` is the active tool (accent
   * fill). Toggles and tools set `aria-pressed`. Default `action`.
   */
  kind?: 'action' | 'toggle' | 'tool';
  pressed?: boolean;
  /** A tool that stays active after use: lock badge, `aria-description`, tooltip note. */
  locked?: boolean;
  disabled?: boolean;
  /** One-line explanation under the name in the tooltip. */
  hint?: string;
  /** Key chip in the tooltip, formatted for the platform. */
  shortcut?: string;
  /** `aria-keyshortcuts` value. */
  keyShortcuts?: string;
  /** Opens this menu instead of running `onActivate` (ArrowDown opens it too). A function makes the entries while the menu renders. */
  menu?: MenuEntries;
  /** 1 = the first item to move into More when the toolbar is too narrow, 2 the next. Omit: never moves. */
  collapse?: number;
  /** Click, Enter or Space. A double click only calls `onLock`. */
  onActivate?: () => void;
  /** Double click or Shift+Enter on a tool. */
  onLock?: () => void;
}

export interface ToolbarGroup {
  type?: 'group';
  id: string;
  /** Names the group for assistive technology (`role=group`). */
  label: string;
  items: readonly ToolbarItem[];
}

/** Flexible space: everything after it sits at the trailing edge. */
export interface ToolbarSpacer {
  type: 'spacer';
  id: string;
}

/** Where the More button goes. It appears only when it has something to show. */
export interface ToolbarMore {
  type: 'more';
  id: string;
}

export type ToolbarEntry = ToolbarGroup | ToolbarSpacer | ToolbarMore;

export interface ToolbarProps {
  /** `aria-label` of the toolbar ("Tools"). */
  label: string;
  entries: readonly ToolbarEntry[];
  /** Menu entries that always live in More, before the items that overflow into it. */
  moreItems?: readonly MenuEntry[];
  moreLabel?: string;
  lockedDescription?: string;
  lockedNote?: string;
  className?: string;
}

const ITEM_SELECTOR = '[data-toolbar-item]';
// The zoom readout is 56 px wide (DESIGN 3.3): `--field-width`.
const READOUT_WIDTH = 'w-field text-sm';

function isGroup(entry: ToolbarEntry): entry is ToolbarGroup {
  return entry.type === undefined || entry.type === 'group';
}

const VARIANT: Record<NonNullable<ToolbarItem['kind']>, IconButtonVariant> = {
  action: 'plain',
  toggle: 'toggle',
  tool: 'tool',
};

/**
 * Toolbar (DESIGN 3.3): G1, 40 high, `role=toolbar` with one tab stop. Left and Right move between items without
 * wrapping, Home and End jump, ArrowDown opens an item's menu. Clusters are `role=group`; a 1 x 16 px divider sits
 * between visible clusters. Disabled items stay focusable (`aria-disabled`). When the toolbar is too narrow, items with
 * `collapse` move into the More menu in that order; More shows as active while a collapsed tool is.
 */
export function Toolbar({
  label,
  entries,
  moreItems = [],
  moreLabel,
  lockedDescription,
  lockedNote,
  className,
}: ToolbarProps) {
  const t = useT();
  const moreText = moreLabel ?? t('component.more');
  const rootRef = useRef<HTMLDivElement>(null);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [collapsedCount, setCollapsedCount] = useState(0);
  const [width, setWidth] = useState(0);

  const groups = entries.filter(isGroup);
  const hasMore = entries.some((entry) => entry.type === 'more');
  const overflowOrder = hasMore
    ? groups
        .flatMap((group) => group.items)
        .filter((item) => item.collapse !== undefined)
        .sort((a, b) => (a.collapse ?? 0) - (b.collapse ?? 0))
    : [];
  const collapsed = new Set(overflowOrder.slice(0, collapsedCount).map((item) => item.id));

  // Overflow: too wide means one more item goes into More. Runs after every render, so a resize settles before paint.
  useLayoutEffect(() => {
    const root = rootRef.current;
    if (root === null) return;
    if (root.scrollWidth > root.clientWidth && collapsedCount < overflowOrder.length) {
      setCollapsedCount(collapsedCount + 1);
    }
    // `width` re-runs the pass after a resize; the entries after every change of the contents.
  }, [collapsedCount, overflowOrder.length, width, entries, moreItems]);

  useEffect(() => {
    const root = rootRef.current;
    if (root === null) return;
    let last = root.clientWidth;
    const observer = new ResizeObserver(() => {
      const next = root.clientWidth;
      // More room: show everything again; the fit pass above collapses what still does not fit.
      if (next > last) setCollapsedCount(0);
      last = next;
      setWidth(next);
    });
    observer.observe(root);
    return () => observer.disconnect();
  }, []);

  // More: fixed entries, then the collapsed items in toolbar order with a separator between clusters.
  const overflowEntries: MenuEntry[] = [];
  let anyCollapsedPressed = false;
  for (const group of groups) {
    const moved = group.items.filter((item) => collapsed.has(item.id));
    if (moved.length === 0) continue;
    if (moreItems.length > 0 || overflowEntries.length > 0) {
      overflowEntries.push({ type: 'separator', id: `${group.id}:before` });
    }
    for (const item of moved) {
      if (item.pressed === true) anyCollapsedPressed = true;
      overflowEntries.push({
        id: item.id,
        label: item.label,
        icon: item.icon,
        shortcut: item.shortcut,
        checked: item.kind === 'action' || item.kind === undefined ? undefined : item.pressed === true,
        disabled: item.disabled,
        onSelect: () => item.onActivate?.(),
      });
    }
  }
  const moreEntries: MenuEntry[] = [...moreItems, ...overflowEntries];
  const showMore = hasMore && moreEntries.length > 0;

  // The tab stop is the last focused item, or the first one when that is gone (collapsed) or nothing was focused yet.
  const visibleIds = entries.flatMap((entry) => {
    if (isGroup(entry)) return entry.items.filter((item) => !collapsed.has(item.id)).map((item) => item.id);
    return entry.type === 'more' && showMore ? [entry.id] : [];
  });
  const tabStop = activeId !== null && visibleIds.includes(activeId) ? activeId : visibleIds[0];

  const itemProps = (id: string) => ({
    'data-toolbar-item': id,
    tabIndex: id === tabStop ? 0 : -1,
    onFocus: () => setActiveId(id),
    focusableWhenDisabled: true,
    lockedDescription,
    lockedNote,
  });

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    const root = event.currentTarget;
    if (!isOwnEvent(root, event)) return;
    const items = itemsOf(root, ITEM_SELECTOR);
    const current = items.findIndex((item) => item.contains(event.target as Node));
    if (current < 0) return;
    const target = rovingTarget(event.key, current, items.length, { orientation: 'horizontal', wrap: false });
    if (target === null) return;
    event.preventDefault();
    items[target]?.focus();
  };

  const renderItem = (item: ToolbarItem): ReactNode => {
    const kind = item.kind ?? 'action';
    const pressable = kind !== 'action';
    const button = (extra: Partial<IconButtonProps> = {}) => (
      <IconButton
        {...itemProps(item.id)}
        {...extra}
        label={item.label}
        icon={item.icon}
        iconSize={20}
        variant={VARIANT[kind]}
        pressed={pressable ? (item.pressed ?? false) : undefined}
        locked={item.locked}
        disabled={item.disabled}
        shortcut={item.shortcut}
        hint={item.hint}
        keyShortcuts={item.keyShortcuts}
        className={item.text !== undefined ? READOUT_WIDTH : undefined}
      >
        {item.text}
      </IconButton>
    );

    if (item.menu !== undefined) {
      return (
        <Menu label={item.label} entries={item.menu} disabled={item.disabled} trigger={(trigger) => button(trigger)} />
      );
    }
    return button({
      onClick: (event) => {
        // The second click of a double click belongs to `onLock`, not to a second activation.
        if (item.onLock !== undefined && event.detail > 1) return;
        item.onActivate?.();
      },
      onDoubleClick: () => item.onLock?.(),
      onKeyDown: (event) => {
        if (item.onLock !== undefined && event.key === 'Enter' && event.shiftKey) {
          event.preventDefault();
          item.onLock();
        }
      },
    });
  };

  // A divider goes before a visible cluster that follows another one; a spacer starts a new run.
  const nodes: ReactNode[] = [];
  let dividerNeeded = false;
  for (const entry of entries) {
    if (entry.type === 'spacer') {
      dividerNeeded = false;
      nodes.push(<div key={entry.id} aria-hidden="true" className="min-w-0 flex-auto" />);
      continue;
    }
    const divider = dividerNeeded ? (
      <div
        role="separator"
        aria-orientation="vertical"
        className="mx-toolbar-group h-4 w-hairline shrink-0 bg-divider"
      />
    ) : null;
    if (entry.type === 'more') {
      if (!showMore) continue;
      dividerNeeded = true;
      nodes.push(
        <Fragment key={entry.id}>
          {divider}
          <Menu
            label={moreText}
            entries={moreEntries}
            trigger={(trigger) => (
              <IconButton
                {...itemProps(entry.id)}
                {...trigger}
                label={moreText}
                icon={Ellipsis}
                iconSize={20}
                variant="tool"
                active={anyCollapsedPressed}
              />
            )}
          />
        </Fragment>,
      );
      continue;
    }
    const visible = entry.items.filter((item) => !collapsed.has(item.id));
    if (visible.length === 0) continue;
    dividerNeeded = true;
    nodes.push(
      <Fragment key={entry.id}>
        {divider}
        <div role="group" aria-label={entry.label} className="flex items-center gap-1">
          {visible.map((item) => (
            <Fragment key={item.id}>{renderItem(item)}</Fragment>
          ))}
        </div>
      </Fragment>,
    );
  }

  return (
    <div
      ref={rootRef}
      role="toolbar"
      aria-label={label}
      aria-orientation="horizontal"
      onKeyDown={onKeyDown}
      className={cx(
        'bg-panel border border-border-subtle shadow-floating flex h-control-lg items-center overflow-hidden rounded-panel p-1',
        className,
      )}
    >
      {nodes}
    </div>
  );
}
