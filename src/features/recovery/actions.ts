import {
  discardRecovery,
  listRecoveries,
  restoreRecovery,
  undoDiscardRecovery,
  type RecoveryEntry,
  type RecoveryId,
} from '../../api/recovery';
import { translators } from '../../i18n';
import { useLocaleStore } from '../../i18n/store';
import { useUi } from '../../stores/ui';
import { adoptOpenOutcomes } from '../viewer/useViewer';
import { useRecovery } from './store';

const tr = () => translators[useLocaleStore.getState().locale];

/** How long a discard can be undone (DESIGN 3.50, ADR-054 section 5): the toast's lifetime with an action. */
export const UNDO_MS = 8000;

/** Ids the banner showed during this session: a later load keeps them even though the backend no longer calls them fresh. */
const shownThisSession = new Set<RecoveryId>();

/**
 * Reads the records a crashed session left. Never throws and never blocks: a failure means no banner. The banner appears only when
 * at least one record is new (not shown by an earlier start, F21.2); records that were shown before stay on disk, unlisted.
 */
export async function loadRecoveries(): Promise<void> {
  try {
    const entries = await listRecoveries();
    const news = entries.some((entry) => entry.fresh !== false);
    if (news) for (const entry of entries) shownThisSession.add(entry.id);
    const visible = entries.filter((entry) => shownThisSession.has(entry.id));
    useRecovery.getState().setEntries(visible);
  } catch {
    useRecovery.getState().setEntries([]);
  }
}

/**
 * File > Restore… (F22.4, ADR-146): opens the recovery list with every record on disk, also those postponed with "Decide later"
 * or shown by an earlier start. It only reads and shows; whether a record counts as new stays the banner's business. With none,
 * a toast says so.
 */
export async function openRestoreList(): Promise<void> {
  const entries: readonly RecoveryEntry[] = await listRecoveries().catch(() => []);
  if (entries.length === 0) {
    useUi.getState().showToast({ message: tr()('recover.none') });
    return;
  }
  for (const entry of entries) shownThisSession.add(entry.id);
  useRecovery.getState().setEntries(entries);
}

/** Restores record `id`; resolves to whether the document opened. A failure keeps the row, with its alert. */
export async function restoreOne(entry: RecoveryEntry): Promise<boolean> {
  const store = useRecovery.getState();
  store.setFailed(entry.id, false);
  store.setBusy(entry.id, true);
  try {
    const outcome = await restoreRecovery(entry.id);
    if (outcome.type === 'openFailed') throw outcome.error;
    adoptOpenOutcomes([outcome]);
    useRecovery.getState().remove([entry.id]);
    if (outcome.type === 'opened') {
      const name = outcome.document.displayName || entry.displayName;
      useUi.getState().showToast({ message: tr()('recover.restored', { name }) });
    }
    return true;
  } catch {
    useRecovery.getState().setFailed(entry.id, true);
    return false;
  } finally {
    useRecovery.getState().setBusy(entry.id, false);
  }
}

export async function restoreAll(): Promise<void> {
  for (const entry of useRecovery.getState().entries) await restoreOne(entry);
}

/**
 * Hides rows and tells the backend at once (it never lists them again, whatever happens to the window, F21.2), and offers Undo for
 * 8 s: Undo asks the backend to list the records again. The backend deletes what stays discarded at exit or the next start.
 */
export function discardRows(rows: readonly RecoveryEntry[]): void {
  if (rows.length === 0) return;
  const store = useRecovery.getState();
  store.remove(rows.map((row) => row.id));
  void Promise.all(rows.map((row) => discardRecovery(row.id).catch(() => undefined)));
  const [first] = rows;
  const message =
    rows.length === 1 && first !== undefined
      ? tr()('recover.discarded', { name: first.displayName })
      : tr()('recover.discardedAll', { count: rows.length });
  useUi.getState().showToast({
    message,
    action: {
      label: tr()('recover.undo'),
      run: () => {
        void Promise.all(rows.map((row) => undoDiscardRecovery(row.id).catch(() => undefined)));
        useRecovery.getState().restoreRows(rows);
      },
    },
  });
}

export const discardOne = (id: RecoveryId): void => {
  const row = useRecovery.getState().entries.find((entry) => entry.id === id);
  if (row !== undefined) discardRows([row]);
};

export const discardEverything = (): void => discardRows(useRecovery.getState().entries);

/** Test helper: forget what this session showed. */
export function resetPending(): void {
  shownThisSession.clear();
}
