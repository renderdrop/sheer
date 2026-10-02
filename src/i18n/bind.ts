import { useSettings, type AttributeTarget, type SettingsState } from '../stores/settings';
import { resolveLocale } from './locale';
import { systemLanguage, useLocaleStore } from './store';

/**
 * Keeps the UI's locale and `<html lang>` in step with the `language` setting: "system" follows the OS, "en" and "de"
 * are fixed. It applies the current setting at once and again on every change, so the first paint follows the OS and the
 * saved choice replaces it when the settings arrive. Returns the unsubscribe function.
 */
export function bindLocaleToSettings(
  root: Pick<AttributeTarget, 'setAttribute'>,
  settings: Pick<typeof useSettings, 'getState' | 'subscribe'> = useSettings,
  locales: Pick<typeof useLocaleStore, 'getState'> = useLocaleStore,
  system: () => string | undefined = systemLanguage,
): () => void {
  const apply = (state: Pick<SettingsState, 'language'>) => {
    const locale = resolveLocale(state.language, system());
    root.setAttribute('lang', locale);
    if (locales.getState().locale !== locale) locales.getState().setLocale(locale);
  };
  apply(settings.getState());
  return settings.subscribe(apply);
}
