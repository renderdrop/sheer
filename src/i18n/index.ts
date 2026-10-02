import type { Locale } from './locale';
import { useLocaleStore } from './store';
import { translators, type Translate } from './translate';

export { isPlainKey, type MessageKey, type PlainKey, type PluralKey } from './catalog';
export { errorText } from './errors';
export { formatNumber, formatPercent } from './format';
export { LANGUAGES, LOCALES, resolveLocale, type Language, type Locale } from './locale';
export { translators, type MessageParams, type Translate } from './translate';

/** The locale the UI is in. A component that calls this renders again when the language changes. */
export function useLocale(): Locale {
  return useLocaleStore((state) => state.locale);
}

/** `t` for the UI's locale: `const t = useT(); t('toolbar.label')`. Its identity changes only with the language. */
export function useT(): Translate {
  return translators[useLocale()];
}
