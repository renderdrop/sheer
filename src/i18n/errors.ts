import type { AppError } from '../api/errors';
import { isPlainKey } from './catalog';
import type { Translate } from './translate';

/**
 * The text of a backend error (ARCHITECTURE section 7): `error.<code>`, or the more specific `error.<code>.<what>` when
 * the error says what it is about and the catalog has a text for that case.
 */
export function errorText(t: Translate, error: AppError): string {
  const what = error.params?.what;
  if (what !== undefined) {
    const specific = `${error.key}.${what}`;
    if (isPlainKey(specific)) return t(specific);
  }
  return t(error.key);
}
