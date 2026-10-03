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
  target?: { x: number; y: number; w: number; h: number };
}

/** Steps of tools that exist. An unshipped step does not exist at run time (DESIGN 3.14), so numbers count these only. */
export function shippedOf(steps: readonly TourStep[]): readonly TourStep[] {
  return steps.filter((step) => step.shipped);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

/** Reads the manifest defensively: steps without a string `id` or `anchor.a` are dropped, a missing `steps` array yields none. */
export function parseSteps(data: unknown): TourStep[] {
  if (!isRecord(data) || !Array.isArray(data.steps)) return [];
  const steps: TourStep[] = [];
  for (const raw of data.steps as unknown[]) {
    if (!isRecord(raw) || typeof raw.id !== 'string' || !isRecord(raw.anchor) || typeof raw.anchor.a !== 'string')
      continue;
    const { a, b } = raw.anchor;
    const target = raw.target;
    const rect =
      isRecord(target) &&
      typeof target.x === 'number' &&
      typeof target.y === 'number' &&
      typeof target.w === 'number' &&
      typeof target.h === 'number'
        ? { x: target.x, y: target.y, w: target.w, h: target.h }
        : undefined;
    steps.push({
      id: raw.id,
      page: typeof raw.page === 'string' ? raw.page : '',
      ships: typeof raw.ships === 'string' ? raw.ships : '',
      shipped: raw.shipped === true,
      detect: raw.detect === 'manual' ? 'manual' : 'auto',
      anchor: typeof b === 'string' ? { a, b } : { a },
      ...(rect === undefined ? {} : { target: rect }),
    });
  }
  return steps;
}

export const SHIPPED_STEPS: readonly TourStep[] = shippedOf(parseSteps(manifest));
