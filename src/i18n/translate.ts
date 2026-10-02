import { catalogs, type PlainKey, type PluralKey } from './catalog';
import { formatNumber } from './format';
import { DEFAULT_LOCALE, type Locale } from './locale';

/** Values for the `{name}` placeholders of a message. Numbers are written in the locale's format. */
export type MessageParams = Readonly<Record<string, string | number>>;

/**
 * `t(key, params)`. Keys are typed from `locales/en.json`: an unknown key does not compile. A plural key (the base of a
 * group such as `component.splitterValue`) needs a numeric `count`, which picks the form with `Intl.PluralRules` and
 * is also available as `{count}`. A key built at run time has to be narrowed first (`isPlainKey`).
 */
export interface Translate {
  (key: PluralKey, params: MessageParams & { readonly count: number }): string;
  (key: PlainKey, params?: MessageParams): string;
  /** The locale this function translates into. */
  readonly locale: Locale;
}

const pluralRules = new Map<Locale, Intl.PluralRules>();

function categoryOf(locale: Locale, count: number): Intl.LDMLPluralRule {
  let rules = pluralRules.get(locale);
  if (rules === undefined) {
    rules = new Intl.PluralRules(locale);
    pluralRules.set(locale, rules);
  }
  return rules.select(count);
}

/** An entry of the catalog itself: a key such as "constructor" must not find something on the prototype. */
function own(catalog: Readonly<Record<string, string>>, key: string): string | undefined {
  return Object.hasOwn(catalog, key) ? catalog[key] : undefined;
}

function messageIn(locale: Locale, key: string, count: number | undefined): string | undefined {
  const catalog = catalogs[locale];
  const other = own(catalog, `${key}.other`);
  if (other === undefined) return own(catalog, key);
  // A plural group: without a count (not possible through the typed API) the general form is the safe one.
  const category = count === undefined ? 'other' : categoryOf(locale, count);
  return own(catalog, `${key}.${category}`) ?? other;
}

const PLACEHOLDER = /\{([A-Za-z_][A-Za-z0-9_]*)\}/g;

/**
 * The message for `key` in `locale`, or in the default locale when it has a gap, or the key itself when nobody has it,
 * so a missing text shows up as its key and never as a blank or a crash. A placeholder without a value (missing, `null`
 * or `undefined`) stays as it is.
 */
function render(locale: Locale, key: string, params: MessageParams | null | undefined): string {
  const count = typeof params?.count === 'number' ? params.count : undefined;
  const message =
    messageIn(locale, key, count) ?? (locale === DEFAULT_LOCALE ? undefined : messageIn(DEFAULT_LOCALE, key, count));
  if (message === undefined) return key;
  // `null` is as good as no parameters (the types do not allow it, but a caller may hand it over at run time).
  if (params === undefined || params === null) return message;
  return message.replace(PLACEHOLDER, (placeholder, name: string) => {
    const value: unknown = Object.hasOwn(params, name) ? params[name] : undefined;
    if (typeof value === 'number') return formatNumber(value, locale);
    // Text goes in as it is. Anything else (null, undefined, or whatever a caller might pass) is no value: the placeholder
    // stays, so a gap is visible and "null", "undefined" or "[object Object]" is never written.
    return typeof value === 'string' ? value : placeholder;
  });
}

export function createTranslate(locale: Locale): Translate {
  return Object.assign((key: string, params?: MessageParams) => render(locale, key, params), { locale });
}

/** One function per locale, created once: the identity of `t` changes only when the language does, so it can be a hook dependency. */
export const translators: Readonly<Record<Locale, Translate>> = {
  en: createTranslate('en'),
  de: createTranslate('de'),
};
