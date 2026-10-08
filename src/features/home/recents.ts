import { useCallback, useEffect, useState } from 'react';

import {
  listRecents,
  openRecent,
  removeRecent,
  restoreRecent,
  revealRecent,
  setRecentStarred,
  type RecentEntry,
} from '../../api/recents';
import { toAppError } from '../../api/errors';
import { useT } from '../../i18n';
import type { Locale } from '../../i18n';
import { useUi } from '../../stores/ui';
import { setPendingSource } from '../viewer/openTransition';
import { adoptOpenOutcomes } from '../viewer/useViewer';

const UNITS: readonly (readonly [Intl.RelativeTimeFormatUnit, number])[] = [
  ['year', 31_536_000],
  ['month', 2_592_000],
  ['day', 86_400],
  ['hour', 3600],
  ['minute', 60],
];

/** "2 hours ago" in the locale; empty when the time is unknown (0). */
export function formatAge(lastOpened: number, nowSeconds: number, locale: Locale): string {
  if (lastOpened <= 0) return '';
  const format = new Intl.RelativeTimeFormat(locale, { numeric: 'auto' });
  const elapsed = Math.max(0, nowSeconds - lastOpened);
  for (const [unit, seconds] of UNITS) {
    if (elapsed >= seconds) return format.format(-Math.floor(elapsed / seconds), unit);
  }
  return format.format(0, 'second');
}

/** Home's Recent section shows this many rows of cards; the rest is behind "Show all". */
export const HOME_RECENT_ROWS = 2;

/** The cards shown for `columns` columns: two full rows, or all of them once expanded. */
export function visibleRecents<T>(entries: readonly T[], columns: number, expanded: boolean): readonly T[] {
  return expanded ? entries : entries.slice(0, Math.max(1, columns) * HOME_RECENT_ROWS);
}

/** The entries whose file is not open as a tab. The frontend holds no paths, so the display name is the match. */
export function withoutOpen(entries: readonly RecentEntry[], openNames: readonly string[]): readonly RecentEntry[] {
  if (openNames.length === 0) return entries;
  const open = new Set(openNames);
  return entries.filter((entry) => !open.has(entry.displayName));
}

/** The entries whose display name contains `query` (case-insensitive); all of them for an empty query. */
export function filterByName(entries: readonly RecentEntry[], query: string): readonly RecentEntry[] {
  const needle = query.trim().toLocaleLowerCase();
  if (needle === '') return entries;
  return entries.filter((entry) => entry.displayName.toLocaleLowerCase().includes(needle));
}

export interface HomeRecents {
  /** `false` until the first answer of the backend (an answer of "none" is not "unknown"). */
  loaded: boolean;
  entries: readonly RecentEntry[];
  /** Seconds since 1970 when the list was read, for the relative times. */
  now: number;
  open: (entry: RecentEntry, tile?: Element | null) => void;
  toggleStar: (entry: RecentEntry) => void;
  reveal: (entry: RecentEntry) => void;
  remove: (entry: RecentEntry) => void;
}

/** The list the last visit ended with: the next visit starts from it, so Home does not flash its empty state before the first answer. */
let lastList: readonly RecentEntry[] | null = null;

/** The recent files of Home: loaded when it mounts, with the actions of their cards. Failures leave the list empty. */
export function useHomeRecents(): HomeRecents {
  const t = useT();
  const [entries, setEntries] = useState<readonly RecentEntry[]>(lastList ?? []);
  const [loaded, setLoaded] = useState(lastList !== null);
  const [now, setNow] = useState(() => Math.floor(Date.now() / 1000));

  const refresh = useCallback(() => {
    listRecents().then(
      (list) => {
        lastList = list;
        setEntries(list);
        setNow(Math.floor(Date.now() / 1000));
        setLoaded(true);
      },
      () => {
        lastList = [];
        setEntries([]);
        setLoaded(true);
      },
    );
  }, []);
  useEffect(refresh, [refresh]);

  const nameOf = useCallback(
    (entry: RecentEntry) => (entry.displayName === '' ? t('status.untitled') : entry.displayName),
    [t],
  );

  const remove = useCallback(
    (entry: RecentEntry) => {
      setEntries((current) => current.filter((other) => other.id !== entry.id));
      removeRecent(entry.id).then(
        () =>
          useUi.getState().showToast({
            message: t('emptyState.recentRemoved', { name: nameOf(entry) }),
            action: {
              label: t('toast.undo'),
              run: () => void restoreRecent(entry.id).then(refresh, refresh),
            },
          }),
        () => refresh(),
      );
    },
    [nameOf, refresh, t],
  );

  const open = useCallback(
    (entry: RecentEntry, tile?: Element | null) => {
      if (entry.missing) {
        useUi.getState().showToast({ message: t('home.missing', { name: nameOf(entry) }) });
        return;
      }
      // The card's tile becomes the page (MOTION 4.6): its rect is the clone's source.
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
          if (outcome.type !== 'opened') refresh();
        },
        (caught: unknown) => {
          useUi.getState().showBanner(toAppError(caught));
          refresh();
        },
      );
    },
    [nameOf, refresh, t],
  );

  const toggleStar = useCallback(
    (entry: RecentEntry) => {
      const starred = !entry.starred;
      setRecentStarred(entry.id, starred).then(
        () => setEntries((current) => current.map((other) => (other.id === entry.id ? { ...other, starred } : other))),
        // The cap of marked files is a limit, not a failure: a quiet note.
        () => {
          useUi.getState().showToast({ message: t('home.starRefused') });
          refresh();
        },
      );
    },
    [refresh, t],
  );

  const reveal = useCallback(
    (entry: RecentEntry) => {
      revealRecent(entry.id).catch((caught: unknown) => {
        useUi.getState().showBanner(toAppError(caught));
        refresh();
      });
    },
    [refresh],
  );

  return { loaded, entries, now, open, toggleStar, reveal, remove };
}
