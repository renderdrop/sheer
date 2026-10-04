import type { PageSlotInfo } from '../../api/pages';
import type { PageSelection } from '../../api/pageSelection';
import { drawnSize } from '../../stores/pages';
import { parseRanges } from '../jobs/ranges';

/** Resolution limits of the backend (`ImageExportOptions.dpi`, 36..=600). */
export const DPI_MIN = 36;
export const DPI_MAX = 600;
export const QUALITY_MIN = 10;
export const QUALITY_MAX = 100;
export const DPI_PRESETS = [72, 150, 300] as const;

export type Format = 'png' | 'jpeg';
export type PagesMode = 'all' | 'current' | 'selected' | 'range';
export type DpiChoice = 'custom' | `${(typeof DPI_PRESETS)[number]}`;

export interface Remembered {
  format: Format;
  dpi: number;
  quality: number;
}

export const DEFAULTS: Remembered = { format: 'png', dpi: 150, quality: 85 };
const STORAGE_KEY = 'sheer.exportImages';

/** A whole number from 36 to 600 in a field's text; `null` otherwise. */
export function parseDpi(text: string): number | null {
  if (!/^\d{1,4}$/.test(text.trim())) return null;
  const value = Number(text);
  return value >= DPI_MIN && value <= DPI_MAX ? value : null;
}

export const clampDpi = (value: number): number => Math.min(DPI_MAX, Math.max(DPI_MIN, Math.round(value)));

/** The last format, resolution and quality, validated; the defaults for anything unusable. */
export function loadRemembered(): Remembered {
  try {
    const raw: unknown = JSON.parse(globalThis.localStorage.getItem(STORAGE_KEY) ?? 'null');
    if (typeof raw !== 'object' || raw === null) return DEFAULTS;
    const { format, dpi, quality } = raw as Record<string, unknown>;
    return {
      format: format === 'jpeg' ? 'jpeg' : 'png',
      dpi: typeof dpi === 'number' && parseDpi(String(dpi)) !== null ? dpi : DEFAULTS.dpi,
      quality:
        typeof quality === 'number' && Number.isInteger(quality) && quality >= QUALITY_MIN && quality <= QUALITY_MAX
          ? quality
          : DEFAULTS.quality,
    };
  } catch {
    return DEFAULTS;
  }
}

export function saveRemembered(value: Remembered): void {
  try {
    globalThis.localStorage.setItem(STORAGE_KEY, JSON.stringify(value));
  } catch {
    // Not remembered; harmless.
  }
}

export type RangeCheck = { ok: true; indices: number[] } | { ok: false; problem: 'invalid' | null };

/** The page positions (0-based) the mode takes, or why not. `problem: null` is an empty field: not valid yet, but no error. */
export function resolvePages(
  mode: PagesMode,
  text: string,
  slots: readonly PageSlotInfo[],
  currentIndex: number,
  selectedIds: readonly number[],
): RangeCheck {
  if (slots.length === 0) return { ok: false, problem: null };
  if (mode === 'all') return { ok: true, indices: slots.map((_, index) => index) };
  if (mode === 'current') {
    return currentIndex >= 0 && currentIndex < slots.length
      ? { ok: true, indices: [currentIndex] }
      : { ok: false, problem: null };
  }
  if (mode === 'selected') {
    const indices = slots.flatMap((slot, index) => (selectedIds.includes(slot.id) ? [index] : []));
    return indices.length > 0 ? { ok: true, indices } : { ok: false, problem: null };
  }
  if (text.trim() === '') return { ok: false, problem: null };
  const ranges = parseRanges(text, slots.length);
  if (ranges === null) return { ok: false, problem: 'invalid' };
  const seen = new Set<number>();
  for (const [start, end] of ranges) for (let page = start; page <= end; page += 1) seen.add(page - 1);
  return { ok: true, indices: [...seen].sort((a, b) => a - b) };
}

/** The `PageSelection` the backend takes for a mode. */
export function toSelection(
  mode: PagesMode,
  text: string,
  slots: readonly PageSlotInfo[],
  currentIndex: number,
  selectedIds: readonly number[],
): PageSelection | null {
  if (mode === 'all') return { type: 'all' };
  if (mode === 'current') {
    const page = slots[currentIndex];
    return page === undefined ? null : { type: 'current', pageId: page.id };
  }
  if (mode === 'selected') return selectedIds.length > 0 ? { type: 'pages', pages: [...selectedIds] } : null;
  return { type: 'ranges', text: text.trim() };
}

/**
 * A rough size of the files: pixels at the resolution times a typical bytes-per-pixel of the format (PNG of a document page is
 * mostly flat colour; JPEG grows with quality). It is labelled "about"; Rust writes the real files.
 */
export function estimateBytes(
  slots: readonly PageSlotInfo[],
  indices: readonly number[],
  dpi: number,
  format: Format,
  quality: number,
): number {
  const perPixel = format === 'png' ? 0.35 : 0.04 + (quality / 100) * 0.3;
  let total = 0;
  for (const index of indices) {
    const slot = slots[index];
    if (slot === undefined) continue;
    const [width, height] = drawnSize(slot);
    total += ((width * dpi) / 72) * ((height * dpi) / 72) * perPixel;
  }
  return Math.round(total);
}
