import { describe, expect, it } from 'vitest';

import { errorText, translators } from '../i18n';
import { catalogs } from '../i18n/catalog';
import { LOCALES } from '../i18n/locale';
import { ERROR_CODES, toAppError, type AppError, type ErrorCode } from './errors';

describe('toAppError', () => {
  it('accepts the backend UiError shape', () => {
    const error = toAppError({
      code: 'limit_exceeded',
      key: 'error.limit_exceeded',
      retryable: false,
      params: { what: 'pixels', limit: 16_777_216 },
    });
    expect(error).toEqual({
      code: 'limit_exceeded',
      key: 'error.limit_exceeded',
      retryable: false,
      params: { what: 'pixels', limit: 16_777_216 },
    });
  });

  it('derives the i18n key from the code and ignores any other key', () => {
    const error = toAppError({ code: 'engine_timeout', key: 'error.anything', retryable: true });
    expect(error.key).toBe('error.engine_timeout');
    expect(error.retryable).toBe(true);
    expect(error.params).toBeUndefined();
  });

  it('maps every known code to itself', () => {
    for (const code of ERROR_CODES) {
      expect(toAppError({ code })).toMatchObject({ code, key: `error.${code}` });
    }
  });

  it('turns anything else into the generic error', () => {
    const generic = { code: 'internal', key: 'error.internal', retryable: false };
    for (const bad of [
      null,
      undefined,
      42,
      'plain string error',
      new Error('C:\\Users\\user\\secret.pdf'),
      { code: 'not_a_real_code' },
      { code: 7 },
      {},
    ]) {
      expect(toAppError(bad)).toEqual(generic);
    }
  });

  it('keeps only well-formed params', () => {
    expect(toAppError({ code: 'invalid_argument', params: { what: 'page' } }).params).toEqual({ what: 'page' });
    // Not a fixed-vocabulary word (could carry a path or markup): dropped.
    for (const what of ['C:\\Users\\x', '../etc/passwd', '<img src=x>', 'Page', '', 'a'.repeat(33), 7]) {
      expect(toAppError({ code: 'invalid_argument', params: { what } }).params).toBeUndefined();
    }
    expect(toAppError({ code: 'limit_exceeded', params: { what: 'pixels', limit: 'many' } }).params).toEqual({
      what: 'pixels',
    });
  });

  it('never exposes text from the rejection', () => {
    const error = toAppError({ code: 'internal', message: 'C:\\Users\\user\\secret.pdf', stack: 'at x (y.js:1)' });
    expect(JSON.stringify(error)).not.toMatch(/secret|stack|Users/);
  });
});

describe('error strings', () => {
  const error = (code: ErrorCode, what?: string): AppError => ({
    code,
    key: `error.${code}`,
    retryable: false,
    ...(what === undefined ? {} : { params: { what } }),
  });

  it('has a message for every code, in every language, and not just the key', () => {
    for (const locale of LOCALES) {
      for (const code of ERROR_CODES) {
        const text = errorText(translators[locale], error(code));
        expect(text.length, `${locale} ${code}`).toBeGreaterThan(0);
        expect(text, `${locale} ${code}`).not.toBe(`error.${code}`);
      }
    }
  });

  it('prefers the specific message for a code with params', () => {
    const t = translators.en;
    expect(errorText(t, error('limit_exceeded', 'pixels'))).toMatch(/too large/);
    expect(errorText(t, error('limit_exceeded', 'documents'))).toMatch(/Too many documents/);
    expect(errorText(t, error('not_found', 'document'))).toBe('This document is no longer open.');
    expect(errorText(translators.de, error('invalid_argument', 'page'))).toBe('Diese Seite existiert nicht.');
    // An unknown `what` falls back to the generic text for the code.
    expect(errorText(t, error('limit_exceeded', 'x'))).toBe('A size or count limit was reached.');
    // `what` is not used to look up anything but the error texts.
    expect(errorText(t, error('internal', 'constructor'))).toBe('Something went wrong.');
    expect(errorText(t, error('internal', 'other'))).toBe('Something went wrong.');
  });

  it('the catalog has no error text for a code or a case that does not exist', () => {
    const codes: ReadonlySet<string> = new Set(ERROR_CODES);
    for (const key of Object.keys(catalogs.en).filter((name) => name.startsWith('error.'))) {
      const [, code] = key.split('.');
      expect(codes.has(code ?? ''), key).toBe(true);
    }
  });
});
