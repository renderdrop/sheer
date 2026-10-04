import { useEffect, useState, type KeyboardEvent, type ReactNode } from 'react';

import logoUrl from '../../../assets/brand/logo.svg';
import { Button } from '../../components';
import { isOwnEvent, itemsOf, rovingTarget } from '../../components/roving';
import { useT } from '../../i18n';
import type { HubCardId } from '../hub/cards';
import { ToolHub } from '../hub/ToolHub';

/** One row of the recent files list (M1 brings the row itself: thumbnail, name, folder and age, remove). */
export interface RecentRow {
  id: string;
  content: ReactNode;
}

export interface EmptyStateProps {
  /** The Open button's key chip, formatted for the platform ("Ctrl+O", "⌘O"). */
  openShortcut: string;
  /** The `aria-keyshortcuts` value of the Open button. */
  openKeyShortcuts: string;
  /** A document is being opened: the button says so and does nothing, but keeps its focus. */
  opening: boolean;
  onOpen: () => void;
  /** The hub card whose dialog or open runs now; Open also shows busy while `opening`. */
  busyCard?: HubCardId | null;
  /** A card other than Open was activated (Open is `onOpen`). */
  onRunCard?: (card: HubCardId) => void;
  /** The recent files, at most 8 (DESIGN 3.11). Empty until the recents list lands (M1). */
  recents?: readonly RecentRow[];
  /** Empties the recent files list (the ghost Clear button beside the heading). */
  onClearRecents?: () => void;
}

/** Up and Down move between the rows of the recent files (roving focus, DESIGN 3.11); Enter and Delete are the rows' own. */
function onRecentsKeyDown(event: KeyboardEvent<HTMLUListElement>): void {
  const list = event.currentTarget;
  if (!isOwnEvent(list, event)) return;
  const rows = itemsOf(list, '[data-recent-open]');
  const current = rows.findIndex((row) => row === event.target);
  const target = rovingTarget(event.key, current, rows.length, { orientation: 'vertical', wrap: false });
  if (target === null) return;
  event.preventDefault();
  rows[target]?.focus();
}

/** True while the page is hidden: the float pauses then (DESIGN 1.10). */
function usePageHidden(): boolean {
  const [hidden, setHidden] = useState(() => document.hidden);
  useEffect(() => {
    const update = () => setHidden(document.hidden);
    document.addEventListener('visibilitychange', update);
    return () => document.removeEventListener('visibilitychange', update);
  }, []);
  return hidden;
}

/** The header logo slot (DESIGN 3.54): 64 x 64, the logo 48 floating inside it. Decorative, never a tab stop. */
function LogoSlot() {
  const paused = usePageHidden() ? '' : undefined;
  return (
    <div
      aria-hidden="true"
      data-logo-slot=""
      className="pointer-events-none relative h-logo-hub-slot w-logo-hub-slot shrink-0 overflow-hidden"
    >
      <div className="absolute inset-x-0 bottom-0 flex justify-center">
        <div
          data-paused={paused}
          className="logo-ground [--logo-ground-height:var(--logo-hub-ground-height)] [--logo-ground-width:var(--logo-hub-ground-width)]"
        />
      </div>
      <div className="absolute inset-x-0 top-2 flex justify-center">
        <img
          src={logoUrl}
          alt=""
          draggable={false}
          data-paused={paused}
          className="logo-float size-logo-hub select-none"
        />
      </div>
    </div>
  );
}

/**
 * The start page (DESIGN 3.54), shown while no document is open: a centred column, at most 880 wide, padding 32.
 *
 * 1. Header: the logo slot, 16, the title. 2. The tool grid, 24 below (`ToolHub`). 3. Recent files, 32 below (DESIGN 3.11 item 3,
 * 3.48 unchanged); the whole section is omitted while there are none. The column scrolls as one region when the window is short.
 */
export function EmptyState({
  openShortcut,
  openKeyShortcuts,
  opening,
  onOpen,
  busyCard = null,
  onRunCard,
  recents = [],
  onClearRecents,
}: EmptyStateProps) {
  const t = useT();
  return (
    <main className="mx-auto my-auto flex w-full max-w-hub-max flex-col p-8">
      <header className="flex items-center gap-4">
        <LogoSlot />
        <h1 className="m-0 font-display text-xl text-text">{t('hub.title')}</h1>
      </header>
      <div className="mt-6">
        <ToolHub
          openShortcut={openShortcut}
          openKeyShortcuts={openKeyShortcuts}
          busy={busyCard ?? (opening ? 'open' : null)}
          opening={opening}
          onRun={(card) => (card === 'open' ? onOpen() : onRunCard?.(card))}
        />
      </div>
      {recents.length > 0 && (
        <section aria-labelledby="recent-heading" className="mt-8 flex flex-col gap-2">
          <div className="flex items-center justify-between">
            <h2 id="recent-heading" className="m-0 text-sm font-semibold text-text-muted">
              {t('emptyState.recent')}
            </h2>
            {onClearRecents !== undefined && (
              <Button variant="ghost" size="sm" onClick={onClearRecents}>
                {t('emptyState.recentClear')}
              </Button>
            )}
          </div>
          <ul
            aria-label={t('emptyState.recentList')}
            onKeyDown={onRecentsKeyDown}
            className="empty-recents m-0 flex list-none flex-col gap-1 p-0"
          >
            {recents.map((row) => (
              <li key={row.id}>{row.content}</li>
            ))}
          </ul>
          <p className="m-0 text-sm text-text-muted">{t('emptyState.recentPrivacy')}</p>
        </section>
      )}
    </main>
  );
}
