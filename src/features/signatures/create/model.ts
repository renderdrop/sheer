import type { SignatureArt } from '../../../api/signatures';
import type { SignatureRole } from '../../../api/library';
import { inkPaths, pathToD, type InkSample, type PathCmd } from '../ink';

/** The ways to make a signature (DESIGN 3.33). */
export type SigTab = 'draw' | 'type' | 'image';

/** The ink of a signature: Ink or `--ink-signature` (DESIGN v2 1.4). */
export type SigColour = 'ink' | 'signature';

/** Nominal stroke width of the pad in px; velocity and pressure move it between 0.45 and 1.5 times (see `../ink`). */
export const PAD_WIDTH_PX = 3;
/** A mouse reports no pressure: the neutral 0.5, which leaves the width to the velocity alone. */
export const MOUSE_PRESSURE = 0.5;
/** Typing waits this long after the last key before the backend makes the outlines. */
export const TYPE_DEBOUNCE_MS = 250;
/** Longest initials the Type tab suggests. */
const MAX_INITIALS = 4;

const TAB_KEY = 'sheer.signatureTab';
const TABS: readonly string[] = ['draw', 'type', 'image'];

/** The pressure of a pointer sample: a mouse is constant, a pen or finger reports its own (0 means none reported). */
export function samplePressure(pointerType: string, pressure: number): number {
  if (pointerType === 'mouse' || !Number.isFinite(pressure) || pressure <= 0) return MOUSE_PRESSURE;
  return Math.min(pressure, 1);
}

/** The Bézier outlines of the strokes, in pad pixels, as the backend takes them. */
export function strokesToOutlines(strokes: readonly (readonly InkSample[])[]): PathCmd[][] {
  return inkPaths(strokes, PAD_WIDTH_PX);
}

/** The SVG path data of vector art: one subpath per outline, filled with the nonzero rule. */
export const pathData = pathToD;

export function isVector(art: SignatureArt): art is Extract<SignatureArt, { type: 'vector' }> {
  return art.type === 'vector';
}

/** The first letters of the words of a name, upper case, for the initials variant. */
export function initialsOf(name: string): string {
  const letters = name
    .split(/\s+/)
    .map((word) => Array.from(word)[0] ?? '')
    .filter((letter) => letter !== '');
  return letters.slice(0, MAX_INITIALS).join('').toUpperCase();
}

/** What the Type tab starts with: the author name, or its initials. */
export function typePrefill(role: SignatureRole, authorName: string): string {
  const name = authorName.trim();
  return role === 'initials' ? initialsOf(name) : Array.from(name).slice(0, 64).join('');
}

export interface CreateInput {
  tab: SigTab;
  strokes: number;
  typed: boolean;
  image: boolean;
  busy: boolean;
}

/** Whether Create can run: the active tab has something to make. */
export function canCreate({ tab, strokes, typed, image, busy }: CreateInput): boolean {
  if (busy) return false;
  return tab === 'draw' ? strokes > 0 : tab === 'type' ? typed : image;
}

/** The tab of last time; `type` the first time, as it works without a pointer. */
export function loadTab(): SigTab {
  try {
    const value = window.localStorage.getItem(TAB_KEY);
    if (value !== null && TABS.includes(value)) return value as SigTab;
  } catch {
    // Storage may be unavailable; the default is fine.
  }
  return 'type';
}

export function saveTab(tab: SigTab): void {
  try {
    window.localStorage.setItem(TAB_KEY, tab);
  } catch {
    // Not remembering the tab is harmless.
  }
}
