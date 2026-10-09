import { memo, useEffect, useLayoutEffect, useRef, useState, type FocusEvent, type KeyboardEvent } from 'react';

import { cx } from '../../components/cx';
import { useGlidePill } from '../../components/glide';
import { isOwnEvent, itemsOf, rovingTarget } from '../../components/roving';
import { useT } from '../../i18n';
import { useSettings } from '../../stores/settings';
import { useUi } from '../../stores/ui';
import { COMPACT_BELOW, FIT_START, fitOnResize, MODE_LABEL, tighter, type Fit } from './model';
import { focusCanvas } from './switch';
import { ToolItem, type ToolSize } from './ToolItem';
import { useModeEffects } from './useModeEffects';
import { useModeGroups } from './useSlots';

/** The id of the tool strip. */
export const TOOL_ROW_ID = 'mode-tool-row';

/**
 * The caption under a group (F22.2): plain small text in secondary ink. Not a button, not focusable, no tooltip, no state.
 */
const CAPTION = 'flex h-tool-caption shrink-0 items-center whitespace-nowrap px-1 text-xs text-text-muted select-none';

/**
 * The line between two groups (F22.2): the gap `--tool-group-gap` (20) wide with the 1 px line centred in it. It belongs to the group
 * before it and wraps with it; at the end of a wrapped line it is hidden (`data-line-end`), so a separator never starts a line.
 */
function Separator() {
  return (
    <div
      aria-hidden="true"
      data-separator-box=""
      className="flex w-tool-group-gap shrink-0 justify-center self-stretch py-2 data-line-end:invisible"
    >
      <div role="separator" aria-orientation="vertical" data-separator="" className="h-full w-px bg-border" />
    </div>
  );
}

/**
 * The tool card's strip (F22.2, F22.3, DESIGN 3.18 E4): the tools of all five modes side by side, one group per mode in mode order,
 * each with a static caption below and a thin line between the groups. The strip is one toolbar of one tab stop (Left, Right, Home,
 * End; Enter and Space; Esc releases to Auswahl and focuses the canvas). The mode is internal and follows the active tool. It never
 * scrolls: when it would overflow it gives up, in this order, 1. nothing (labels when "Show labels" is on, else the 36 squares),
 * 2. every item a 32 square, 3. whole groups wrap onto a further line (the card grows by that line). The fit is measured after each
 * render and starts over when the width or the slots change, so it is settled before the next paint.
 */
export const ToolRow = memo(function ToolRow() {
  const t = useT();
  const mode = useUi((state) => state.mode);
  const showLabels = useSettings((state) => state.showToolLabels === true);
  const groups = useModeGroups();
  const row = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(0);
  const [stop, setStop] = useState<string | null>(null);
  const [narrow, setNarrow] = useState(() => typeof window !== 'undefined' && window.innerWidth < COMPACT_BELOW);
  useModeEffects();

  const slots = groups.flatMap((group) => group.slots);
  const activeId = slots.find((slot) => slot.on && slot.kind === 'tool')?.id ?? null;
  const signature = slots.map((slot) => `${slot.id}:${slot.label}:${slot.on ? 1 : 0}`).join('|');
  // A font that loads late changes the widths of the labels and captions: the fit starts over then, too.
  const [fonts, setFonts] = useState(0);
  const labels = showLabels && !narrow;
  const key = `${fonts}|${signature}|${labels ? 1 : 0}`;
  // `need`: the strip's measured width at step 1, the basis of the 8 px hysteresis (DESIGN Q6).
  const [fit, setFit] = useState<{ value: Fit; key: string; need: number | null; width: number }>({
    value: FIT_START,
    key,
    need: null,
    width,
  });
  // Other slots, labels or a font start the fit over; a new width moves it by the hysteresis rule (derived during render).
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
    const check = () => setNarrow(window.innerWidth < COMPACT_BELOW);
    window.addEventListener('resize', check);
    return () => window.removeEventListener('resize', check);
  }, []);

  useEffect(() => {
    const set = typeof document === 'undefined' ? undefined : (document.fonts as FontFaceSet | undefined);
    if (set === undefined) return;
    const again = () => setFonts((n) => n + 1);
    set.addEventListener('loadingdone', again);
    return () => set.removeEventListener('loadingdone', again);
  }, []);

  // Measured after the render: the fit that still overflows gets one step tighter before the next paint.
  useLayoutEffect(() => {
    const element = row.current;
    if (element === null || element.scrollWidth <= element.clientWidth) return;
    const next = tighter(current);
    // eslint-disable-next-line react-hooks/set-state-in-effect -- the fit is a measurement of the laid-out strip
    if (next !== null) setFit({ ...fit, value: next, need: current.step === 1 ? element.scrollWidth : fit.need });
  });

  // Wrapped (step 3): a separator that ends a line is hidden, and the card grows by the lines (root attribute -> grid row).
  const wrapped = current.step === 3;
  useLayoutEffect(() => {
    const element = row.current;
    if (element === null) return;
    const units = [...element.querySelectorAll<HTMLElement>('[data-unit]')];
    units.forEach((unit, at) => {
      const next = units[at + 1];
      const ends = wrapped && next !== undefined && next.offsetTop !== unit.offsetTop;
      unit.querySelector('[data-separator-box]')?.toggleAttribute('data-line-end', ends);
    });
    const lines = wrapped ? new Set(units.map((unit) => unit.offsetTop)).size : 1;
    const root = document.documentElement;
    if (lines > 1) root.dataset.toolLines = String(Math.min(lines, 3));
    else delete root.dataset.toolLines;
  });
  useEffect(
    () => () => {
      delete document.documentElement.dataset.toolLines;
    },
    [],
  );

  // Spell 1: the Solar fill is one element that glides to the active item (a direct child of a group's tools: the split or the button).
  const pill = useGlidePill(row, '[data-tools] > [data-on="true"]', activeId, '--motion-base');

  const size: ToolSize = current.step === 1 ? (labels ? 'labelled' : 'square') : 'compact';

  const keys = groups.flatMap((group) =>
    group.slots.flatMap((slot) =>
      slot.variants !== undefined || slot.colour !== undefined ? [slot.id, `${slot.id}:more`] : [slot.id],
    ),
  );
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
    if (at < 0) return;
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
      aria-label={t('modes.region')}
      data-slot="tool-row"
      data-fit={current.step}
      data-labels={showLabels ? 'on' : 'off'}
      onKeyDown={onKeyDown}
      onFocus={onFocus}
      className={cx(
        'bg-subtle relative isolate flex h-tool-area min-w-0 shrink-0 items-center overflow-hidden px-2',
        wrapped && 'flex-wrap content-stretch',
      )}
    >
      <span
        ref={pill}
        aria-hidden="true"
        data-glide-pill="tool"
        className="pointer-events-none absolute start-0 top-0 -z-10 rounded-(--tool-item-radius) bg-accent shadow-(--tool-active-edge)"
        style={{ opacity: 0 }}
      />
      {groups.map((group, index) => {
        const active = group.mode === mode;
        const label = t(MODE_LABEL[group.mode]);
        const captionId = `mode-caption-${group.mode}`;
        return (
          <div key={group.mode} data-unit="" className="flex shrink-0 items-center">
            <div
              role="group"
              aria-labelledby={captionId}
              data-mode-group={group.mode}
              data-active={active ? 'true' : undefined}
              className="flex shrink-0 flex-col items-center justify-center gap-half"
            >
              <div data-tools="" className={cx('flex items-center gap-half')}>
                {group.slots.map((slot) => (
                  <ToolItem key={slot.id} slot={slot} size={size} stop={tabStop} />
                ))}
              </div>
              <span
                id={captionId}
                data-mode-caption={group.mode}
                data-tour-anchor={group.mode === 'comment' || group.mode === 'fill' ? `mode-${group.mode}` : undefined}
                className={CAPTION}
              >
                {label}
              </span>
            </div>
            {index < groups.length - 1 && <Separator />}
          </div>
        );
      })}
    </div>
  );
});
