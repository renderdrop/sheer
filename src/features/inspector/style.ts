import { useMemo } from 'react';
import { create } from 'zustand';

import type { LineEnd, Rgb } from '../../api/annotations';
import { creationKind, useTools, type CreationKind } from '../../stores/tools';
import { useUi } from '../../stores/ui';
import { readRecent } from '../../stores/recentColours';
import { DEFAULT_COLOURS, HIGHLIGHT_OPACITY, migrateColour, paletteNameOf, sameRgb } from './palette';

/**
 * The style a new annotation gets (DESIGN 3.24): what the inspector's tool options edit while no annotation is selected. One style per
 * kind of annotation, so Highlight keeps yellow while Draw keeps blue. Package P6 (creation) reads it with `useAnnotationStyle()`.
 */
export interface AnnotationStyle {
  color: Rgb;
  /** 0.1 to 1. */
  opacity: number;
  /** Line width in points: 1, 2, 4 or 8 (the presets). Used by Draw, Rectangle, Ellipse, Line and Arrow. */
  width: number;
  /** Free text size in points, 6 to 144. */
  fontSize: number;
  /** The head of a line or arrow. */
  head: LineEnd;
  /** An arrow has its head at both ends (DESIGN 3.5 B11). */
  bothEnds: boolean;
}

export const STROKE_PRESETS = [1, 2, 4, 8] as const;
export const FONT_SIZES = [8, 10, 12, 14, 18, 24, 36] as const;
export const FONT_SIZE_RANGE = { min: 6, max: 144 } as const;
export const OPACITY_RANGE = { min: 0.1, max: 1, step: 0.05 } as const;

const BASE = { opacity: 1, width: 2, fontSize: 12, head: 'none', bothEnds: false } as const;

/** The defaults of every kind a tool creates. */
export const DEFAULT_STYLES: Readonly<Record<CreationKind, AnnotationStyle>> = {
  highlight: { ...BASE, opacity: HIGHLIGHT_OPACITY, color: DEFAULT_COLOURS.highlight },
  citation: { ...BASE, opacity: HIGHLIGHT_OPACITY, color: DEFAULT_COLOURS.citation },
  underline: { ...BASE, color: DEFAULT_COLOURS.underline },
  strikeout: { ...BASE, color: DEFAULT_COLOURS.strikeout },
  note: { ...BASE, color: DEFAULT_COLOURS.note },
  freeText: { ...BASE, color: DEFAULT_COLOURS.freeText },
  ink: { ...BASE, color: DEFAULT_COLOURS.ink },
  rect: { ...BASE, color: DEFAULT_COLOURS.shape },
  ellipse: { ...BASE, color: DEFAULT_COLOURS.shape },
  line: { ...BASE, color: DEFAULT_COLOURS.shape },
  arrow: { ...BASE, color: DEFAULT_COLOURS.shape, head: 'openArrow' },
};

export interface StyleStoreState {
  /** What the user changed, per kind; a kind that is not here has its default. */
  overrides: Readonly<Partial<Record<CreationKind, Partial<AnnotationStyle>>>>;
  /** Changes the style of a kind. */
  set: (kind: CreationKind, change: Partial<AnnotationStyle>) => void;
  reset: () => void;
}

const COLOUR_KEY = 'sheer.styleColours';

/**
 * The last-used colour per kind from the previous session. One that is no longer in the palette of its kind (the Okabe-Ito colours of
 * v1.1, or garbage) is dropped, so the kind falls back to its default.
 */
export function loadStoredColours(
  raw: string | null,
  custom: readonly Rgb[] = [],
): Partial<Record<CreationKind, Partial<AnnotationStyle>>> {
  if (raw === null) return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return {};
  }
  if (typeof parsed !== 'object' || parsed === null) return {};
  const out: Partial<Record<CreationKind, Partial<AnnotationStyle>>> = {};
  for (const kind of Object.keys(DEFAULT_STYLES) as CreationKind[]) {
    const fallback = DEFAULT_STYLES[kind].color;
    const stored = (parsed as Record<string, unknown>)[kind];
    let color = migrateColour(stored, paletteNameOf(kind), fallback);
    // A colour the user applied in "More colours" is kept (DESIGN 3.5 B5) as long as it is in the recent list.
    if (color === fallback)
      color = custom.find((known) => Array.isArray(stored) && sameRgb(known, stored as unknown as Rgb)) ?? fallback;
    if (color !== fallback) out[kind] = { color };
  }
  return out;
}

function readColours(): StyleStoreState['overrides'] {
  try {
    return loadStoredColours(localStorage.getItem(COLOUR_KEY), readRecent());
  } catch {
    return {};
  }
}

/**
 * The overrides at start: the last used values of the `tools` store (DESIGN v2 3.3) with the colours of the palette-checked key on top
 * (a colour of an older palette falls back to the default of its kind).
 */
function initialOverrides(): StyleStoreState['overrides'] {
  const colours = readColours();
  const out: Partial<Record<CreationKind, Partial<AnnotationStyle>>> = {};
  const stored = useTools.getState().defaults;
  for (const kind of Object.keys(DEFAULT_STYLES) as CreationKind[]) {
    const { opacity, width, fontSize, head, bothEnds } = stored[kind] ?? {};
    const rest: Partial<AnnotationStyle> = {
      ...(opacity === undefined ? {} : { opacity }),
      ...(width === undefined ? {} : { width }),
      ...(fontSize === undefined ? {} : { fontSize }),
      ...(head === undefined ? {} : { head }),
      ...(bothEnds === undefined ? {} : { bothEnds }),
    };
    const merged = { ...rest, ...colours[kind] };
    if (Object.keys(merged).length > 0) out[kind] = merged;
  }
  return out;
}

function writeColours(overrides: StyleStoreState['overrides']): void {
  try {
    const colours = Object.fromEntries(
      Object.entries(overrides).flatMap(([kind, style]) => (style?.color === undefined ? [] : [[kind, style.color]])),
    );
    localStorage.setItem(COLOUR_KEY, JSON.stringify(colours));
  } catch {
    // Storage may be unavailable; the colour then lasts for the session.
  }
}

export const useStyleStore = create<StyleStoreState>()((set) => ({
  overrides: initialOverrides(),
  set: (kind, change) => {
    set((state) => {
      const overrides = { ...state.overrides, [kind]: { ...state.overrides[kind], ...change } };
      if (change.color !== undefined) writeColours(overrides);
      return { overrides };
    });
    // The last used value is the default of the next annotation of the kind (DESIGN v2 3.3).
    useTools.getState().setDefault(kind, change);
  },
  reset: () => {
    writeColours({});
    set({ overrides: {} });
  },
}));

/** The style for `kind` now (outside React). */
export function styleFor(
  kind: CreationKind,
  overrides: StyleStoreState['overrides'] = useStyleStore.getState().overrides,
): AnnotationStyle {
  return { ...DEFAULT_STYLES[kind], ...overrides[kind] };
}

/**
 * The style a new annotation of `kind` gets; without `kind`, of the active tool's (Select, which creates nothing, answers the
 * Draw style). The same object while nothing it depends on changes.
 */
export function useAnnotationStyle(kind?: CreationKind): AnnotationStyle {
  const activeTool = useUi((state) => state.activeTool);
  const markup = useTools((state) => state.markup);
  const shapes = useTools((state) => state.shapes);
  const overrides = useStyleStore((state) => state.overrides);
  const resolved = kind ?? creationKind(activeTool, { markup, shapes }) ?? 'ink';
  return useMemo(() => styleFor(resolved, overrides), [resolved, overrides]);
}
