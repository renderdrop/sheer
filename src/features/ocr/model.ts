import type { OcrCapabilities, OcrLanguageTag, PageClass } from '../../api/ocr';
import type { PageSelection } from '../../api/pageSelection';
import type { Locale } from '../../i18n';

/** The recognition language follows the UI language (ADR-135 section 2). */
export function wantedLanguage(locale: Locale): OcrLanguageTag {
  return locale === 'de' ? 'de-DE' : 'en-US';
}

export type LanguageState =
  /** Not known yet (capabilities not loaded). */
  { kind: 'loading' } | { kind: 'available' } | { kind: 'fallback'; used: OcrLanguageTag } | { kind: 'none' };

export function languageState(capabilities: OcrCapabilities | null, wanted: OcrLanguageTag): LanguageState {
  if (capabilities === null) return { kind: 'loading' };
  const available = capabilities.languages.filter((language) => language.available);
  if (available.some((language) => language.tag === wanted)) return { kind: 'available' };
  const other = available[0];
  return other === undefined ? { kind: 'none' } : { kind: 'fallback', used: other.tag };
}

export type Scope = 'scan' | 'current' | 'selected' | 'all';

export interface ScopeCounts {
  /** Pages the scope holds, whatever their class. */
  inScope: number;
  scan: number;
  sheerLayer: number;
}

/** The page ids a scope holds. `scan` and `all` hold every page. */
export function scopeIds(
  scope: Scope,
  classes: readonly PageClass[],
  currentPageId: number | null,
  selectedIds: readonly number[],
): number[] {
  if (scope === 'current') return currentPageId === null ? [] : [currentPageId];
  if (scope === 'selected') return selectedIds.filter((id) => classes.some((entry) => entry.page === id));
  return classes.map((entry) => entry.page);
}

export function countScope(classes: readonly PageClass[], ids: readonly number[]): ScopeCounts {
  const wanted = new Set(ids);
  let scan = 0;
  let sheerLayer = 0;
  for (const entry of classes) {
    if (!wanted.has(entry.page)) continue;
    if (entry.class === 'scan') scan += 1;
    else if (entry.class === 'sheerLayer') sheerLayer += 1;
  }
  return { inScope: wanted.size, scan, sheerLayer };
}

/** The pages that will run: scans, plus the pages with a layer of this session when Redo is on. */
export function runCount(counts: ScopeCounts, redo: boolean): number {
  return counts.scan + (redo ? counts.sheerLayer : 0);
}

/** What `ocr_start` takes for a scope. The backend only touches scans (and layers with `redo`), so a broad selection is safe. */
export function selectionFor(
  scope: Scope,
  classes: readonly PageClass[],
  currentPageId: number | null,
  selectedIds: readonly number[],
  redo: boolean,
): PageSelection | null {
  if (scope === 'all') return { type: 'all' };
  if (scope === 'current') return currentPageId === null ? null : { type: 'current', pageId: currentPageId };
  const ids = scopeIds(scope, classes, currentPageId, selectedIds);
  if (scope === 'selected') return { type: 'pages', pages: ids };
  const wantedClasses = redo ? ['scan', 'sheerLayer'] : ['scan'];
  const pages = classes.filter((entry) => wantedClasses.includes(entry.class)).map((entry) => entry.page);
  return { type: 'pages', pages };
}

/** Whether the offer banner is wanted: at least one scan page, a usable recognizer, not locked, not dismissed. */
export function offerWanted(input: {
  backendNone: boolean;
  scanPages: number;
  locked: boolean;
  dismissed: boolean;
  readOnly: boolean;
}): boolean {
  return !input.backendNone && input.scanPages > 0 && !input.locked && !input.dismissed && !input.readOnly;
}

/** Whether the tab has recognized text to save as a text PDF (F19.22): a page with a layer of ours or another recognizer's. */
export function hasRecognizedText(classes: readonly PageClass[]): boolean {
  return classes.some((entry) => entry.class === 'sheerLayer' || entry.class === 'hasTextLayer');
}
