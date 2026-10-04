import manifest from './steps.json';

/** One step of the welcome tour as `steps.json` has it (the generator of the welcome document reads the same file). */
export interface TourStep {
  id: string;
  /** The page kind of the welcome document the step happens on (DESIGN 3.14). */
  page: string;
  ships: string;
  shipped: boolean;
  detect: 'auto' | 'manual';
  /** `a`: the control the coach mark points at. `b`: where it points while the tool is active (the canvas target). */
  anchor: { a: string; b?: string };
  /** Rect on the page in pt, for the canvas target. */
  target?: Rect;
  /** Highlight: the sentence's box on the page in pt; the step completes when a highlight covers half of it. */
  quad?: Rect;
  /** Reorder: the thumbnail positions in the welcome document as it ships (page S is dragged from `from` to above `to`). */
  from?: number;
  to?: number;
}

export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** Steps of tools that exist. An unshipped step does not exist at run time (DESIGN 3.14), so numbers count these only. */
export function shippedOf(steps: readonly TourStep[]): readonly TourStep[] {
  return steps.filter((step) => step.shipped);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function isPosition(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 1;
}

function parseRect(value: unknown): Rect | undefined {
  return isRecord(value) &&
    typeof value.x === 'number' &&
    typeof value.y === 'number' &&
    typeof value.w === 'number' &&
    typeof value.h === 'number'
    ? { x: value.x, y: value.y, w: value.w, h: value.h }
    : undefined;
}

/** Reads the manifest defensively: steps without a string `id` or `anchor.a` are dropped, a missing `steps` array yields none. */
export function parseSteps(data: unknown): TourStep[] {
  if (!isRecord(data) || !Array.isArray(data.steps)) return [];
  const steps: TourStep[] = [];
  for (const raw of data.steps as unknown[]) {
    if (!isRecord(raw) || typeof raw.id !== 'string' || !isRecord(raw.anchor) || typeof raw.anchor.a !== 'string')
      continue;
    const { a, b } = raw.anchor;
    const rect = parseRect(raw.target);
    const quad = parseRect(raw.quad);
    steps.push({
      id: raw.id,
      page: typeof raw.page === 'string' ? raw.page : '',
      ships: typeof raw.ships === 'string' ? raw.ships : '',
      shipped: raw.shipped === true,
      detect: raw.detect === 'manual' ? 'manual' : 'auto',
      anchor: typeof b === 'string' ? { a, b } : { a },
      ...(rect === undefined ? {} : { target: rect }),
      ...(quad === undefined ? {} : { quad }),
      ...(isPosition(raw.from) ? { from: raw.from } : {}),
      ...(isPosition(raw.to) ? { to: raw.to } : {}),
    });
  }
  return steps;
}

export const SHIPPED_STEPS: readonly TourStep[] = shippedOf(parseSteps(manifest));

/**
 * The page id (zero-based position in the file as it ships) of the welcome page of a kind (DESIGN 3.14 Editions): the kinds that
 * have a shipped step in step order, Navigate after Welcome when there would be fewer than four pages. null: no such page.
 */
export function pageIdOfKind(steps: readonly TourStep[], kind: string): number | null {
  const kinds: string[] = [];
  for (const step of steps) if (!kinds.includes(step.page)) kinds.push(step.page);
  if (kinds.length + 1 < 4) kinds.splice(1, 0, 'N');
  const index = kinds.indexOf(kind);
  return index < 0 ? null : index;
}
