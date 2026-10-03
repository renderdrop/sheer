import type { SignatureArt } from '../../../api/signatures';
import type { SignatureRole } from '../../../api/library';
import type { Point } from '../../../api/wire';
import { strokeOutline, type Sample } from '../../annotations/create/ink';

/** The ways to make a signature (DESIGN 3.33). */
export type SigTab = 'draw' | 'type' | 'image';

/** The ink colours of the pad: the black and blue of the annotation palette (DESIGN 3.24). */
export type SigColour = 'black' | 'blue';

/** Nominal stroke width of the pad in px; the pressure moves it between 1 and 4 (see `ink.ts`: 0.4 to 1.6 times). */
export const PAD_WIDTH_PX = 2.5;
/** A mouse draws 2 px: the pressure that gives that width at the nominal one. */
export const MOUSE_PRESSURE = (2 / PAD_WIDTH_PX - 0.4) / 1.2;
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

/** The outline polygons of the strokes, in pad pixels, as the backend takes them. */
export function strokesToOutlines(strokes: readonly (readonly Sample[])[]): Point[][] {
  return strokes.map((stroke) => strokeOutline(stroke, PAD_WIDTH_PX)).filter((polygon) => polygon.length > 0);
}

/** The SVG path of vector art: one closed subpath per polygon, filled with the nonzero rule. */
export function pathData(paths: readonly (readonly Point[])[]): string {
  return paths
    .filter((polygon) => polygon.length > 0)
    .map((polygon) => `M${polygon.map((p) => `${p.x} ${p.y}`).join('L')}Z`)
    .join('');
}

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
