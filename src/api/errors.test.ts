import { describe, expect, it } from 'vitest';

import { ERROR_CODES, toAppError } from './errors';
import { strings } from '../strings';

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
  it('has a message for every code', () => {
    for (const code of ERROR_CODES) {
      expect(strings.error({ code, key: `error.${code}`, retryable: false }).length).toBeGreaterThan(0);
    }
  });

  it('prefers the specific message for a code with params', () => {
    const tooLarge = strings.error({
      code: 'limit_exceeded',
      key: 'error.limit_exceeded',
      retryable: false,
      params: { what: 'pixels' },
    });
    const tooMany = strings.error({
      code: 'limit_exceeded',
      key: 'error.limit_exceeded',
      retryable: false,
      params: { what: 'documents' },
    });
    expect(tooLarge).toMatch(/too large/);
    expect(tooMany).toMatch(/Too many documents/);
    // An unknown `what` falls back to the generic text for the code.
    expect(
      strings.error({ code: 'limit_exceeded', key: 'error.limit_exceeded', retryable: false, params: { what: 'x' } }),
    ).toBe('A size or count limit was reached.');
  });
});
