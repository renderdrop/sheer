import type { KeyboardEvent, ReactNode } from 'react';

import { cx } from '../../components/cx';
import { isOwnEvent, itemsOf, rovingTarget } from '../../components/roving';

export interface TextTab<Value extends string> {
  value: Value;
  label: string;
}

/**
 * The text tabs of the Document properties dialog (DESIGN 3.7 C5, tabs 36 high): a tablist whose tabs carry words, not icons. Left and
 * Right wrap and select (automatic activation), Home and End jump; only the selected tab is a tab stop. The panel is the caller's:
 * give it `id={panelId}` and `aria-labelledby={tabId(value)}`.
 */
export function TextTabs<Value extends string>({
  label,
  value,
  tabs,
  idBase,
  onValueChange,
}: {
  label: string;
  value: Value;
  tabs: readonly TextTab<Value>[];
  idBase: string;
  onValueChange: (value: Value) => void;
}): ReactNode {
  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    const list = event.currentTarget;
    if (!isOwnEvent(list, event)) return;
    const items = itemsOf(list, '[role="tab"]');
    const current = items.findIndex((item) => item.contains(event.target as Node));
    const target = rovingTarget(event.key, current, items.length, { orientation: 'horizontal', wrap: true });
    if (target === null) return;
    event.preventDefault();
    const next = items[target];
    next?.focus();
    const chosen = tabs[target];
    if (chosen !== undefined) onValueChange(chosen.value);
  };
  return (
    <div
      role="tablist"
      aria-label={label}
      aria-orientation="horizontal"
      onKeyDown={onKeyDown}
      className="mt-4 flex h-control-md w-full border-0 border-b border-solid border-divider"
    >
      {tabs.map((tab) => {
        const selected = tab.value === value;
        return (
          <button
            key={tab.value}
            type="button"
            role="tab"
            id={`${idBase}-tab-${tab.value}`}
            aria-selected={selected}
            aria-controls={`${idBase}-panel`}
            tabIndex={selected ? 0 : -1}
            onClick={() => onValueChange(tab.value)}
            className={cx(
              'relative flex min-w-0 flex-1 cursor-pointer items-center justify-center border-0 bg-transparent px-2 t-label',
              'transition-colors [transition-duration:var(--motion-fast)] motion-reduce:transition-none',
              'focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-focus',
              selected ? 'text-text' : 'text-text-muted hover:text-text',
            )}
          >
            {tab.label}
            {selected && (
              <span
                aria-hidden="true"
                className="absolute inset-x-0 bottom-0 h-half bg-accent forced-colors:bg-[Highlight]"
              />
            )}
          </button>
        );
      })}
    </div>
  );
}
