import { parseChangeSet, type ChangeSet } from './annotations';
import { call } from './call';
import { toAppError } from './errors';

/**
 * Password protection and permissions (ARCHITECTURE section 5, "Edit and protect"; ADR-047 section 4;
 * src-tauri/src/commands/protect.rs). A change is staged as one undo step and written by the next save (always a full rewrite, AES-256).
 * The passwords reach the backend once and never come back; the caller clears its password fields after the call.
 */

export type Permission = 'print' | 'copy' | 'edit';
export const PERMISSIONS = ['print', 'copy', 'edit'] as const satisfies readonly Permission[];

export type ProtectionMethod = 'none' | 'rc4' | 'aes128' | 'aes256' | 'unknown';
export type ProtectionPending = 'none' | 'protect' | 'remove';

/**
 * What to stage. A restriction (an `allow` without everything) needs a `permissionsPassword` that differs from the `openPassword`
 * (`invalid_argument` `ownerPassword`); passwords are 1 to 127 bytes (`invalid_argument` `password`).
 */
export interface ProtectOptions {
  openPassword: string | null;
  permissionsPassword: string | null;
  allow: readonly Permission[];
}

export interface ProtectionInfo {
  encrypted: boolean;
  method: ProtectionMethod;
  /** The document was opened with owner rights, or its permissions are unrestricted. */
  ownerRights: boolean;
  allow: readonly Permission[];
  pending: ProtectionPending;
}

const METHODS: ReadonlySet<unknown> = new Set<ProtectionMethod>(['none', 'rc4', 'aes128', 'aes256', 'unknown']);
const PENDING: ReadonlySet<unknown> = new Set<ProtectionPending>(['none', 'protect', 'remove']);
const PERMISSION_SET: ReadonlySet<unknown> = new Set<Permission>(PERMISSIONS);

/** Validates the answer of `get_protection`; `null` if it is not a `ProtectionInfo`. Extra keys are dropped. */
export function parseProtectionInfo(value: unknown): ProtectionInfo | null {
  if (typeof value !== 'object' || value === null) return null;
  const { encrypted, method, ownerRights, allow, pending } = value as Record<string, unknown>;
  if (
    typeof encrypted !== 'boolean' ||
    !METHODS.has(method) ||
    typeof ownerRights !== 'boolean' ||
    !Array.isArray(allow) ||
    allow.length > PERMISSIONS.length ||
    !(allow as unknown[]).every((p) => PERMISSION_SET.has(p)) ||
    !PENDING.has(pending)
  )
    return null;
  return {
    encrypted,
    method: method as ProtectionMethod,
    ownerRights,
    allow: allow as Permission[],
    pending: pending as ProtectionPending,
  };
}

/** How the document is protected now, and what is staged. */
export async function getProtection(docId: number): Promise<ProtectionInfo> {
  const info = parseProtectionInfo(await call<unknown>('get_protection', { docId }));
  if (info === null) throw toAppError(null);
  return info;
}

/** Stages a password and permissions as one undo step (`protect.set`); `changes.doc` has `protection`. */
export async function stageProtection(docId: number, opts: ProtectOptions): Promise<ChangeSet> {
  const changes = parseChangeSet(await call<unknown>('stage_protection', { docId, opts }));
  if (changes === null) throw toAppError(null);
  return changes;
}

/**
 * Stages the removal of the protection as one undo step (`protect.remove`). Owner rights are checked now: a wrong or missing
 * permissions password is `password_required`.
 */
export async function stageUnprotection(docId: number, permissionsPassword?: string | null): Promise<ChangeSet> {
  const changes = parseChangeSet(
    await call<unknown>('stage_unprotection', { docId, permissionsPassword: permissionsPassword ?? null }),
  );
  if (changes === null) throw toAppError(null);
  return changes;
}
