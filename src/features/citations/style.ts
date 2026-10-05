import { create } from 'zustand';

import {
  CITATION_FILE_FORMATS,
  CITATION_STYLES,
  type CitationFileFormat,
  type CitationStyle,
} from '../../api/citations';
import { useLocale, type Locale } from '../../i18n';
import { useLocaleStore } from '../../i18n/store';

/**
 * The citation style and the last save format are preferences of the app (DESIGN 3.7 C7, UI storage `sheer.citations.style` and
 * `sheer.citations.format`), not of a document. Until the user chooses, the style follows the UI language: DIN ISO 690 for German,
 * else APA 7.
 */
export const STYLE_KEY = 'sheer.citations.style';
export const FORMAT_KEY = 'sheer.citations.format';

/** The style a first run starts with. */
export const defaultStyleFor = (locale: Locale): CitationStyle => (locale === 'de' ? 'dinIso690' : 'apa7');

function read<T extends string>(key: string, allowed: readonly T[]): T | undefined {
  try {
    const raw = globalThis.localStorage?.getItem(key) ?? '';
    return allowed.find((value) => value === raw);
  } catch {
    return undefined;
  }
}

function write(key: string, value: string): void {
  try {
    globalThis.localStorage?.setItem(key, value);
  } catch {
    // Storage blocked or full: the choice lasts for this session.
  }
}

interface PrefsState {
  style: CitationStyle | undefined;
  format: CitationFileFormat;
}

export const useCitationPrefs = create<PrefsState>()(() => ({
  style: read(STYLE_KEY, CITATION_STYLES),
  format: read(FORMAT_KEY, CITATION_FILE_FORMATS) ?? 'txt',
}));

/** The style in use: the stored one, else the default of the UI language. */
export function getCitationStyle(): CitationStyle {
  return useCitationPrefs.getState().style ?? defaultStyleFor(useLocaleStore.getState().locale);
}

export function setCitationStyle(style: CitationStyle): void {
  write(STYLE_KEY, style);
  useCitationPrefs.setState({ style });
}

/** `const [style, setStyle] = useCitationStyle()`; every short citation that uses it follows a change. */
export function useCitationStyle(): [CitationStyle, (style: CitationStyle) => void] {
  const stored = useCitationPrefs((state) => state.style);
  const locale = useLocale();
  return [stored ?? defaultStyleFor(locale), setCitationStyle];
}

/** The format the last save used. */
export const getCitationFormat = (): CitationFileFormat => useCitationPrefs.getState().format;

export function setCitationFormat(format: CitationFileFormat): void {
  write(FORMAT_KEY, format);
  useCitationPrefs.setState({ format });
}

export function useCitationFormat(): [CitationFileFormat, (format: CitationFileFormat) => void] {
  return [useCitationPrefs((state) => state.format), setCitationFormat];
}
