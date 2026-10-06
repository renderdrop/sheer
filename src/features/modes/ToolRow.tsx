import { Ellipsis } from 'lucide-react';
import { memo, useEffect, useLayoutEffect, useRef, useState, type FocusEvent, type KeyboardEvent } from 'react';

import { Icon, Menu, Tooltip, type MenuEntry } from '../../components';
import { cx } from '../../components/cx';
import { useGlidePill } from '../../components/glide';
import { isOwnEvent, itemsOf, rovingTarget } from '../../components/roving';
import { useT } from '../../i18n';
import { useUi } from '../../stores/ui';
import { FIT_START, fitOnResize, hiddenIds, MODE_LABEL, tighter, type Fit, type SlotDef } from './model';
import { TOOL_ROW_ID } from './ModeRow';
import { focusCanvas } from './switch';
import { asEntry, ToolItem } from './ToolItem';
import { useModeSlots } from './useSlots';

const MORE =
  'flex h-control-md w-control-md shrink-0 cursor-pointer items-center justify-center rounded-md text-text transition-colors duration-fast ' +
  'not-aria-disabled:hover:bg-panel not-aria-disabled:aria-expanded:bg-panel';

/** What "Mehr" lists for the items that left the row: an item, or a submenu for a split one. */
function moreEntries(slots: readonly SlotDef[]): MenuEntry[] {
  return slots.map((slot): MenuEntry => {
    const base = {
      id: slot.id,
      label: slot.label,
      icon: slot.icon,
      ...(slot.on ? { checked: true } : {}),
      ...(slot.disabledReason === undefined ? {} : { disabled: true }),
    };
    if (slot.variants === undefined) return { ...base, onSelect: slot.run };
    return {
      ...base,
      submenu: slot.variants.map(asEntry),
    };
  });
}

/**
 * The tool row (DESIGN v2 3.2, ADR-102, FEEDBACK F14): the tools of the mode, at most eight, in a toolbar of one tab stop (Left,
 * Right, Home, End; Enter and Space; Esc releases to Auswahl and focuses the canvas). The row never wraps or scrolls: when it would
 * overflow it gives up, in this order, 1. nothing, 2. the labels of the inactive items, 3. items from the right (never the
 * active tool) into "Mehr". The fit is measured after each render and starts over when the width or the slots change, so
 * it is settled before the next paint.
 */
export const ToolRow = memo(function ToolRow() {
  const t = useT();
  const mode = useUi((state) => state.mode);
  const slots = useModeSlots(mode);
  const row = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(0);
  const [stop, setStop] = useState<string | null>(null);

  const activeId = slots.find((slot) => slot.on && slot.kind === 'tool')?.id ?? null;
  const signature = slots.map((slot) => `${slot.id}:${slot.label}:${slot.on ? 1 : 0}`).join('|');
  // A font that loads late changes the widths of the labels: the fit starts over then, too.
  const [fonts, setFonts] = useState(0);
  const key = `${mode}|${fonts}|${signature}`;
  // `need`: the row's measured width at step 1, the basis of the 8 px hysteresis (DESIGN Q6).
  const [fit, setFit] = useState<{ value: Fit; key: string; need: number | null; width: number }>({
    value: FIT_START,
    key,
    need: null,
    width,
  });
  // Other slots, labels, a mode or a font start the fit over; a new width moves it by the hysteresis rule (derived during render).
  let current = fit.value;
  if (fit.key !== key) {
    current = FIT_START;
    setFit({ value: FIT_START, key, need: null, width });
  } else if (fit.width !== width) {
    current = fitOnResize(fit.value, fit.need, width, fit.width);
    setFit({ ...fit, value: current, width });
  }

  useEffect(() => {
    const element = row.current;
    if (element === null || typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver((entries) => {
      const next = entries[0]?.contentRect.width;
      if (next !== undefined) setWidth(Math.round(next));
    });
    observer.observe(element);
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    const set = typeof document === 'undefined' ? undefined : (document.fonts as FontFaceSet | undefined);
    if (set === undefined) return;
    const again = () => setFonts((n) => n + 1);
    set.addEventListener('loadingdone', again);
    return () => set.removeEventListener('loadingdone', again);
  }, []);

  const movable = slots.length - (activeId === null ? 0 : 1);
  // Measured after the render: the fit that still overflows gets one step tighter before the next paint.
  useLayoutEffect(() => {
    const element = row.current;
    if (element === null || element.scrollWidth <= element.clientWidth) return;
    const next = tighter(current, movable);
    // eslint-disable-next-line react-hooks/set-state-in-effect -- the fit is a measurement of the laid-out row
    if (next !== null) setFit({ ...fit, value: next, need: current.step === 1 ? element.scrollWidth : fit.need });
  });

  // Spell 1: the Solar fill is one element that glides to the active item (a direct child: the split group or the button).
  const pill = useGlidePill(row, ':scope > [data-on="true"]', activeId, '--motion-base');

  const left =
    current.step === 3
      ? hiddenIds(
          slots.map((slot) => slot.id),
          activeId,
          current.hidden,
        )
      : new Set<string>();
  const visible = slots.filter((slot) => !left.has(slot.id));
  const gone = slots.filter((slot) => left.has(slot.id));

  const keys = visible.flatMap((slot) =>
    slot.variants !== undefined || slot.colour !== undefined ? [slot.id, `${slot.id}:more`] : [slot.id],
  );
  if (gone.length > 0) keys.push('overflow');
  const tabStop = stop !== null && keys.includes(stop) ? stop : (keys[0] ?? '');

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    const element = event.currentTarget;
    if (!isOwnEvent(element, event)) return;
    if (event.key === 'Escape') {
      if (event.defaultPrevented) return;
      useUi.getState().releaseTool();
      focusCanvas();
      return;
    }
    if (event.altKey || event.ctrlKey || event.metaKey) return;
    const items = itemsOf(element, '[data-roving]');
    const at = items.findIndex((item) => item === event.target);
    const target = rovingTarget(event.key, at, items.length, { orientation: 'horizontal', wrap: false });
    if (target === null) return;
    event.preventDefault();
    items[target]?.focus();
  };

  const onFocus = (event: FocusEvent<HTMLDivElement>) => {
    const id = event.target instanceof HTMLElement ? event.target.dataset.roving : undefined;
    if (id !== undefined) setStop(id);
  };

  return (
    <div
      ref={row}
      role="toolbar"
      id={TOOL_ROW_ID}
      aria-label={t(MODE_LABEL[mode])}
      data-slot="tool-row"
      data-fit={current.step}
      onKeyDown={onKeyDown}
      onFocus={onFocus}
      className={cx(
        'bg-subtle relative isolate flex h-tool-row min-w-0 items-center gap-1 overflow-hidden border-b border-border-subtle px-4',
      )}
    >
      <span
        ref={pill}
        aria-hidden="true"
        data-glide-pill="tool"
        className="pointer-events-none absolute start-0 top-0 -z-10 rounded-md bg-accent shadow-(--tool-active-edge)"
        style={{ opacity: 0 }}
      />
      {visible.map((slot) => (
        <ToolItem
          key={slot.id}
          slot={slot}
          iconOnly={current.step >= 2 && !(slot.on && slot.kind === 'tool')}
          stop={tabStop}
        />
      ))}
      {gone.length > 0 && (
        <Menu
          label={t('modes.more')}
          entries={moreEntries(gone)}
          trigger={(trigger) => (
            <Tooltip label={t('modes.more')}>
              <button
                {...trigger}
                type="button"
                data-toolbar-item="overflow"
                data-roving="overflow"
                aria-label={t('modes.more')}
                tabIndex={tabStop === 'overflow' ? 0 : -1}
                className={MORE}
              >
                <Icon icon={Ellipsis} size={18} />
              </button>
            </Tooltip>
          )}
        />
      )}
    </div>
  );
});
