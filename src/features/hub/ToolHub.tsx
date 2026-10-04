import { useId, useRef, useState, type KeyboardEvent } from 'react';

import { Icon } from '../../components';
import { PILL, PRESS_MOTION } from '../../components/controlStyles';
import { cx } from '../../components/cx';
import { isOwnEvent, itemsOf } from '../../components/roving';
import { useT } from '../../i18n';
import { Spinner } from '../jobs/JobFooter';
import { HUB_CARDS, type HubCard, type HubCardId } from './cards';
import { gridTarget } from './grid';

export interface ToolHubProps {
  /** The Open card's key chip, formatted for the platform ("Ctrl+O", "⌘O"). */
  openShortcut: string;
  /** The `aria-keyshortcuts` value of the Open card. */
  openKeyShortcuts: string;
  /** The card whose dialog or open runs now (`aria-busy`); the others are `aria-disabled`. Null when idle. */
  busy: HubCardId | null;
  /** Some other open is running (the viewer's own guard): all cards are `aria-disabled`. */
  opening: boolean;
  onRun: (card: HubCardId) => void;
}

interface CardViewProps {
  card: HubCard;
  busy: boolean;
  disabled: boolean;
  tabStop: boolean;
  shortcut: string;
  keyShortcuts: string;
  onRun: (card: HubCardId) => void;
  onFocus: () => void;
}

/**
 * One tool card (DESIGN 3.54): G1, radius 24, padding 16, a 40 tile, title, a 2-line hint. At windows up to 800 high it is
 * compact: 64 high, a 32 tile beside the title, the hint only for assistive technology (`aria-describedby`). The compact
 * rule is a height media query on purpose, so it follows the window without script.
 */
function CardView({ card, busy, disabled, tabStop, shortcut, keyShortcuts, onRun, onFocus }: CardViewProps) {
  const t = useT();
  const hintId = useId();
  const titleId = useId();
  const primary = card.id === 'open';
  const pill = primary ? shortcut : card.multi ? t('hub.multi') : '';
  return (
    <button
      type="button"
      data-hub-card={card.id}
      autoFocus={primary}
      tabIndex={tabStop ? 0 : -1}
      aria-labelledby={titleId}
      aria-describedby={hintId}
      aria-busy={busy || undefined}
      aria-disabled={disabled || undefined}
      aria-keyshortcuts={primary && keyShortcuts !== '' ? keyShortcuts : undefined}
      onFocus={onFocus}
      onClick={() => {
        if (!disabled) onRun(card.id);
      }}
      className={cx(
        'group bg-panel border border-border-subtle shadow-floating relative flex h-hub-card min-w-0 cursor-pointer select-none flex-col items-start overflow-hidden rounded-card p-4 text-start',
        PRESS_MOTION,
        'not-aria-disabled:active:scale-(--scale-press) aria-disabled:cursor-not-allowed',
        '[@media(max-height:800px)]:h-hub-compact [@media(max-height:800px)]:flex-row [@media(max-height:800px)]:items-center [@media(max-height:800px)]:gap-4',
        'forced-colors:border forced-colors:border-[CanvasText] forced-colors:bg-[Canvas]',
      )}
    >
      <span
        aria-hidden="true"
        className="pointer-events-none absolute inset-0 rounded-card bg-control-hover opacity-0 transition-opacity duration-fast not-group-aria-disabled:group-hover:opacity-100"
      />
      <span
        data-hub-tile=""
        className={cx(
          'relative flex size-hub-tile shrink-0 items-center justify-center rounded-sm [@media(max-height:800px)]:size-hub-tile-compact',
          primary ? 'bg-accent text-on-accent' : 'bg-tile text-tile-icon',
          'forced-colors:border forced-colors:border-[CanvasText]',
        )}
      >
        {busy ? <Spinner size={16} /> : <Icon icon={card.icon} size={20} />}
      </span>
      <span className="relative mt-4 flex min-w-0 flex-col [@media(max-height:800px)]:mt-0 [@media(max-height:800px)]:flex-1">
        <span id={titleId} className="truncate text-md font-semibold">
          {t(card.titleKey)}
        </span>
        <span id={hintId} className="mt-1 line-clamp-2 text-sm text-text-muted [@media(max-height:800px)]:sr-only">
          {t(card.hintKey)}
        </span>
      </span>
      {pill !== '' && (
        <span
          className={cx(
            PILL,
            'absolute end-4 top-4 [@media(max-height:800px)]:static [@media(max-height:800px)]:ms-auto',
          )}
        >
          {pill}
        </span>
      )}
    </button>
  );
}

/**
 * The tool grid of the start page (DESIGN 3.54): a `group` of eight cards on `repeat(auto-fill, minmax(200px, 1fr))`, gap 16.
 * One tab stop (roving); arrows move in 2D without wrapping, Home and End jump, Enter and Space activate (a button's own).
 */
export function ToolHub({ openShortcut, openKeyShortcuts, busy, opening, onRun }: ToolHubProps) {
  const t = useT();
  const grid = useRef<HTMLDivElement>(null);
  const [current, setCurrent] = useState(0);

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>): void => {
    const container = grid.current;
    if (container === null || !isOwnEvent(container, event)) return;
    const cards = itemsOf(container, '[data-hub-card]');
    const index = cards.findIndex((card) => card === event.target);
    const target = gridTarget(
      event.key,
      index,
      cards.map((card) => card.getBoundingClientRect()),
    );
    if (target === null) return;
    event.preventDefault();
    cards[target]?.focus();
  };

  return (
    <div
      ref={grid}
      role="group"
      aria-label={t('hub.tools')}
      onKeyDown={onKeyDown}
      className="grid grid-cols-[repeat(auto-fill,minmax(var(--hub-card-min),1fr))] gap-4"
    >
      {HUB_CARDS.map((card, index) => (
        <CardView
          key={card.id}
          card={card}
          busy={busy === card.id}
          disabled={opening || busy !== null}
          tabStop={index === current}
          shortcut={openShortcut}
          keyShortcuts={openKeyShortcuts}
          onRun={onRun}
          onFocus={() => setCurrent(index)}
        />
      ))}
    </div>
  );
}
