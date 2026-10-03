import { create } from 'zustand';

import {
  clearSignatureLibrary,
  deleteSignature,
  listSignatures,
  renameSignature,
  type LibraryItem,
  type LibraryStatus,
  type SignatureRole,
} from '../../../api/library';
import { toAppError, type AppError } from '../../../api/errors';
import { closeSettings } from '../../settings/state';

/** How long a deleted row offers Undo before the delete is sent (ADR-042, DESIGN 3.35). */
export const UNDO_MS = 8000;
/** Longest name the library dialog accepts (DESIGN 3.35); the backend allows more. */
export const NAME_MAX = 40;

/** What the other signature packages hang on the dialog: creating an entry (the Add buttons) and placing one (Enter on a row). */
export interface LibraryHandlers {
  /** Opens the create dialog for a kind. Without it the dialog shows no Add buttons. */
  create?: (role: SignatureRole) => void;
  /** Arms the placement of an entry. The dialog closes first. Without it Enter does nothing. */
  place?: (item: LibraryItem) => void;
}

export interface SignatureLibraryState {
  open: boolean;
  status: LibraryStatus;
  items: readonly LibraryItem[];
  /** The list has been asked for at least once since the dialog opened. */
  loaded: boolean;
  error: AppError | null;
  /** Ids that were deleted in the dialog and wait for the end of their Undo window. */
  deleted: ReadonlySet<string>;
  handlers: LibraryHandlers;
}

export const useSignatureLibrary = create<SignatureLibraryState>()(() => ({
  open: false,
  status: 'ready',
  items: [],
  loaded: false,
  error: null,
  deleted: new Set<string>(),
  handlers: {},
}));

const set = useSignatureLibrary.setState;
const get = useSignatureLibrary.getState;
const timers = new Map<string, ReturnType<typeof setTimeout>>();

/** Lets the create and place packages plug into the dialog; `null` removes them. */
export function setLibraryHandlers(handlers: LibraryHandlers | null): void {
  set({ handlers: handlers ?? {} });
}

/** Reads the list from the backend. A failure keeps what is shown and says so. */
export async function refreshLibrary(): Promise<void> {
  try {
    const list = await listSignatures();
    set((state) => ({
      status: list.status,
      items: list.items,
      loaded: true,
      error: null,
      deleted: new Set([...state.deleted].filter((id) => list.items.some((item) => item.id === id))),
    }));
  } catch (caught) {
    set({ loaded: true, error: toAppError(caught) });
  }
}

/** Opens the library dialog (DESIGN 3.35): from the settings popover, the Sign popover's "Manage…" and More. */
export function openSignatureLibrary(): void {
  closeSettings();
  set({ open: true, loaded: false });
  void refreshLibrary();
}

function send(id: string): void {
  const timer = timers.get(id);
  if (timer !== undefined) clearTimeout(timer);
  timers.delete(id);
  if (!get().deleted.has(id)) return;
  deleteSignature(id)
    .then(
      () => undefined,
      (caught: unknown) => {
        const error = toAppError(caught);
        // Already gone is what was wanted; anything else shows again after the next read.
        if (error.code !== 'not_found') set({ error });
      },
    )
    .finally(() => {
      void refreshLibrary();
    });
}

/** Closes the dialog; every delete still waiting for its Undo is sent now ("Closing commits"). */
export function closeSignatureLibrary(): void {
  for (const id of [...timers.keys()]) send(id);
  set({ open: false });
}

/** Deletes an entry with an Undo window: the row turns into a notice, the delete goes out when the window ends. */
export function deleteWithUndo(id: string): void {
  if (get().deleted.has(id)) return;
  set((state) => ({ deleted: new Set(state.deleted).add(id) }));
  timers.set(
    id,
    setTimeout(() => send(id), UNDO_MS),
  );
}

/** Takes a delete back inside its window. */
export function undoDelete(id: string): void {
  const timer = timers.get(id);
  if (timer !== undefined) clearTimeout(timer);
  timers.delete(id);
  set((state) => {
    const deleted = new Set(state.deleted);
    deleted.delete(id);
    return { deleted };
  });
}

/** Renames an entry; the text is trimmed and an empty or unchanged one does nothing. */
export async function renameItem(id: string, text: string): Promise<void> {
  const name = text.trim().slice(0, NAME_MAX);
  const current = get().items.find((item) => item.id === id);
  if (name === '' || current === undefined || current.name === name) return;
  try {
    await renameSignature(id, name);
    set((state) => ({ items: state.items.map((item) => (item.id === id ? { ...item, name } : item)) }));
  } catch (caught) {
    set({ error: toAppError(caught) });
  }
}

/** Forgets everything (the stored file, the key, this session's entries). */
export async function forgetAll(): Promise<void> {
  for (const timer of timers.values()) clearTimeout(timer);
  timers.clear();
  try {
    await clearSignatureLibrary();
    set({ deleted: new Set<string>(), error: null });
  } catch (caught) {
    set({ error: toAppError(caught) });
  }
  await refreshLibrary();
}
