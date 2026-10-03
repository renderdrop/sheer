import { FileText, FileX, X } from 'lucide-react';
import { useCallback, useEffect, useState, type KeyboardEvent } from 'react';

import {
  listRecents,
  locateRecent,
  openRecent,
  removeRecent,
  restoreRecent,
  type RecentEntry,
} from '../../api/recents';
import { toAppError } from '../../api/errors';
import { Button, Icon, IconButton } from '../../components';
import { cx } from '../../components/cx';
import { useLocale, useT } from '../../i18n';
import type { Locale } from '../../i18n';
import { useUi } from '../../stores/ui';
import { setPendingSource } from '../viewer/openTransition';
import { adoptOpenOutcomes } from '../viewer/useViewer';
import type { RecentRow } from './EmptyState';

/** The most rows the empty state shows (DESIGN 3.11); the backend keeps up to 50. */
export const MAX_RECENT_ROWS = 8;

/** Between the folder and the age on a row's meta line (punctuation, the same in every language). */
const META_SEPARATOR = ' · ';

const UNITS: readonly (readonly [Intl.RelativeTimeFormatUnit, number])[] = [
  ['year', 31_536_000],
  ['month', 2_592_000],
  ['day', 86_400],
  ['hour', 3600],
  ['minute', 60],
];

/** "2 hours ago" in the locale; empty when the time is unknown (0) or in the future of this clock. */
export function formatAge(lastOpened: number, nowSeconds: number, locale: Locale): string {
  if (lastOpened <= 0) return '';
  const format = new Intl.RelativeTimeFormat(locale, { numeric: 'auto' });
  const elapsed = Math.max(0, nowSeconds - lastOpened);
  for (const [unit, seconds] of UNITS) {
    if (elapsed >= seconds) return format.format(-Math.floor(elapsed / seconds), unit);
  }
  return format.format(0, 'second');
}

export interface Recents {
  rows: readonly RecentRow[];
  clear: () => void;
}

/** The recent files list of the empty state: loaded when it mounts, with the actions of its rows. Failures leave the list empty. */
export function useRecents(): Recents {
  const t = useT();
  const locale = useLocale();
  const [entries, setEntries] = useState<readonly RecentEntry[]>([]);

  const refresh = useCallback(() => {
    listRecents().then(setEntries, () => setEntries([]));
  }, []);
  useEffect(refresh, [refresh]);

  const toast = useCallback(
    (message: string, ids: readonly number[]) => {
      useUi.getState().showToast({
        message,
        action: {
          label: t('toast.undo'),
          // Put back in the reverse of the order they went, so every one lands where it was.
          run: () => {
            let chain: Promise<unknown> = Promise.resolve();
            for (const id of [...ids].reverse()) chain = chain.then(() => restoreRecent(id)).catch(() => undefined);
            void chain.then(refresh);
          },
        },
      });
    },
    [refresh, t],
  );

  const remove = useCallback(
    (entry: RecentEntry) => {
      setEntries((current) => current.filter((other) => other.id !== entry.id));
      removeRecent(entry.id).then(
        () =>
          toast(
            t('emptyState.recentRemoved', {
              name: entry.displayName === '' ? t('status.untitled') : entry.displayName,
            }),
            [entry.id],
          ),
        () => refresh(),
      );
    },
    [refresh, t, toast],
  );

  /** Lets the user find a file that moved; the entry then points to it, and the list is read again. */
  const locate = useCallback(
    (entry: RecentEntry) => {
      locateRecent(entry.id).then(
        () => refresh(),
        (caught: unknown) => {
          useUi.getState().showBanner(toAppError(caught));
          refresh();
        },
      );
    },
    [refresh],
  );

  const open = useCallback(
    (entry: RecentEntry, tile?: Element | null) => {
      // A file that is gone cannot be opened; its Locate button is the one way to find it (DESIGN 3.11), so the row does nothing.
      if (entry.missing) return;
      // The row's tile becomes the page (MOTION 4.6): its rect is the clone's source.
      if (tile !== null && tile !== undefined) {
        const box = tile.getBoundingClientRect();
        if (box.width > 0 && box.height > 0) {
          setPendingSource({
            kind: 'tile',
            rect: { left: box.left, top: box.top, width: box.width, height: box.height },
          });
        }
      }
      openRecent(entry.id).then(
        (outcome) => {
          adoptOpenOutcomes([outcome]);
          // A file that is gone is marked, and the other rows may have moved.
          if (outcome.type !== 'opened') refresh();
        },
        (caught: unknown) => {
          useUi.getState().showBanner(toAppError(caught));
          refresh();
        },
      );
    },
    [refresh, locate],
  );

  // The age is read when the list is shown, not on every render.
  const [now] = useState(() => Math.floor(Date.now() / 1000));
  const rows = entries.slice(0, MAX_RECENT_ROWS).map((entry): RecentRow => {
    const name = entry.displayName === '' ? t('status.untitled') : entry.displayName;
    const age = entry.missing ? t('emptyState.recentMissing') : formatAge(entry.lastOpened, now, locale);
    const meta = [entry.folder, age].filter((part) => part !== '').join(META_SEPARATOR);
    const onKeyDown = (event: KeyboardEvent<HTMLButtonElement>) => {
      if (event.key === 'Delete') {
        event.preventDefault();
        remove(entry);
      }
    };
    return {
      id: String(entry.id),
      content: (
        <div className="group/recent flex h-7 items-center gap-1 rounded-button p-1 hover:bg-control-hover focus-within:bg-control-hover">
          <button
            type="button"
            data-recent-open=""
            aria-disabled={entry.missing || undefined}
            onClick={(event) => open(entry, event.currentTarget.querySelector('[data-recent-tile]'))}
            onKeyDown={onKeyDown}
            className="flex h-full min-w-0 flex-1 cursor-pointer items-center gap-1 rounded-sm text-start"
          >
            <span
              data-recent-tile=""
              className="flex h-5 w-4 shrink-0 items-center justify-center rounded-xs bg-tile text-tile-icon"
            >
              <Icon icon={entry.missing ? FileX : FileText} className={cx(entry.missing && 'text-warning-icon')} />
            </span>
            <span className="flex min-w-0 flex-1 flex-col">
              <span className="truncate text-md">{name}</span>
              {meta !== '' && <span className="truncate text-sm text-text-muted">{meta}</span>}
            </span>
          </button>
          {entry.missing && (
            <Button
              variant="ghost"
              size="sm"
              aria-label={t('emptyState.recentLocateLabel', { name })}
              onClick={() => locate(entry)}
            >
              {t('emptyState.recentLocate')}
            </Button>
          )}
          <span className="opacity-0 group-focus-within/recent:opacity-100 group-hover/recent:opacity-100">
            <IconButton
              size="sm"
              icon={X}
              label={t('emptyState.recentRemove', { name })}
              tabIndex={-1}
              onClick={() => remove(entry)}
            />
          </span>
        </div>
      ),
    };
  });

  const clear = useCallback(() => {
    const all = entries;
    setEntries([]);
    // One after the other, so the order they went is the order Undo reverses. Only the ones that really went can be put back.
    const removed: number[] = [];
    let chain: Promise<unknown> = Promise.resolve();
    for (const entry of all) {
      chain = chain
        .then(() => removeRecent(entry.id))
        .then(() => {
          removed.push(entry.id);
        })
        .catch(() => undefined);
    }
    void chain.then(() => {
      if (removed.length > 0) toast(t('emptyState.recentCleared'), removed);
      // A row whose removal failed is still in the list.
      if (removed.length < all.length) refresh();
    });
  }, [entries, t, toast, refresh]);

  return { rows, clear };
}
