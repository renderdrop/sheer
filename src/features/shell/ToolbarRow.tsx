import { Fragment, useLayoutEffect, useRef, useState, type KeyboardEvent, type ReactNode } from 'react';

import { IconButton, Menu, type ToolbarGroup, type ToolbarItem } from '../../components';
import { cx } from '../../components/cx';
import { isOwnEvent, itemsOf, rovingTarget } from '../../components/roving';
import { useT } from '../../i18n';
import { AuthorPromptField } from '../author/AuthorPromptField';

export interface ToolbarRowProps {
  /** The panel toggles that frame the tool card (`panel-left` before it, `panel-right` after it). */
  leading: ToolbarItem;
  trailing: ToolbarItem;
  /** The tool card's groups, in order; a divider sits between them. */
  groups: readonly ToolbarGroup[];
  /**
   * macOS: the traffic lights float over the start of the row, so the toolbar starts 80 px in (DESIGN 2.2). In full
   * screen the lights are gone and the inset is the normal 8.
   */
  trafficLightInset: boolean;
}

const ITEM_SELECTOR = '[data-toolbar-item]';
/** Labelled item: 32 high, padding 0 12, icon 20, 8, label (DESIGN 3.55). */
const LABELLED = 'gap-1 px-1-5! text-sm font-semibold';
/** The card is used labelled when it fits with this much to spare on each side, and goes compact only when this much short (DESIGN 3.55). */
const SPARE = 16;
const SHORT = 24;

/** The G1 40 x 40 card of a panel toggle. */
const TOGGLE_CARD = 'glass-1 grid size-control-lg place-items-center rounded-panel';

const DIVIDER = 'mx-toolbar-group h-2 w-hairline shrink-0 bg-divider';

/**
 * The toolbar row (DESIGN 2, 3.55): 56 high, a grid `40 | 1fr | auto | 1fr | 40`: the left panel toggle, the centred tool card,
 * the inspector toggle. `role=toolbar` with one tab stop; Left and Right move between items without wrapping, Home and End jump.
 * The card shows names next to the icons when they fit in the centre track (it measures the labelled card in the current language,
 * with a hysteresis so it does not flicker) and icons only otherwise. The empty parts of the row drag the window.
 */
export function ToolbarRow({ leading, trailing, groups, trafficLightInset }: ToolbarRowProps) {
  const t = useT();
  const rowRef = useRef<HTMLDivElement>(null);
  const leadingRef = useRef<HTMLDivElement>(null);
  const measureRef = useRef<HTMLDivElement>(null);
  const [labelled, setLabelled] = useState(true);
  const [activeId, setActiveId] = useState<string | null>(null);

  // Decides labelled or compact from the measured labelled width and the centre track. An unmeasurable layout (no width) keeps the state.
  useLayoutEffect(() => {
    const row = rowRef.current;
    if (row === null) return;
    const decide = () => {
      const natural = measureRef.current?.offsetWidth ?? 0;
      const toggle = leadingRef.current?.offsetWidth ?? 0;
      const style = getComputedStyle(row);
      const padding = Number.parseFloat(style.paddingLeft) + Number.parseFloat(style.paddingRight);
      const track = row.clientWidth - padding - 2 * toggle;
      if (!(natural > 0) || !(track > 0)) return;
      setLabelled((current) => (current ? !(track < natural - SHORT) : track >= natural + 2 * SPARE));
    };
    decide();
    const observer = new ResizeObserver(decide);
    observer.observe(row);
    return () => observer.disconnect();
  }, [groups]);

  const allItems = [leading, ...groups.flatMap((group) => group.items), trailing];
  const tabStop = activeId !== null && allItems.some((item) => item.id === activeId) ? activeId : leading.id;

  const itemProps = (id: string) => ({
    'data-toolbar-item': id,
    tabIndex: id === tabStop ? 0 : -1,
    onFocus: () => setActiveId(id),
    focusableWhenDisabled: true,
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

  const renderToggle = (item: ToolbarItem) => (
    <IconButton
      {...itemProps(item.id)}
      label={item.label}
      icon={item.icon}
      iconSize={20}
      variant="toggle"
      pressed={item.pressed ?? false}
      disabled={item.disabled}
      shortcut={item.shortcut}
      keyShortcuts={item.keyShortcuts}
      onClick={() => item.onActivate?.()}
    />
  );

  const renderTool = (item: ToolbarItem): ReactNode => {
    const button = (extra: object = {}) => (
      <IconButton
        {...itemProps(item.id)}
        {...extra}
        label={item.label}
        icon={item.icon}
        iconSize={20}
        variant="tool"
        pressed={item.pressed ?? false}
        locked={item.locked}
        disabled={item.disabled}
        shortcut={item.shortcut}
        keyShortcuts={item.keyShortcuts}
        className={labelled ? LABELLED : undefined}
      >
        {labelled ? <span className="truncate">{item.label}</span> : undefined}
      </IconButton>
    );
    if (item.menu !== undefined) {
      return (
        <Menu label={item.label} entries={item.menu} disabled={item.disabled} trigger={(trigger) => button(trigger)} />
      );
    }
    return button({
      onClick: (event: { detail: number }) => {
        // The second click of a double click belongs to `onLock`, not to a second activation.
        if (item.onLock !== undefined && event.detail > 1) return;
        item.onActivate?.();
      },
      onDoubleClick: () => item.onLock?.(),
      onKeyDown: (event: KeyboardEvent) => {
        if (item.onLock !== undefined && event.key === 'Enter' && event.shiftKey) {
          event.preventDefault();
          item.onLock();
        }
      },
    });
  };

  return (
    <div
      ref={rowRef}
      data-tauri-drag-region="deep"
      role="toolbar"
      aria-label={t('toolbar.label')}
      aria-orientation="horizontal"
      onKeyDown={onKeyDown}
      className={cx(
        'relative grid h-toolbar-row shrink-0 grid-cols-[var(--control-lg)_minmax(0,1fr)_auto_minmax(0,1fr)_var(--control-lg)] items-center py-1 pe-1',
        trafficLightInset ? 'ps-chrome-inset' : 'ps-1',
        '[&_[aria-disabled=true]]:text-icon-disabled',
      )}
    >
      <div ref={leadingRef} className={TOGGLE_CARD}>
        {renderToggle(leading)}
      </div>
      <span aria-hidden="true" />
      <div
        data-tool-card=""
        data-labelled={labelled || undefined}
        className="glass-1 flex h-control-lg items-center rounded-panel p-0-5"
      >
        {groups.map((group, index) => (
          <Fragment key={group.id}>
            {index > 0 && <div role="separator" aria-orientation="vertical" className={DIVIDER} />}
            <div role="group" aria-label={group.label} className="flex items-center gap-0-5">
              {group.items.map((item) => (
                <Fragment key={item.id}>{renderTool(item)}</Fragment>
              ))}
            </div>
          </Fragment>
        ))}
      </div>
      <div className="flex min-w-0 items-center justify-self-end">
        <AuthorPromptField />
      </div>
      <div className={TOGGLE_CARD}>{renderToggle(trailing)}</div>
      {/* The labelled card, never shown: its width is what decides between labelled and compact. */}
      <div
        ref={measureRef}
        aria-hidden="true"
        inert
        className="pointer-events-none invisible absolute start-0 top-0 flex w-max items-center p-0-5"
      >
        {groups.map((group, index) => (
          <Fragment key={group.id}>
            {index > 0 && <div className={DIVIDER} />}
            <div className="flex items-center gap-0-5">
              {group.items.map((item) => (
                <span key={item.id} className={cx('flex h-control-md items-center whitespace-nowrap', LABELLED)}>
                  <span className="size-icon-20 shrink-0" />
                  {item.label}
                </span>
              ))}
            </div>
          </Fragment>
        ))}
      </div>
    </div>
  );
}
