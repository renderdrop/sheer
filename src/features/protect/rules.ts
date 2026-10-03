import { PERMISSIONS, type Permission } from '../../api/protection';

/** The backend limit of a password in UTF-8 bytes (`invalid_argument` `password`). */
export const MAX_PASSWORD_BYTES = 127;

/** UTF-8 length, the unit of the backend limit. */
export const byteLength = (text: string): number => new TextEncoder().encode(text).length;

export type Strength = 'weak' | 'fair' | 'good' | 'strong';

/** Segments filled in the meter (0 for an empty password) and the word that names the state (DESIGN 3.39). A hint, never a block. */
export function passwordStrength(password: string): { level: 0 | 1 | 2 | 3 | 4; word: Strength } {
  const length = [...password].length;
  const classes = [/[a-z]/, /[A-Z]/, /[0-9]/, /[^a-zA-Z0-9]/].filter((re) => re.test(password)).length;
  if (length >= 16 || (length >= 12 && classes >= 3)) return { level: 4, word: 'strong' };
  if (length >= 12 || (length >= 8 && classes >= 3)) return { level: 3, word: 'good' };
  if (length >= 8) return { level: 2, word: 'fair' };
  return { level: password === '' ? 0 : 1, word: 'weak' };
}

export interface ProtectForm {
  requireOpen: boolean;
  password: string;
  confirm: string;
  allow: readonly Permission[];
  permPassword: string;
  permConfirm: string;
}

type PasswordProblem = 'empty' | 'length' | 'mismatch' | null;

export interface ProtectProblems {
  /** Open password empty, too long or not confirmed. */
  open: PasswordProblem;
  perm: PasswordProblem;
  /** The permissions password equals the open password. */
  same: boolean;
  /** Nothing to apply: no open password and no restriction. */
  nothing: boolean;
}

/** Whether a permission is switched off, which needs a permissions password. */
export const isRestricted = (allow: readonly Permission[]): boolean => PERMISSIONS.some((p) => !allow.includes(p));

function passwordProblem(password: string, confirm: string): PasswordProblem {
  if (password === '') return 'empty';
  if (byteLength(password) > MAX_PASSWORD_BYTES) return 'length';
  return password === confirm ? null : 'mismatch';
}

/** What keeps the form from being applied; all `null` / `false` means it is valid. */
export function validateProtect(form: ProtectForm): ProtectProblems {
  const restricted = isRestricted(form.allow);
  return {
    open: form.requireOpen ? passwordProblem(form.password, form.confirm) : null,
    perm: restricted ? passwordProblem(form.permPassword, form.permConfirm) : null,
    same: restricted && form.requireOpen && form.permPassword !== '' && form.permPassword === form.password,
    nothing: !form.requireOpen && !restricted,
  };
}

export const isValid = (problems: ProtectProblems): boolean =>
  problems.open === null && problems.perm === null && !problems.same && !problems.nothing;
