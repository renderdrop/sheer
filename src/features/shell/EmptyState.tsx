import { useEffect, useState, type ReactNode } from 'react';

import logoUrl from '../../../assets/brand/logo.svg';
import { Button } from '../../components';
import { SELECTED_FORCED_COLORS } from '../../components/controlStyles';
import { cx } from '../../components/cx';
import { useT } from '../../i18n';

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
  /**
   * A file is dragged over the window: the card takes the selected look (fill and a 2 px accent ring) and the title says
   * "Drop to open". Visual only: the drop itself is handled by Rust (M1), the webview never sees a dropped file or its path.
   */
  dropActive?: boolean;
  /** The recent files, at most 8 (DESIGN 3.11). Empty until the recents list lands (M1). */
  recents?: readonly RecentRow[];
}

/**
 * The empty state (DESIGN 3.11), shown while no document is open: a centred column, at most 560 wide.
 *
 * 1. The logo slot (ADR-020): the full logo at 160 px floating in a 184 px row of its own, decorative.
 * 2. The drop card, 24 below: G1, radius 24, padding 40, "Open a PDF", the hint, and the primary large "Open…" button
 *    with the shortcut as a pill badge (no icon tile: the logo replaces it). Initial focus is on that button, the keyboard path (dropping is
 *    pointer-only).
 * 3. Recent files, 32 px below: a heading, then the rows, or a placeholder while there are none (until the recents list
 *    lands, M1). The footer "Recent files are stored only on this device." belongs to the rows and is left out with
 *    them: a note about a list that is not there would only say that something is stored.
 */
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

/** The logo slot: nothing else sits in it, so the 8 px float stays inside. Decorative, never a tab stop. */
function LogoSlot() {
  const paused = usePageHidden() ? '' : undefined;
  return (
    <div aria-hidden="true" data-logo-slot="" className="pointer-events-none relative h-logo-slot w-full shrink-0">
      <div className="absolute inset-x-0 bottom-0-5 flex justify-center">
        <div data-paused={paused} className="logo-ground" />
      </div>
      <div className="absolute inset-x-0 top-1 flex justify-center">
        <img
          src={logoUrl}
          alt=""
          draggable={false}
          data-paused={paused}
          className="logo-float size-logo-hero select-none"
        />
      </div>
    </div>
  );
}

export function EmptyState({
  openShortcut,
  openKeyShortcuts,
  opening,
  onOpen,
  dropActive = false,
  recents = [],
}: EmptyStateProps) {
  const t = useT();
  return (
    <main className="m-auto flex w-full max-w-empty-max flex-col py-5">
      <LogoSlot />
      <section
        data-drop-zone=""
        data-drop-active={dropActive ? 'true' : undefined}
        className="glass-1 relative mt-3 flex flex-col items-center gap-1 rounded-card p-5 text-center"
      >
        {dropActive && (
          // The drag-over look: the selected fill and a 2 px inset accent ring over the glass (DESIGN 3.0, 3.11).
          <span
            aria-hidden="true"
            className={cx(
              'pointer-events-none absolute inset-0 rounded-card bg-selected inset-ring-2 inset-ring-accent',
              SELECTED_FORCED_COLORS,
            )}
          />
        )}
        <h1 className="relative m-0 font-display text-xl">
          {dropActive ? t('canvas.dropToOpen') : t('emptyState.title')}
        </h1>
        <p className="relative m-0 text-text-muted">{t('emptyState.hint')}</p>
        <div className="relative mt-2 flex items-center gap-1">
          <Button
            variant="primary"
            size="lg"
            autoFocus
            disabled={opening}
            focusableWhenDisabled
            aria-keyshortcuts={openKeyShortcuts}
            onClick={onOpen}
          >
            {opening ? t('action.opening') : t('action.open')}
          </Button>
          {openShortcut !== '' && (
            <span className="inline-flex h-pill items-center rounded-pill bg-tile px-1 text-xs text-tile-icon">
              {openShortcut}
            </span>
          )}
        </div>
      </section>
      <section aria-labelledby="recent-heading" className="mt-4 flex flex-col gap-1">
        <h2 id="recent-heading" className="m-0 text-sm font-semibold text-text-muted">
          {t('emptyState.recent')}
        </h2>
        {recents.length === 0 ? (
          <p className="m-0 rounded-button p-1 text-sm text-text-muted">{t('emptyState.recentPlaceholder')}</p>
        ) : (
          <>
            <ul className="m-0 flex list-none flex-col gap-0-5 p-0">
              {recents.map((row) => (
                <li key={row.id}>{row.content}</li>
              ))}
            </ul>
            <p className="m-0 text-sm text-text-muted">{t('emptyState.recentPrivacy')}</p>
          </>
        )}
      </section>
    </main>
  );
}
