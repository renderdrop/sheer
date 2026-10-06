import { MAX_PREVIEW_SCALE, MIN_PREVIEW_SCALE, type TextPreview } from '../../api/textPreview';

/**
 * Timing of the live preview of an open line (ADR-129 section 1, DESIGN 3.10 E1): a request goes out 60 ms after the last keystroke,
 * 100 ms when one is still running or the last took longer than 60 ms. The newest generation wins; an older answer, a cancelled one
 * or a failed one is dropped (the CSS draft stays on screen).
 */

export const PREVIEW_DELAY_MS = 60;
export const PREVIEW_SLOW_DELAY_MS = 100;

/** Generations count up over the whole session, so the backend never sees a number go back for a page. */
let counter = 0;

export interface PreviewScheduler {
  /** A draft change: (re)starts the wait. */
  schedule: () => void;
  /** The box closed: no timer, no late answer. */
  dispose: () => void;
}

export interface SchedulerOptions {
  run: (generation: number) => Promise<TextPreview>;
  onPreview: (preview: TextPreview) => void;
  now?: () => number;
}

export function createPreviewScheduler(options: SchedulerOptions): PreviewScheduler {
  const now = options.now ?? (() => performance.now());
  let timer: ReturnType<typeof setTimeout> | null = null;
  let running = 0;
  let lastMs = 0;
  let latest = -1;
  let disposed = false;

  const fire = () => {
    timer = null;
    counter += 1;
    const generation = counter;
    latest = generation;
    running += 1;
    const started = now();
    const done = () => {
      running -= 1;
      lastMs = now() - started;
    };
    options.run(generation).then(
      (preview) => {
        done();
        if (!disposed && generation === latest) options.onPreview(preview);
      },
      () => {
        // `cancelled` (a newer request exists) and every other failure: the draft stays as it is on screen.
        done();
      },
    );
  };

  return {
    schedule: () => {
      if (disposed) return;
      if (timer !== null) clearTimeout(timer);
      const slow = running > 0 || lastMs > PREVIEW_DELAY_MS;
      timer = setTimeout(fire, slow ? PREVIEW_SLOW_DELAY_MS : PREVIEW_DELAY_MS);
    },
    dispose: () => {
      disposed = true;
      if (timer !== null) clearTimeout(timer);
      timer = null;
    },
  };
}

/** Pixels per point to ask for: the page's scale on screen times the device's, within what the backend takes. */
export const previewScale = (pxPerPt: number, dpr: number): number =>
  Math.min(MAX_PREVIEW_SCALE, Math.max(MIN_PREVIEW_SCALE, pxPerPt * dpr));

/**
 * The first and last column (pixels) holding ink in RGBA `data`: pixels that differ from the top left pixel (the page colour) by more
 * than a little. `null` for a blank picture.
 */
export function inkSpan(
  data: Uint8ClampedArray,
  width: number,
  height: number,
): { left: number; right: number } | null {
  if (width <= 0 || height <= 0 || data.length < width * height * 4) return null;
  const r = data[0] ?? 0;
  const g = data[1] ?? 0;
  const b = data[2] ?? 0;
  let left = -1;
  let right = -1;
  for (let x = 0; x < width; x += 1) {
    for (let y = 0; y < height; y += 1) {
      const i = (y * width + x) * 4;
      const d = Math.abs((data[i] ?? 0) - r) + Math.abs((data[i + 1] ?? 0) - g) + Math.abs((data[i + 2] ?? 0) - b);
      if (d > 96) {
        if (left < 0) left = x;
        right = x + 1;
        break;
      }
    }
  }
  return left < 0 ? null : { left, right };
}

/** The horizontal scale that puts the CSS text where the picture's glyphs are; 1 when either width is unknown or the two agree. */
export function scaleXFor(previewWidth: number, cssWidth: number): number {
  if (!(previewWidth > 0) || !(cssWidth > 0)) return 1;
  const s = previewWidth / cssWidth;
  return Math.abs(s - 1) < 0.002 ? 1 : Math.min(4, Math.max(0.25, s));
}
