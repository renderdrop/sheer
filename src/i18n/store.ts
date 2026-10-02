import { create } from 'zustand';

import { resolveLocale, type Locale } from './locale';

/** The OS language as the browser reports it; `undefined` where there is no `navigator` (a node test). */
export function systemLanguage(): string | undefined {
  return typeof navigator === 'undefined' ? undefined : navigator.language;
}

export interface LocaleState {
  locale: Locale;
  setLocale: (locale: Locale) => void;
}

/**
 * The locale the UI renders in. It starts at the OS language, so the first paint is already right, and
 * `bindLocaleToSettings` (./bind.ts) keeps it in step with the `language` setting once that has loaded.
 */
export const useLocaleStore = create<LocaleState>()((set) => ({
  locale: resolveLocale('system', systemLanguage()),
  setLocale: (locale) => set({ locale }),
}));
