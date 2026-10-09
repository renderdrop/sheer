import { Ellipsis } from 'lucide-react';
import {
  Fragment,
  memo,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type FocusEvent,
  type KeyboardEvent,
} from 'react';

import { Icon, Menu, Tooltip, type MenuEntry } from '../../components';
import { cx } from '../../components/cx';
import { useGlidePill } from '../../components/glide';
import { isOwnEvent, itemsOf, rovingTarget } from '../../components/roving';
import { useT } from '../../i18n';
import { useSettings } from '../../stores/settings';
import { useUi, type Mode } from '../../stores/ui';
import {
  COMPACT_BELOW,
  FIT_START,
  fitOnResize,
  hiddenInGroups,
  keyOfMode,
  MODE_LABEL,
  modeAfterKey,
  movableIn,
  tighter,
  type Fit,
  type SlotDef,
} from './model';
import { focusCanvas, switchMode } from './switch';
import { asEntry, BOX, ToolItem, type ToolSize } from './ToolItem';
import { useModeEffects } from './useModeEffects';
import { useModeGroups } from './useSlots';

/** The id of the tool strip. */
export const TOOL_ROW_ID = 'mode-tool-row';

/** A group's overflow button: the same square as every tool. */
const MORE =
  'flex shrink-0 cursor-pointer items-center justify-center rounded-(--tool-item-radius) text-text transition-colors duration-fast ' +
  'not-aria-disabled:hover:bg-panel not-aria-disabled:aria-expanded:bg-panel';

/**
 * The mode caption under a group (F21.9): small, secondary ink; the current mode's caption is Ink 500. A text button that switches
 * to its mode; Left, Right, Home and End move between the captions (one tab stop, on the current mode).
 */
const CAPTION =
  'flex h-tool-caption shrink-0 cursor-pointer items-center whitespace-nowrap rounded-sm px-1 text-xs text-text-muted ' +
  'transition-colors duration-fast hover:text-text aria-pressed:font-medium aria-pressed:text-text';

/** What a group's overflow menu lists for the tools that left the strip: an item, or a submenu for a split one. */
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
 * The thin line between two mode groups. It takes the spare width of the strip (all separators equally), so the groups spread
 * over the whole card with the first at the start padding and the last at the end padding; margin-x 8, 4 when compact.
 */
function Separator({ compact }: { compact: boolean }) {
  return (
    <div aria-hidden="true" className={cx('flex flex-1 justify-center self-stretch py-2', compact ? 'px-1' : 'px-2')}>
      <div role="separator" aria-orientation="vertical" data-separator="" className="h-full w-px bg-border" />
    </div>
  );
}

/** The roving key of a group's overflow button. */
const overflowKey = (mode: Mode) => `overflow:${mode}`;

/**
 * The tool card's strip (F21.9, DESIGN 3.18 E4): the tools of all five modes side by side, one group per mode in mode order, each
 * with its caption below and a thin line between the groups. The mode is implicit: a tool of another group enters its mode. The
 * strip is one toolbar of one tab stop (Left, Right, Home, End; Enter and Space; Esc releases to Auswahl and focuses the canvas);
 * the captions are a second stop. It never wraps or scrolls: when it would overflow it gives up, in this order, 1. nothing (labels
 * when "Show labels" is on, else the 36 squares), 2. every item a compact 28 square, 3. trailing tools of the fullest group (never
 * the active tool) into that group's overflow button. The fit is measured after each render and starts over when the width or the
 * slots change, so it is settled before the next paint.
 */
export const ToolRow = memo(function ToolRow() {
  const t = useT();
  const mode = useUi((state) => state.mode);
  const showLabels = useSettings((state) => state.showToolLabels === true);
  const groups = useModeGroups();
  const row = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(0);
  const [stop, setStop] = useState<string | null>(null);
  const [captionStop, setCaptionStop] = useState<Mode | null>(null);
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

  const ids = groups.map((group) => group.slots.map((slot) => slot.id));
  const movable = movableIn(ids);
  // Measured after the render: the fit that still overflows gets one step tighter before the next paint.
  useLayoutEffect(() => {
    const element = row.current;
    if (element === null || element.scrollWidth <= element.clientWidth) return;
    const next = tighter(current, movable);
    // eslint-disable-next-line react-hooks/set-state-in-effect -- the fit is a measurement of the laid-out strip
    if (next !== null) setFit({ ...fit, value: next, need: current.step === 1 ? element.scrollWidth : fit.need });
  });

  // Spell 1: the Solar fill is one element that glides to the active item (a direct child of a group's tools: the split or the button).
  const pill = useGlidePill(row, '[data-tools] > [data-on="true"]', activeId, '--motion-base');

  const left = current.step === 3 ? hiddenInGroups(ids, activeId, current.hidden) : new Set<string>();
  const size: ToolSize = current.step === 1 ? (labels ? 'labelled' : 'square') : 'compact';
  const compact = size === 'compact';

  const keys = groups.flatMap((group) => {
    const shown = group.slots
      .filter((slot) => !left.has(slot.id))
      .flatMap((slot) =>
        slot.variants !== undefined || slot.colour !== undefined ? [slot.id, `${slot.id}:more`] : [slot.id],
      );
    return group.slots.some((slot) => left.has(slot.id)) ? [...shown, overflowKey(group.mode)] : shown;
  });
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

  // The captions: their own tab stop, Left, Right, Home and End move the focus between them (Enter or a click switches).
  const onCaptionKey = (event: KeyboardEvent<HTMLButtonElement>, at: Mode) => {
    if (event.altKey || event.ctrlKey || event.metaKey) return;
    const next = modeAfterKey(at, event.key);
    if (next === null) return;
    event.preventDefault();
    event.stopPropagation();
    row.current?.querySelector<HTMLElement>(`[data-mode-caption="${next}"]`)?.focus();
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
      className="bg-subtle relative isolate flex h-tool-area min-w-0 shrink-0 items-center overflow-hidden px-2"
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
        const gone = group.slots.filter((slot) => left.has(slot.id));
        const more = t('modes.moreOf', { mode: label });
        return (
          <Fragment key={group.mode}>
            {index > 0 && <Separator compact={compact} />}
            <div
              role="group"
              aria-labelledby={captionId}
              data-mode-group={group.mode}
              data-active={active ? 'true' : undefined}
              className="flex shrink-0 flex-col items-center justify-center gap-half"
            >
              <div data-tools="" className={cx('flex items-center', !compact && 'gap-half')}>
                {group.slots
                  .filter((slot) => !left.has(slot.id))
                  .map((slot) => (
                    <ToolItem key={slot.id} slot={slot} size={size} stop={tabStop} />
                  ))}
                {gone.length > 0 && (
                  <Menu
                    label={more}
                    entries={moreEntries(gone)}
                    trigger={(trigger) => (
                      <Tooltip label={more}>
                        <button
                          {...trigger}
                          type="button"
                          data-toolbar-item={`overflow-${group.mode}`}
                          data-roving={overflowKey(group.mode)}
                          aria-label={more}
                          tabIndex={tabStop === overflowKey(group.mode) ? 0 : -1}
                          className={cx(MORE, BOX[size === 'labelled' ? 'square' : size])}
                        >
                          <Icon icon={Ellipsis} size={18} />
                        </button>
                      </Tooltip>
                    )}
                  />
                )}
              </div>
              <Tooltip label={label} shortcut={keyOfMode(group.mode)}>
                <button
                  type="button"
                  id={captionId}
                  data-mode-caption={group.mode}
                  data-tour-anchor={
                    group.mode === 'comment' || group.mode === 'fill' ? `mode-${group.mode}` : undefined
                  }
                  aria-pressed={active}
                  aria-keyshortcuts={keyOfMode(group.mode)}
                  tabIndex={(captionStop ?? mode) === group.mode ? 0 : -1}
                  onFocus={() => setCaptionStop(group.mode)}
                  onBlur={() => setCaptionStop(null)}
                  onClick={() => switchMode(group.mode)}
                  onKeyDown={(event) => onCaptionKey(event, group.mode)}
                  className={CAPTION}
                >
                  {label}
                </button>
              </Tooltip>
            </div>
          </Fragment>
        );
      })}
    </div>
  );
});
