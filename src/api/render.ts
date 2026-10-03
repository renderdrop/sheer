import { call } from './call';
import { toAppError } from './errors';
import { parseFrame, type RenderFrame } from './frame';

/**
 * The render pipeline's commands (ARCHITECTURE section 5, ADR-002): one frame of a page, the pages the canvas shows, and the size
 * of every page. The cache and the scheduler (`src/engine`) are the only callers of the first two.
 */

/** How urgent a render is. The page is on screen, just outside the viewport, or a thumbnail of the left panel. */
export type RenderPriority = 'visible' | 'near' | 'thumbnail';

/** One frame to render. */
export interface RenderRequest {
  docId: number;
  /** The page's position until pages can be reordered (M3). */
  pageId: number;
  /** The zoom bucket: the page is drawn at `2^(bucket / 4)` device pixels per point (`src/engine/buckets.ts`). */
  bucket: number;
  /** `[column, row]` of a 1024 px tile of the page at that scale; absent for the whole page, which has to fit a frame. */
  tile?: readonly [number, number] | null;
  priority: RenderPriority;
  /** Counts the canvas's viewport changes; of two equally urgent renders the more recent goes first. */
  generation: number;
}

/**
 * Renders one frame (the whole page or one tile) to PNG. The response is a validated frame (ADR-002 §6). Rejects with
 * `cancelled` when the backend withdrew the request before it started (the page left the viewport, the document was closed),
 * which is nothing to report, and with `limit_exceeded` when a whole page is too large for one frame at this bucket (the
 * caller asks for tiles).
 */
export async function renderPage(request: RenderRequest): Promise<RenderFrame> {
  const body = await call<ArrayBuffer>('render_page', {
    req: {
      docId: request.docId,
      pageId: request.pageId,
      bucket: request.bucket,
      tile: request.tile ?? null,
      priority: request.priority,
      generation: request.generation,
    },
  });
  const frame = parseFrame(new Uint8Array(body));
  if (frame === null) throw toAppError(null);
  return frame;
}

/** The pages on screen and those just around them, as of one viewport generation (at most 64 of each). */
export interface ViewportHint {
  generation: number;
  visible: readonly number[];
  near: readonly number[];
}

/** Tells the backend which pages the canvas shows, so it can drop queued renders of pages that left the viewport. */
export function setViewport(docId: number, hint: ViewportHint): Promise<void> {
  return call<void>('set_viewport', { docId, hint });
}

/** The size of a page in PDF points. */
export type PageSize = readonly [width: number, height: number];

/** The most pages the backend opens (`MAX_PAGES`); a longer answer is not one of its. */
export const MAX_PAGES = 50_000;

/** The largest page side the backend reports, in points (`MAX_PAGE_SIDE_PT`). */
export const MAX_PAGE_SIDE_PT = 14_400;

function isPageSize(value: unknown): value is PageSize {
  return (
    Array.isArray(value) &&
    value.length === 2 &&
    value.every(
      (side: unknown) => typeof side === 'number' && Number.isFinite(side) && side > 0 && side <= MAX_PAGE_SIDE_PT,
    )
  );
}

/**
 * The size in points of every page of an open document, in page order. An answer that is not a list of sizes is an internal
 * error, like a malformed frame: the layout needs a usable size for every page.
 */
export async function getPageSizes(docId: number): Promise<PageSize[]> {
  const answer = await call<unknown>('get_page_sizes', { docId });
  if (!Array.isArray(answer) || answer.length > MAX_PAGES) throw toAppError(null);
  const sizes: PageSize[] = [];
  for (const item of answer as unknown[]) {
    if (!isPageSize(item)) throw toAppError(null);
    sizes.push([item[0], item[1]]);
  }
  return sizes;
}
