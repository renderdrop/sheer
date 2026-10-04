import { appReady } from '../../api/app';
import type { ImagesToPdfOptions, PaperSize } from '../../api/imagesToPdf';

export type Orientation = ImagesToPdfOptions['orientation'];
export type MarginId = 'none' | 'small' | 'large';

export const PAPERS: readonly PaperSize[] = ['fit', 'a4', 'letter'];
export const ORIENTATIONS: readonly Orientation[] = ['auto', 'portrait', 'landscape'];
export const MARGINS: readonly MarginId[] = ['none', 'small', 'large'];
/** Margin presets in points (DESIGN 3.43, ADR-049): 12 mm = 34 pt, 24 mm = 68 pt. */
export const MARGIN_PT: Record<MarginId, number> = { none: 0, small: 34, large: 68 };

export interface PageChoices {
  paper: PaperSize;
  orientation: Orientation;
  margin: MarginId;
}

const KEY = 'img2pdf.options';

/** What was chosen last time, if anything (without a stored paper the OS region decides). */
export function loadChoices(): Partial<PageChoices> {
  try {
    const raw: unknown = JSON.parse(window.localStorage.getItem(KEY) ?? 'null');
    if (typeof raw !== 'object' || raw === null) return {};
    const { paper, orientation, margin } = raw as Record<string, unknown>;
    const out: Partial<PageChoices> = {};
    const p = PAPERS.find((value) => value === paper);
    const o = ORIENTATIONS.find((value) => value === orientation);
    const m = MARGINS.find((value) => value === margin);
    if (p !== undefined) out.paper = p;
    if (o !== undefined) out.orientation = o;
    if (m !== undefined) out.margin = m;
    return out;
  } catch {
    return {};
  }
}

export function saveChoices(choices: PageChoices): void {
  try {
    window.localStorage.setItem(KEY, JSON.stringify(choices));
  } catch {
    // Not remembered; harmless.
  }
}

/** The paper the OS region suggests (A4 when it cannot be read). */
export async function defaultPaper(): Promise<PaperSize> {
  try {
    return (await appReady()).paper;
  } catch {
    return 'a4';
  }
}

/** The command options for the choices and the image source. */
export function toOptions(source: ImagesToPdfOptions['source'], choices: PageChoices): ImagesToPdfOptions {
  return { source, paper: choices.paper, orientation: choices.orientation, marginPt: MARGIN_PT[choices.margin] };
}
