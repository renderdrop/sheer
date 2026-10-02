/**
 * The interface languages. A locale is a language that ships with a catalog (`locales/<locale>.json`); the setting
 * `language` can also be "system", which follows the OS. Pure: no store and no DOM, so the backend's settings module
 * (`src/api/app.ts`) can name the wire values without pulling in the rest of the i18n code.
 */
export const LOCALES = ['en', 'de'] as const;
export type Locale = (typeof LOCALES)[number];

/** Wire names of the backend's `Language` (src-tauri/src/storage/settings.rs). Keep in sync. */
export const LANGUAGES = ['system', ...LOCALES] as const;
export type Language = (typeof LANGUAGES)[number];

/** What an unsupported OS language falls back to. It is also the catalog that fills a gap in another one. */
export const DEFAULT_LOCALE: Locale = 'en';

/**
 * The locale for a `language` setting. "system" looks at the OS language (`navigator.language`, a BCP 47 tag such as
 * "de-AT"): its primary subtag picks the locale (`de`, `de-DE`, `de_AT` and `DE` are German), anything else is English.
 */
export function resolveLocale(language: Language, systemLanguage: string | undefined): Locale {
  if (language !== 'system') return language;
  const primary = systemLanguage?.toLowerCase().split(/[-_]/, 1)[0];
  return LOCALES.find((locale) => locale === primary) ?? DEFAULT_LOCALE;
}
