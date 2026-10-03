import type { AppError } from '../api/errors';
import { toAppError } from '../api/errors';
import { renderPage, setViewport, type RenderPriority, type RenderRequest, type ViewportHint } from '../api/render';
import { MAX_VIEWPORT_PAGES } from './buckets';
import type { RenderFrame } from '../api/frame';
import { renderCache, type CacheEntry, type ImageId, type RenderCache } from './renderCache';

/**
 * The render scheduler (ADR-002 §3, §5): the one place that asks the backend for frames. It turns "this page, at this bucket" into
 * a request that is deduplicated (a frame that is in flight is asked for once, whoever wants it), stamped with the viewport
 * generation, and put into the cache; and it tells the backend what the canvas shows so that queued renders of pages that
 * scrolled away are dropped.
 *
 * **Generations.** Every change of what the canvas shows (the visible and near pages of a document) counts up that document's
 * generation. A render carries the generation it was asked at, so the backend draws the most recent request first. The viewport
 * itself (`set_viewport`) is sent 150 ms after the last change, when scrolling has settled; until then the render queue is
 * ordered by generation alone, which already puts what is on screen now ahead of what scrolled past.
 *
 * **Quiet failures.** A request the backend withdrew (`cancelled`), one for a tile that the backend's grid does not have
 * (rounding at a page's edge) and anything for a document that was closed meanwhile are not failures: the request resolves to
 * `null`, and the page asks again on the next viewport change if it still wants the image.
 */

/** How long the viewport has to hold still before the backend is told (ADR-002 §5). */
export const VIEWPORT_SETTLE_MS = 150;

/** What the scheduler needs of the backend; `src/api/render.ts` is the real one, tests pass a fake. */
export interface RenderBackend {
  render: (request: RenderRequest) => Promise<RenderFrame>;
  setViewport: (docId: number, hint: ViewportHint) => Promise<void>;
}

const apiBackend: RenderBackend = { render: renderPage, setViewport };

export interface SchedulerOptions {
  viewportSettleMs?: number;
}

interface ViewportState {
  generation: number;
  visible: readonly number[];
  near: readonly number[];
  timer: ReturnType<typeof setTimeout> | null;
}

function sameList(a: readonly number[], b: readonly number[]): boolean {
  return a.length === b.length && a.every((value, index) => value === b[index]);
}

/** A failure that is not worth showing: the request was withdrawn, or the grid of a page's tiles is a pixel off. */
function isQuiet(error: AppError): boolean {
  return error.code === 'cancelled' || (error.code === 'invalid_argument' && error.params?.what === 'tile');
}

export class RenderScheduler {
  private readonly viewports = new Map<number, ViewportState>();
  private readonly busyListeners = new Set<(busy: boolean) => void>();
  private readonly settleMs: number;
  private pending = 0;

  constructor(
    readonly cache: RenderCache,
    private readonly backend: RenderBackend,
    options: SchedulerOptions = {},
  ) {
    this.settleMs = options.viewportSettleMs ?? VIEWPORT_SETTLE_MS;
  }

  /** The generation of the document's viewport: 0 before the first `updateViewport`. */
  generationOf(docId: number): number {
    return this.viewports.get(docId)?.generation ?? 0;
  }

  /**
   * The canvas shows `visible` pages of the document and, around them, `near` ones (lists of page indices, nearest to the
   * viewport first or in page order, at most 64 each). A different set is a new generation; the same set changes nothing. The
   * backend hears of it once the viewport has been still for 150 ms. Returns the generation.
   */
  updateViewport(docId: number, visible: readonly number[], near: readonly number[]): number {
    const bounded = (pages: readonly number[]) =>
      pages.length > MAX_VIEWPORT_PAGES ? pages.slice(0, MAX_VIEWPORT_PAGES) : pages;
    const nextVisible = bounded(visible);
    const nextNear = bounded(near);
    let state = this.viewports.get(docId);
    if (state !== undefined && sameList(state.visible, nextVisible) && sameList(state.near, nextNear)) {
      return state.generation;
    }
    state ??= { generation: 0, visible: [], near: [], timer: null };
    state.generation += 1;
    state.visible = nextVisible;
    state.near = nextNear;
    if (state.timer !== null) clearTimeout(state.timer);
    state.timer = setTimeout(() => this.sendViewport(docId), this.settleMs);
    this.viewports.set(docId, state);
    return state.generation;
  }

  private sendViewport(docId: number): void {
    const state = this.viewports.get(docId);
    if (state === undefined) return;
    state.timer = null;
    // A failed hint costs nothing but a render that was not cancelled: it is not worth a banner.
    this.backend
      .setViewport(docId, { generation: state.generation, visible: state.visible, near: state.near })
      .catch(() => undefined);
  }

  /**
   * The image `id`: from the cache, else rendered by the backend (at `priority`, for the document's current generation) and
   * cached. Resolves to `null` when there is nothing to show for it (see "Quiet failures" above) and rejects with an
   * `AppError` for a real failure.
   */
  async request(id: ImageId, priority: RenderPriority): Promise<CacheEntry | null> {
    if (this.cache.isDropped(id.docId)) return null;
    const generation = this.generationOf(id.docId);
    try {
      return await this.cache.fetch(id, () => this.load(id, priority, generation));
    } catch (caught) {
      const error = toAppError(caught);
      if (isQuiet(error) || this.cache.isDropped(id.docId)) return null;
      throw error;
    }
  }

  private async load(id: ImageId, priority: RenderPriority, generation: number) {
    this.setPending(1);
    try {
      const frame = await this.backend.render({
        docId: id.docId,
        pageId: id.page,
        bucket: id.bucket,
        tile: id.tile ?? null,
        priority,
        generation,
      });
      return { blob: new Blob([frame.data], { type: 'image/png' }), width: frame.width, height: frame.height };
    } finally {
      this.setPending(-1);
    }
  }

  private setPending(change: 1 | -1): void {
    const before = this.pending;
    this.pending += change;
    if ((before === 0) !== (this.pending === 0)) {
      for (const listener of [...this.busyListeners]) listener(this.pending > 0);
    }
  }

  /** Whether a render is in flight. */
  get busy(): boolean {
    return this.pending > 0;
  }

  /** Calls `listener` when the scheduler goes from idle to rendering and back. Returns the way to stop. */
  onBusy(listener: (busy: boolean) => void): () => void {
    this.busyListeners.add(listener);
    return () => this.busyListeners.delete(listener);
  }

  /** A document was closed: its viewport is forgotten (and a hint still waiting is not sent) and so are its images. */
  dropDocument(docId: number): void {
    const state = this.viewports.get(docId);
    if (state?.timer !== null && state?.timer !== undefined) clearTimeout(state.timer);
    this.viewports.delete(docId);
    this.cache.dropDocument(docId);
  }
}

/** The app's scheduler, over the real backend and the app's cache. */
export const renderScheduler = new RenderScheduler(renderCache, apiBackend);
