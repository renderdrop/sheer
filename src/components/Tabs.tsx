import type { LucideIcon } from 'lucide-react';
import { motion, useReducedMotion } from 'motion/react';
import { createContext, useContext, useId, type KeyboardEvent, type ReactNode } from 'react';

import { SELECTED_FORCED_COLORS } from './controlStyles';
import { cx } from './cx';
import { Icon } from './Icon';
import { DURATION, tween } from '../lib/motion';
import { TWEEN } from './motion';
import { isOwnEvent, itemsOf, rovingTarget } from './roving';
import { Tooltip } from './Tooltip';

interface TabsContextValue {
  value: string;
  select: (value: string) => void;
  baseId: string;
}

const TabsContext = createContext<TabsContextValue | null>(null);

function useTabs(): TabsContextValue {
  const context = useContext(TabsContext);
  if (context === null) throw new Error('TabList, Tab and TabPanel must be used inside <Tabs>');
  return context;
}

const tabId = (baseId: string, value: string) => `${baseId}-tab-${value}`;
const panelId = (baseId: string, value: string) => `${baseId}-panel-${value}`;

export interface TabsProps {
  /** The selected tab. Tab values must be plain words: they become part of element ids. */
  value: string;
  onValueChange: (value: string) => void;
  children: ReactNode;
  className?: string;
}

/** Owns the selection of a TabList and its TabPanels (DESIGN 3.6). */
export function Tabs({ value, onValueChange, children, className }: TabsProps) {
  const baseId = useId();
  return (
    <TabsContext value={{ value, select: onValueChange, baseId }}>
      <div className={className}>{children}</div>
    </TabsContext>
  );
}

export interface TabListProps {
  /** `aria-label` of the tablist. */
  label: string;
  children: ReactNode;
  className?: string;
}

/**
 * The segmented control (DESIGN 3.6): 32 high, equal-width tabs. Left and Right wrap around, Home and End jump, and
 * moving focus selects the tab (automatic activation). Only the selected tab is a tab stop; Tab then enters the panel.
 */
export function TabList({ label, children, className }: TabListProps) {
  const { select } = useTabs();

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    const list = event.currentTarget;
    if (!isOwnEvent(list, event)) return;
    const tabs = itemsOf(list, '[role="tab"]');
    const current = tabs.findIndex((tab) => tab.contains(event.target as Node));
    const target = rovingTarget(event.key, current, tabs.length, { orientation: 'horizontal', wrap: true });
    if (target === null) return;
    event.preventDefault();
    const next = tabs[target];
    if (next === undefined) return;
    next.focus();
    // A disabled tab can be reached (it stays focusable) but not selected.
    if (next.getAttribute('aria-disabled') !== 'true' && next.dataset.value !== undefined) select(next.dataset.value);
  };

  return (
    <div
      role="tablist"
      aria-label={label}
      aria-orientation="horizontal"
      onKeyDown={onKeyDown}
      className={cx('flex h-control-md w-full', className)}
    >
      {children}
    </div>
  );
}

export interface TabProps {
  value: string;
  /** Accessible name and tooltip text: tabs are icon-only. */
  label: string;
  icon: LucideIcon;
  /** Key chip in the tooltip, formatted for the platform. */
  shortcut?: string;
  keyShortcuts?: string;
  /** Stays focusable (`aria-disabled`) but cannot be selected. */
  disabled?: boolean;
}

/**
 * The selected fill. With motion it slides to the next tab (`transform`, base tween) through a shared layout id;
 * under reduced motion no transform is used and the new fill just fades in.
 */
function Indicator({ layoutId }: { layoutId: string }) {
  const reduce = useReducedMotion() === true;
  return (
    <motion.span
      aria-hidden="true"
      {...(reduce
        ? { initial: { opacity: 0 }, animate: { opacity: 1 }, transition: tween(DURATION.fast) }
        : { layoutId, transition: TWEEN.base })}
      className={cx('absolute inset-x-0 bottom-0 h-half bg-accent', SELECTED_FORCED_COLORS)}
    />
  );
}

/** One icon tab (DESIGN 3.6). */
export function Tab({ value, label, icon, shortcut, keyShortcuts, disabled = false }: TabProps) {
  const { value: selectedValue, select, baseId } = useTabs();
  const selected = selectedValue === value;

  return (
    <Tooltip label={label} shortcut={shortcut}>
      <button
        type="button"
        role="tab"
        id={tabId(baseId, value)}
        aria-selected={selected}
        aria-controls={panelId(baseId, value)}
        aria-label={label}
        aria-keyshortcuts={keyShortcuts}
        aria-disabled={disabled ? true : undefined}
        data-value={value}
        tabIndex={selected ? 0 : -1}
        onClick={() => {
          if (!disabled) select(value);
        }}
        className={cx(
          'relative flex h-full min-w-0 flex-1 cursor-pointer items-center justify-center',
          'transition-colors [transition-duration:var(--motion-fast)]',
          'aria-disabled:cursor-not-allowed aria-disabled:text-text-disabled',
          selected ? 'font-medium text-text' : 'font-normal text-text-muted not-aria-disabled:hover:text-text',
        )}
      >
        {selected && <Indicator layoutId={`${baseId}-indicator`} />}
        <Icon icon={icon} className="relative" />
      </button>
    </Tooltip>
  );
}

export interface TabPanelProps {
  value: string;
  /** Keep the content mounted while the tab is not selected. Default: render it only while selected. */
  keepMounted?: boolean;
  children?: ReactNode;
  className?: string;
}

/** The content of one tab; labelled by it. Focusable, so Tab from the tablist enters the panel (DESIGN 3.6). */
export function TabPanel({ value, keepMounted = false, children, className }: TabPanelProps) {
  const { value: selectedValue, baseId } = useTabs();
  const selected = selectedValue === value;
  return (
    <div
      role="tabpanel"
      id={panelId(baseId, value)}
      aria-labelledby={tabId(baseId, value)}
      hidden={!selected}
      tabIndex={selected ? 0 : undefined}
      className={className}
    >
      {selected || keepMounted ? children : null}
    </div>
  );
}
