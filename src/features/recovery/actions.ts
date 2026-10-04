import {
  discardRecovery,
  listRecoveries,
  restoreRecovery,
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

/** Reads the records a crashed session left. Never throws and never blocks: a failure means no banner. */
export async function loadRecoveries(): Promise<void> {
  try {
    useRecovery.getState().setEntries(await listRecoveries());
  } catch {
    useRecovery.getState().setEntries([]);
  }
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

/** Discards that wait for their toast to end: record ids by the toast that carries the undo. */
const pending = new Map<number, readonly RecoveryEntry[]>();
let watching = false;

function finish(rows: readonly RecoveryEntry[]): void {
  for (const row of rows) discardRecovery(row.id).catch(() => undefined);
}

/** A discard becomes final when its toast is gone: ended, replaced by another, or dismissed. */
function watchToasts(): void {
  if (watching) return;
  watching = true;
  useUi.subscribe((state) => {
    for (const [toastId, rows] of pending) {
      if (state.toast?.id !== toastId) {
        pending.delete(toastId);
        finish(rows);
      }
    }
  });
}

/** Hides rows now, offers Undo for 8 s, and deletes the records when the toast ends. */
export function discardRows(rows: readonly RecoveryEntry[]): void {
  if (rows.length === 0) return;
  watchToasts();
  const store = useRecovery.getState();
  store.remove(rows.map((row) => row.id));
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
        for (const [toastId, held] of pending) if (held === rows) pending.delete(toastId);
        useRecovery.getState().restoreRows(rows);
      },
    },
  });
  const toastId = useUi.getState().toast?.id;
  if (toastId !== undefined) pending.set(toastId, rows);
}

export const discardOne = (id: RecoveryId): void => {
  const row = useRecovery.getState().entries.find((entry) => entry.id === id);
  if (row !== undefined) discardRows([row]);
};

export const discardEverything = (): void => discardRows(useRecovery.getState().entries);

/** Test helper: forget pending discards. */
export function resetPending(): void {
  pending.clear();
}
