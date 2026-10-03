import { FileText, FileX, X } from 'lucide-react';
import { useCallback, useEffect, useState, type KeyboardEvent } from 'react';

import { listRecents, openRecent, removeRecent, type RecentEntry } from '../../api/recents';
import { toAppError } from '../../api/errors';
import { Icon, IconButton } from '../../components';
import { cx } from '../../components/cx';
import { useLocale, useT } from '../../i18n';
import type { Locale } from '../../i18n';
import { useUi } from '../../stores/ui';
import { adoptOpenOutcomes } from '../viewer/useViewer';
import type { RecentRow } from './EmptyState';

/** The most rows the empty state shows (DESIGN 3.11); the backend keeps up to 50. */
export const MAX_RECENT_ROWS = 8;

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

  const remove = useCallback((id: number) => {
    setEntries((current) => current.filter((entry) => entry.id !== id));
    removeRecent(id).catch(() => undefined);
  }, []);

  const open = useCallback(
    (entry: RecentEntry) => {
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
    [refresh],
  );

  // The age is read when the list is shown, not on every render.
  const [now] = useState(() => Math.floor(Date.now() / 1000));
  const rows = entries.slice(0, MAX_RECENT_ROWS).map((entry): RecentRow => {
    const name = entry.displayName === '' ? t('status.untitled') : entry.displayName;
    const age = entry.missing ? t('emptyState.recentMissing') : formatAge(entry.lastOpened, now, locale);
    const onKeyDown = (event: KeyboardEvent<HTMLButtonElement>) => {
      if (event.key === 'Delete') {
        event.preventDefault();
        remove(entry.id);
      }
    };
    return {
      id: String(entry.id),
      content: (
        <div className="group/recent flex h-7 items-center gap-1 rounded-button p-1 hover:bg-control-hover focus-within:bg-control-hover">
          <button
            type="button"
            data-recent-open=""
            onClick={() => open(entry)}
            onKeyDown={onKeyDown}
            className="flex h-full min-w-0 flex-1 cursor-pointer items-center gap-1 rounded-sm text-start"
          >
            <span className="flex h-5 w-4 shrink-0 items-center justify-center rounded-xs bg-tile text-tile-icon">
              <Icon icon={entry.missing ? FileX : FileText} className={cx(entry.missing && 'text-warning-icon')} />
            </span>
            <span className="flex min-w-0 flex-1 flex-col">
              <span className="truncate text-md">{name}</span>
              {age !== '' && <span className="truncate text-sm text-text-muted">{age}</span>}
            </span>
          </button>
          <span className="opacity-0 group-focus-within/recent:opacity-100 group-hover/recent:opacity-100">
            <IconButton
              size="sm"
              icon={X}
              label={t('emptyState.recentRemove', { name })}
              tabIndex={-1}
              onClick={() => remove(entry.id)}
            />
          </span>
        </div>
      ),
    };
  });

  const clear = useCallback(() => {
    const all = entries;
    setEntries([]);
    for (const entry of all) removeRecent(entry.id).catch(() => undefined);
  }, [entries]);

  return { rows, clear };
}
