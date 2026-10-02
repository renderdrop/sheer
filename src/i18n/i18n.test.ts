import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { catalogs, isPlainKey, type PlainKey, type PluralKey } from './catalog';
import { LANGUAGES, LOCALES, resolveLocale } from './locale';
import { createTranslate, translators } from './translate';

const t = translators.en;
const de = translators.de;

const PLACEHOLDER = /\{([^{}]*)\}/g;
const PLURAL_SUFFIX = /\.(zero|one|two|few|many|other)$/;

const placeholders = (message: string): string[] =>
  [...message.matchAll(PLACEHOLDER)].map((match) => match[1] ?? '').sort();

const keysOf = (locale: (typeof LOCALES)[number]): string[] => Object.keys(catalogs[locale]).sort();

describe('the catalogs', () => {
  it('en and de have exactly the same keys', () => {
    const en = new Set(keysOf('en'));
    const german = new Set(keysOf('de'));
    expect(
      [...en].filter((key) => !german.has(key)),
      'missing in de.json',
    ).toEqual([]);
    expect(
      [...german].filter((key) => !en.has(key)),
      'missing in en.json',
    ).toEqual([]);
  });

  it('every message is a non-empty string, and no German text is left as the English one by accident', () => {
    for (const locale of LOCALES) {
      for (const [key, message] of Object.entries(catalogs[locale])) {
        expect(typeof message, `${locale} ${key}`).toBe('string');
        expect(message.trim().length, `${locale} ${key}`).toBeGreaterThan(0);
      }
    }
    // Shared words are fine ("Zoom", "Status"); a whole sentence that is identical was not translated.
    const untranslated = Object.entries(catalogs.en).filter(
      ([key, message]) => message === catalogs.de[key] && message.split(/\s+/).length > 2,
    );
    expect(untranslated).toEqual([]);
  });

  it('both languages use the same placeholders in every message', () => {
    for (const [key, message] of Object.entries(catalogs.en)) {
      expect(placeholders(catalogs.de[key] ?? ''), key).toEqual(placeholders(message));
    }
  });

  it('placeholders are plain words, so interpolation finds them', () => {
    for (const locale of LOCALES) {
      for (const [key, message] of Object.entries(catalogs[locale])) {
        for (const name of placeholders(message)) expect(name, `${locale} ${key}`).toMatch(/^[A-Za-z_][A-Za-z0-9_]*$/);
      }
    }
  });

  it('every form of a plural group belongs to a group with an "other" form and a base that is not a message itself', () => {
    for (const locale of LOCALES) {
      const keys = Object.keys(catalogs[locale]);
      const forms = keys.filter((key) => PLURAL_SUFFIX.test(key));
      expect(forms.length, locale).toBeGreaterThan(0);
      for (const form of forms) {
        const base = form.replace(PLURAL_SUFFIX, '');
        expect(keys, `${locale} ${base}`).toContain(`${base}.other`);
        expect(keys, `${locale} ${base} must not also be a plain message`).not.toContain(base);
      }
    }
  });

  it('a plural message uses {count}, so the number is shown', () => {
    for (const locale of LOCALES) {
      for (const [key, message] of Object.entries(catalogs[locale])) {
        if (PLURAL_SUFFIX.test(key)) expect(message, `${locale} ${key}`).toContain('{count}');
      }
    }
  });

  it('the files are pure JSON without comments, a BOM or duplicate keys', () => {
    for (const locale of LOCALES) {
      const path = fileURLToPath(new URL(`./locales/${locale}.json`, import.meta.url));
      const text = readFileSync(path, 'utf8');
      expect(text.charCodeAt(0), `${locale} BOM`).not.toBe(0xfeff);
      expect(() => JSON.parse(text) as unknown, locale).not.toThrow();
      const written = [...text.matchAll(/^\s*"((?:[^"\\]|\\.)*)"\s*:/gm)].map((match) => match[1]);
      expect(new Set(written).size, `${locale} repeats a key`).toBe(written.length);
      expect(written.length, `${locale} reads every entry`).toBe(Object.keys(catalogs[locale]).length);
      expect(text, `${locale} comments`).not.toMatch(/^\s*\/\/|\/\*/m);
    }
  });
});

describe('t', () => {
  it('returns the message of the locale', () => {
    expect(t('toolbar.label')).toBe('Tools');
    expect(de('toolbar.label')).toBe('Werkzeuge');
    expect(t.locale).toBe('en');
    expect(de.locale).toBe('de');
  });

  it('fills {name} placeholders', () => {
    expect(t('status.page', { page: 3, total: 12 })).toBe('Page 3 of 12');
    expect(de('status.page', { page: 3, total: 12 })).toBe('Seite 3 von 12');
  });

  it('writes numbers the way the language does and leaves strings alone', () => {
    expect(t('status.page', { page: 1234, total: 12000 })).toBe('Page 1,234 of 12,000');
    expect(de('status.page', { page: 1234, total: 12000 })).toBe('Seite 1.234 von 12.000');
    expect(t('status.page', { page: '1234', total: 'many' })).toBe('Page 1234 of many');
  });

  it('keeps a placeholder that has no value, and ignores values nobody asks for', () => {
    expect(t('status.page', { page: 3 })).toBe('Page 3 of {total}');
    expect(t('status.page')).toBe('Page {page} of {total}');
    expect(t('toolbar.label', { page: 3 })).toBe('Tools');
  });

  it('inserts a value as it is, whatever characters it holds', () => {
    expect(t('status.page', { page: '$& $1 $$ {total}', total: '</b>' })).toBe('Page $& $1 $$ {total} of </b>');
    // Names that exist on every object are not parameters.
    expect(t('status.page', {})).toBe('Page {page} of {total}');
  });

  it('shows the key when no catalog has it, and never throws', () => {
    // @ts-expect-error an unknown key does not compile
    expect(t('no.such.key')).toBe('no.such.key');
    // @ts-expect-error neither does one that only differs in a letter
    expect(t('toolbar.lable')).toBe('toolbar.lable');
    // @ts-expect-error keys that exist on every object are not messages
    expect(t('constructor')).toBe('constructor');
    // @ts-expect-error nor does the empty key
    expect(t('')).toBe('');
  });

  it('falls back to English for a key that a catalog lacks', () => {
    const original = catalogs.de['toolbar.label'];
    const mutable = catalogs.de as Record<string, string>;
    try {
      delete mutable['toolbar.label'];
      expect(de('toolbar.label')).toBe('Tools');
    } finally {
      if (original !== undefined) mutable['toolbar.label'] = original;
    }
    expect(de('toolbar.label')).toBe('Werkzeuge');
  });

  it('is created once per locale, so its identity is stable', () => {
    expect(translators.en).toBe(translators.en);
    expect(createTranslate('en')).not.toBe(translators.en);
    expect(createTranslate('de').locale).toBe('de');
  });
});

describe('plurals', () => {
  it('picks the English form from the count', () => {
    expect(t('component.splitterValue', { count: 1 })).toBe('1 pixel');
    expect(t('component.splitterValue', { count: 0 })).toBe('0 pixels');
    expect(t('component.splitterValue', { count: 2 })).toBe('2 pixels');
    expect(t('component.splitterValue', { count: 248 })).toBe('248 pixels');
    expect(t('component.splitterValue', { count: 1.5 })).toBe('1.5 pixels');
  });

  it('picks the German form from the count', () => {
    expect(de('component.splitterValue', { count: 1 })).toBe('1 Pixel');
    expect(de('component.splitterValue', { count: 0 })).toBe('0 Pixel');
    expect(de('component.splitterValue', { count: 248 })).toBe('248 Pixel');
  });

  it('follows the plural rules of the language, not a fixed one-or-many', () => {
    // CLDR: English and German have "one" and "other"; 1 is "one" in both, 0 and 2 are "other".
    expect(new Intl.PluralRules('en').select(1)).toBe('one');
    expect(new Intl.PluralRules('de').select(1)).toBe('one');
    expect(new Intl.PluralRules('en').select(2)).toBe('other');
    // The form comes from the catalog entry named by the category.
    expect(catalogs.en['component.splitterValue.one']).toBe('{count} pixel');
    expect(catalogs.en['component.splitterValue.other']).toBe('{count} pixels');
  });

  it('writes the count in the language of the locale', () => {
    expect(t('component.splitterValue', { count: 1234 })).toBe('1,234 pixels');
    expect(de('component.splitterValue', { count: 1234 })).toBe('1.234 Pixel');
  });

  it('a count that is not a number is "other", never a crash', () => {
    expect(t('component.splitterValue', { count: Number.NaN })).toBe('NaN pixels');
    expect(t('component.splitterValue', { count: Number.POSITIVE_INFINITY })).toBe('∞ pixels');
  });
});

describe('the key types', () => {
  it('accept every key of en.json, and plural keys by their base', () => {
    const plain: PlainKey = 'toolbar.tool.select';
    const base: PluralKey = 'component.splitterValue';
    expect(t(plain)).toBe('Select');
    expect(t(base, { count: 2 })).toBe('2 pixels');
    expect(isPlainKey('toolbar.label')).toBe(true);
    expect(isPlainKey('error.not_found.document')).toBe(true);
  });

  it('reject a plural key without a count, and the raw form keys', () => {
    // @ts-expect-error a plural key needs a count
    expect(t('component.splitterValue')).toBe('{count} pixels');
    // @ts-expect-error a count that is not a number does not pick a form
    expect(t('component.splitterValue', { count: '2' })).toBe('2 pixels');
    // @ts-expect-error the form keys are not keys of their own: the base is
    void t('component.splitterValue.one', { count: 1 });
  });

  it('isPlainKey says no to what is not a message of its own', () => {
    for (const key of [
      'nope',
      '',
      'toolbar.lable',
      'constructor',
      '__proto__',
      'toString',
      'component.splitterValue',
      'component.splitterValue.one',
      'component.splitterValue.other',
      'error.internal.nothing',
    ]) {
      expect(isPlainKey(key), key).toBe(false);
    }
  });
});

describe('resolveLocale', () => {
  it('lets an explicit language win', () => {
    expect(resolveLocale('en', 'de-DE')).toBe('en');
    expect(resolveLocale('de', 'en-US')).toBe('de');
    expect(resolveLocale('de', undefined)).toBe('de');
  });

  it('"system" is German for every German tag and English otherwise', () => {
    for (const tag of ['de', 'de-DE', 'de-AT', 'de-CH', 'de_DE', 'DE', 'De-at', 'de-u-co-phonebk']) {
      expect(resolveLocale('system', tag), tag).toBe('de');
    }
    for (const tag of ['en', 'en-US', 'fr-FR', 'es', 'ja-JP', 'nl-BE', 'dev', 'den', 'ded-DE', 'x-de', '', undefined]) {
      expect(resolveLocale('system', tag), String(tag)).toBe('en');
    }
  });

  it('the languages of the setting are "system" and every locale', () => {
    expect(LANGUAGES).toEqual(['system', ...LOCALES]);
    expect(LOCALES).toEqual(['en', 'de']);
  });
});

describe('plurals at the usual counts', () => {
  it('0, 1, 2 and 5 pick the right form in English and German', () => {
    const forms = [
      [0, '0 pixels', '0 Pixel'],
      [1, '1 pixel', '1 Pixel'],
      [2, '2 pixels', '2 Pixel'],
      [5, '5 pixels', '5 Pixel'],
    ] as const;
    for (const [count, english, german] of forms) {
      expect(t('component.splitterValue', { count }), `en ${count}`).toBe(english);
      expect(de('component.splitterValue', { count }), `de ${count}`).toBe(german);
    }
  });

  it('every plural group of both catalogs gives a finished text for 0, 1, 2 and 5', () => {
    const bases = Object.keys(catalogs.en)
      .filter((key) => PLURAL_SUFFIX.test(key))
      .map((key) => key.replace(PLURAL_SUFFIX, ''));
    expect(new Set(bases).size).toBeGreaterThan(0);
    for (const base of new Set(bases)) {
      for (const translate of [t, de]) {
        for (const count of [0, 1, 2, 5]) {
          // The typed API wants a plural key; the loop reads the keys from the catalog.
          const text = (translate as (key: string, params: { count: number }) => string)(base, { count });
          expect(text, `${translate.locale} ${base} ${count}`).toContain(String(count));
          expect(text, `${translate.locale} ${base} ${count}`).not.toMatch(/[{}]|undefined|null|NaN/);
        }
      }
    }
  });
});

describe('interpolation with missing parameters', () => {
  /** Whatever a caller or a backend might hand over at run time, which the types do not allow. */
  const loose = (translate: typeof t) => translate as unknown as (key: string, params?: unknown) => string;

  it('a value that is undefined keeps its placeholder: "undefined" is never written', () => {
    expect(loose(t)('status.page', { page: undefined, total: undefined })).toBe('Page {page} of {total}');
    expect(loose(de)('status.page', { page: 7, total: undefined })).toBe('Seite 7 von {total}');
    expect(loose(t)('component.splitterValue', { count: undefined })).toBe('{count} pixels');
  });

  it('null parameters are no parameters, and a value that is null keeps its placeholder: "null" is never written', () => {
    expect(loose(t)('status.page', null)).toBe('Page {page} of {total}');
    expect(loose(de)('status.page', null)).toBe('Seite {page} von {total}');
    expect(loose(t)('toolbar.label', null)).toBe('Tools');
    expect(loose(t)('status.page', { page: null, total: null })).toBe('Page {page} of {total}');
    expect(loose(de)('status.page', { page: 7, total: null })).toBe('Seite 7 von {total}');
    expect(loose(t)('component.splitterValue', { count: null })).toBe('{count} pixels');
    expect(loose(t)('component.splitterValue', null)).toBe('{count} pixels');
  });

  it('a value that is neither text nor a number is no value: the placeholder stays', () => {
    expect(loose(t)('status.page', { page: { toString: () => 'x' }, total: true })).toBe('Page {page} of {total}');
    expect(loose(t)('status.page', { page: [1, 2], total: () => 3 })).toBe('Page {page} of {total}');
  });

  it('every message of both catalogs renders without parameters, with none of them and with unrelated ones', () => {
    const translate = (locale: (typeof LOCALES)[number]) => loose(translators[locale]);
    for (const locale of LOCALES) {
      for (const key of Object.keys(catalogs[locale])) {
        const base = key.replace(PLURAL_SUFFIX, '');
        for (const params of [undefined, null, {}, { unrelated: 'x' }, { page: undefined }, { page: null }]) {
          let text = '';
          expect(() => (text = translate(locale)(base, params)), `${locale} ${key}`).not.toThrow();
          expect(text, `${locale} ${key}`).not.toMatch(/undefined|null|NaN|\[object/);
          expect(text.trim().length, `${locale} ${key}`).toBeGreaterThan(0);
        }
      }
    }
  });

  it('a placeholder that has no value shows as it is, in both languages, so a gap is easy to spot', () => {
    for (const locale of LOCALES) {
      const text = translators[locale]('status.page');
      expect(text, locale).toContain('{page}');
      expect(text, locale).toContain('{total}');
    }
  });
});
