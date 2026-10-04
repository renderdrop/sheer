import type { TypedFont } from '../../../api/signatures';

/** The typed signature fonts (DESIGN 3.60, ADR-058/059): bundled SIL OFL 1.1 TTFs, turned into outlines by the backend. */
export const SIGNATURE_FONTS: readonly { id: TypedFont; name: string }[] = [
  { id: 'msMadi', name: 'Ms Madi' },
  { id: 'hurricane', name: 'Hurricane' },
  { id: 'birthstone', name: 'Birthstone' },
];

export const DEFAULT_FONT: TypedFont = 'msMadi';

const FONT_KEY = 'signatureFont';
const ITEM_FONTS_KEY = 'sheer.signatureItemFonts';

const IDS: readonly string[] = SIGNATURE_FONTS.map((font) => font.id);

/** A stored font name as a font: anything unknown, such as the removed `homemadeApple`, becomes the default. */
export function normalizeFont(value: unknown): TypedFont {
  return typeof value === 'string' && IDS.includes(value) ? (value as TypedFont) : DEFAULT_FONT;
}

/** The font of last time (setting `signatureFont`); the default the first time. */
export function loadFont(): TypedFont {
  try {
    return normalizeFont(window.localStorage.getItem(FONT_KEY));
  } catch {
    return DEFAULT_FONT;
  }
}

export function saveFont(font: TypedFont): void {
  try {
    window.localStorage.setItem(FONT_KEY, font);
  } catch {
    // Not remembering the font is harmless.
  }
}

function readItemFonts(): Record<string, TypedFont> {
  try {
    const raw: unknown = JSON.parse(window.localStorage.getItem(ITEM_FONTS_KEY) ?? '{}');
    if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return {};
    // Migration: entries made with the removed font keep rendering (they are stored as paths) and now name the default.
    return Object.fromEntries(Object.entries(raw).map(([id, font]) => [id, normalizeFont(font)]));
  } catch {
    return {};
  }
}

/** The font a typed library entry was made with; `null` for entries that were not typed (or are unknown). */
export function itemFont(id: string): TypedFont | null {
  return readItemFonts()[id] ?? null;
}

/** Remembers the font of a library entry that was typed. */
export function rememberItemFont(id: string, font: TypedFont): void {
  try {
    window.localStorage.setItem(ITEM_FONTS_KEY, JSON.stringify({ ...readItemFonts(), [id]: font }));
  } catch {
    // Storage unavailable: the entry still renders; only the remembered font is lost.
  }
}

/** The next font in a roving move (wraps). */
export function stepFont(current: TypedFont, direction: 1 | -1): TypedFont {
  const at = Math.max(0, IDS.indexOf(current));
  return SIGNATURE_FONTS[(at + direction + SIGNATURE_FONTS.length) % SIGNATURE_FONTS.length]?.id ?? DEFAULT_FONT;
}
