import type { AppError } from '../../../api/errors';
import type { SigningIdentityInfo } from '../../../api/signing';
import type { PlainKey, Translate } from '../../../i18n';
import { errorText } from '../../../i18n';

/** A plain address check: something, an at sign, a dot in the domain, no spaces. The keychain item is only labelled with it. */
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/** Whether the optional email text is acceptable: empty, or an address of at most 254 characters. */
export function emailOk(value: string): boolean {
  const text = value.trim();
  return text === '' || (text.length <= 254 && EMAIL.test(text));
}

/** Groups hex digits in fours for reading and comparing ("ab12 cd34 ..."). */
export function groupHex(hex: string): string {
  return hex.replace(/(.{4})(?=.)/g, '$1 ');
}

/** Month and year of an ISO time, in the locale ("10/2029"). */
export function formatMonth(locale: string, iso: string): string {
  return new Intl.DateTimeFormat(locale, { month: '2-digit', year: 'numeric' }).format(new Date(iso));
}

/** A full date of an ISO time, in the locale. */
export function formatDay(locale: string, iso: string): string {
  return new Intl.DateTimeFormat(locale, { dateStyle: 'medium' }).format(new Date(iso));
}

/** Whether the certificate is not valid yet (the backend flags the expired ones). */
export function notYetValid(item: SigningIdentityInfo, now = Date.now()): boolean {
  return Date.parse(item.notBefore) > now;
}

/** The text for a rejected certificate command: the documented codes get their own words, the rest the generic error text. */
export function certErrorText(t: Translate, error: AppError): string {
  const key = certErrorKey(error);
  return key === null ? errorText(t, error) : t(key);
}

function certErrorKey(error: AppError): PlainKey | null {
  const what = error.params?.what;
  if (error.code === 'password_required') return 'cert.errPassword';
  if (error.code === 'invalid_argument' && what === 'identityFile') return 'cert.errFile';
  if (error.code === 'unsupported_feature' && what === 'signingKey') return 'cert.errAlgorithm';
  if (error.code === 'limit_exceeded' && what === 'identities') return 'cert.limit';
  return null;
}
