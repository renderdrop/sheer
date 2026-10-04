import { call } from './call';
import { toAppError } from './errors';
import { parsePaths, type PathCmd } from './pathcmd';

/**
 * The signature library (src-tauri/src/commands/library.rs, ADR-041 section 7): saved signatures and initials, encrypted in the app
 * data folder with a key in the OS keychain. The UI never sees the file or the key.
 */

export type SignatureRole = 'signature' | 'initials';

/** Most entries per role. */
export const MAX_PER_ROLE = 8;
/** Longest name of an entry, in characters. */
export const MAX_NAME_CHARS = 64;

/**
 * `ready`: stored encrypted. `unavailable`: no keychain, so entries live for this session only. `locked`: the stored file does not
 * open (key gone or changed, file damaged); only `clearSignatureLibrary` gets out.
 */
export type LibraryStatus = 'ready' | 'unavailable' | 'locked';

/** Art on the wire: vector path commands (ADR-051) in a `w` x `h` box, or a PNG (standard base64). */
export type LibraryArt =
  { vector: { w: number; h: number; paths: PathCmd[][] } } | { raster: { w: number; h: number; png: string } };

/** An entry as the list shows it: metadata and, for vector art, a small preview (never the full art). */
export interface LibraryItem {
  /** 32 lowercase hex characters. */
  id: string;
  role: SignatureRole;
  name: string;
  /** Seconds since 1970. */
  created: number;
  /** Width over height of the art. */
  aspect: number;
  kind: 'vector' | 'raster';
  preview: LibraryArt | null;
}

export interface SignatureLibrary {
  status: LibraryStatus;
  items: LibraryItem[];
}

/** The entry as a source to place: the full art. */
export interface LibrarySource {
  id: string;
  role: SignatureRole;
  art: LibraryArt;
}

const ID = /^[0-9a-f]{32}$/;
const STATUSES: readonly string[] = ['ready', 'unavailable', 'locked'];
const ROLES: readonly string[] = ['signature', 'initials'];

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isRole(value: unknown): value is SignatureRole {
  return typeof value === 'string' && ROLES.includes(value);
}

function isUnits(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value > 0 && value <= 1_000_000;
}

/** Validates art; `null` if it is not art. Extra keys are dropped. */
export function parseLibraryArt(value: unknown): LibraryArt | null {
  if (!isObject(value)) return null;
  const { vector, raster } = value;
  if (isObject(vector) && raster === undefined) {
    const { w, h, paths } = vector;
    if (!isUnits(w) || !isUnits(h) || !Array.isArray(paths)) return null;
    const out = parsePaths(paths);
    return out === null ? null : { vector: { w, h, paths: out } };
  }
  if (isObject(raster) && vector === undefined) {
    const { w, h, png } = raster;
    if (!isUnits(w) || !isUnits(h) || typeof png !== 'string' || !/^[A-Za-z0-9+/]+=*$/.test(png)) return null;
    return { raster: { w, h, png } };
  }
  return null;
}

/** Validates one list entry; `null` if it is not one. Extra keys are dropped. */
export function parseLibraryItem(value: unknown): LibraryItem | null {
  if (!isObject(value)) return null;
  const { id, role, name, created, aspect, kind, preview } = value;
  if (
    typeof id !== 'string' ||
    !ID.test(id) ||
    !isRole(role) ||
    typeof name !== 'string' ||
    typeof created !== 'number' ||
    !Number.isSafeInteger(created) ||
    created < 0 ||
    typeof aspect !== 'number' ||
    !Number.isFinite(aspect) ||
    aspect <= 0 ||
    (kind !== 'vector' && kind !== 'raster')
  ) {
    return null;
  }
  const art = preview === null || preview === undefined ? null : parseLibraryArt(preview);
  if (preview !== null && preview !== undefined && art === null) return null;
  return { id, role, name, created, aspect, kind, preview: art };
}

/** Validates the answer of `list_signatures`; `null` if it is not one (more than 8 per role included). */
export function parseSignatureLibrary(value: unknown): SignatureLibrary | null {
  if (!isObject(value)) return null;
  const { status, items } = value;
  if (typeof status !== 'string' || !STATUSES.includes(status) || !Array.isArray(items)) return null;
  const parsed: LibraryItem[] = [];
  for (const item of items as unknown[]) {
    const entry = parseLibraryItem(item);
    if (entry === null) return null;
    parsed.push(entry);
  }
  for (const role of ROLES) {
    if (parsed.filter((entry) => entry.role === role).length > MAX_PER_ROLE) return null;
  }
  return { status: status as LibraryStatus, items: parsed };
}

/** Validates the answer of `get_library_signature`; `null` if it is not one. */
export function parseLibrarySource(value: unknown): LibrarySource | null {
  if (!isObject(value)) return null;
  const { id, role } = value;
  const art = parseLibraryArt(value.art);
  if (typeof id !== 'string' || !ID.test(id) || !isRole(role) || art === null) return null;
  return { id, role, art };
}

/** The saved signatures and initials with the state of the library. A malformed answer is an internal error. */
export async function listSignatures(): Promise<SignatureLibrary> {
  const parsed = parseSignatureLibrary(await call<unknown>('list_signatures'));
  if (parsed === null) throw toAppError(null);
  return parsed;
}

/**
 * Saves art as a new entry. Rejects with `limit_exceeded` at 8 entries of the role, `invalid_argument` (`library`) when the library
 * is locked. Without a keychain the entry lives for this session (check `status` of the list).
 */
export async function saveLibrarySignature(role: SignatureRole, name: string, art: LibraryArt): Promise<LibraryItem> {
  const parsed = parseLibraryItem(await call<unknown>('save_library_signature', { role, name, art }));
  if (parsed === null) throw toAppError(null);
  return parsed;
}

/** Renames an entry; rejects with `not_found` for an id that is not there. */
export function renameSignature(itemId: string, name: string): Promise<void> {
  return call<void>('rename_signature', { itemId, name });
}

/** Deletes an entry; rejects with `not_found` for an id that is not there. */
export function deleteSignature(itemId: string): Promise<void> {
  return call<void>('delete_signature', { itemId });
}

/** The entry with its full art, to place it. */
export async function getLibrarySignature(itemId: string): Promise<LibrarySource> {
  const parsed = parseLibrarySource(await call<unknown>('get_library_signature', { itemId }));
  if (parsed === null) throw toAppError(null);
  return parsed;
}

/** Forgets everything: the stored file, the key and this session's entries. The way out of `locked`. */
export function clearSignatureLibrary(): Promise<void> {
  return call<void>('clear_signature_library');
}
