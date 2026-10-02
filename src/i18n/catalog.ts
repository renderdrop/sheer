import de from './locales/de.json';
import en from './locales/en.json';
import type { Locale } from './locale';

/**
 * The message catalogs. `locales/en.json` is the source of the key types: a key that is not in it does not compile.
 * `de.json` must have exactly the same keys, which `CatalogsHaveTheSameKeys` checks at compile time and `i18n.test.ts` and
 * the Rust test `tests/i18n_catalogs.rs` check again at run time.
 *
 * Keys are flat and dotted (`toolbar.tool.select`). A message may hold `{name}` placeholders. A plural message is a
 * group of keys that share a base and end in a CLDR plural category: `component.splitterValue.one` and `.other`. The
 * base (`component.splitterValue`) is what the code passes, together with a `count`. `other` is required in every group;
 * a plain key must not end in a category word. The files are pure JSON (no comments) because Rust reads them too.
 */
export const catalogs: Readonly<Record<Locale, Readonly<Record<string, string>>>> = { en, de };

type EnglishKey = keyof typeof en;
type GermanKey = keyof typeof de;

type Assert<Condition extends true> = Condition;

/** Compile-time check: a key that is in one file and not in the other makes this fail to compile. */
export type CatalogsHaveTheSameKeys = Assert<
  [EnglishKey] extends [GermanKey] ? ([GermanKey] extends [EnglishKey] ? true : false) : false
>;

type PluralSuffix = `.${Intl.LDMLPluralRule}`;

/** A key that is one message. */
export type PlainKey = Exclude<EnglishKey, `${string}${PluralSuffix}`>;

/** The base of a plural group: `t` needs a `count` to pick the form. */
export type PluralKey = EnglishKey extends infer Key
  ? Key extends `${infer Base}${PluralSuffix}`
    ? Base
    : never
  : never;

export type MessageKey = PlainKey | PluralKey;

const PLURAL_SUFFIX = /\.(?:zero|one|two|few|many|other)$/;

/** Whether `key` is a message of its own in the catalogs (for keys built at run time, such as `error.<code>.<what>`). */
export function isPlainKey(key: string): key is PlainKey {
  return Object.hasOwn(en, key) && !PLURAL_SUFFIX.test(key);
}
