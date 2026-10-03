import { describe, expect, it } from 'vitest';

import { PERMISSIONS } from '../../api/protection';
import { isValid, passwordStrength, validateProtect, type ProtectForm } from './rules';

const base: ProtectForm = {
  requireOpen: false,
  password: '',
  confirm: '',
  allow: PERMISSIONS,
  permPassword: '',
  permConfirm: '',
};

describe('passwordStrength', () => {
  it('follows length and character classes', () => {
    expect(passwordStrength('')).toEqual({ level: 0, word: 'weak' });
    expect(passwordStrength('abc').word).toBe('weak');
    expect(passwordStrength('abcdefgh').word).toBe('fair');
    expect(passwordStrength('abcdefghijkl').word).toBe('good');
    expect(passwordStrength('Abcdef1!').word).toBe('good');
    expect(passwordStrength('Abcdefghij1!').word).toBe('strong');
    expect(passwordStrength('abcdefghijklmnop').word).toBe('strong');
  });
});

describe('validateProtect', () => {
  it('has nothing to apply without a password or a restriction', () => {
    expect(isValid(validateProtect(base))).toBe(false);
    expect(validateProtect(base).nothing).toBe(true);
  });

  it('needs a matching open password of at most 127 bytes', () => {
    const on = { ...base, requireOpen: true };
    expect(validateProtect(on).open).toBe('empty');
    expect(validateProtect({ ...on, password: 'a', confirm: 'b' }).open).toBe('mismatch');
    expect(isValid(validateProtect({ ...on, password: 'a', confirm: 'a' }))).toBe(true);
    const long = 'é'.repeat(64);
    expect(validateProtect({ ...on, password: long, confirm: long }).open).toBe('length');
  });

  it('needs a different, confirmed permissions password for a restriction', () => {
    const restricted = { ...base, allow: ['print', 'copy'] as const };
    expect(validateProtect(restricted).perm).toBe('empty');
    expect(isValid(validateProtect({ ...restricted, permPassword: 'x', permConfirm: 'x' }))).toBe(true);
    const both = { ...restricted, requireOpen: true, password: 'x', confirm: 'x', permPassword: 'x', permConfirm: 'x' };
    expect(validateProtect(both).same).toBe(true);
    expect(isValid(validateProtect(both))).toBe(false);
    expect(isValid(validateProtect({ ...both, permPassword: 'y', permConfirm: 'y' }))).toBe(true);
  });
});
