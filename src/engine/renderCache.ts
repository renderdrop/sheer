import type { TileIndex } from './buckets';

/**
 * The render cache (ADR-002 §4): an LRU of the PNG frames the backend rendered, in Blobs, within a byte budget. The frontend
 * owns pixel memory; the backend caches none. A module singleton (`renderCache`), not store state (ARCHITECTURE section 8).
 *
 * - **Keys** are `doc:page:rev:bucket[:column,row]`. The display's pixel ratio is part of the bucket (`bucketFor` folds zoom and
 *   ratio into one number), so an image made for a 2x display is not offered to a 1x one at the same zoom, and two zooms that
 *   share a bucket share an image. `rev` is the page's revision (the backend raises it when the page's pixels change, so stale
 *   images age out); it is 0 until pages can change.
 * - **Budget.** 256 MiB by default, within 128 to 1024 MiB. Over it, the least recently used entries go, except the pinned
 *   ones: the pages that are mounted pin what they show, so the page in front of the user is never evicted from under them.
 * - **Object URLs** are made when an `<img>` first needs one and revoked when the entry leaves the cache, so a long session does
 *   not leak them.
 * - **In-flight requests are deduplicated**: asking for a key that is being rendered returns the request in flight.
 * - **Best available.** A page shows the best image it has (the smallest bucket at least as sharp as wanted, else the sharpest
 *   one), scaled by CSS, while the exact bucket is on its way.
 */

const MIB = 1024 * 1024;
/** Default budget and the range it may be set within (ADR-002 §4). */
export const DEFAULT_BUDGET_BYTES = 256 * MIB;
export const MIN_BUDGET_BYTES = 128 * MIB;
export const MAX_BUDGET_BYTES = 1024 * MIB;
/**
 * How many dropped documents the cache remembers, so that an answer that arrives late is refused (`isDropped`). The oldest is
 * forgotten past this: an answer is at most one render deadline (10 s) late, and the backend has at most 32 documents open and a
 * hundred or so renders in flight, so a document that was dropped this many drops ago has nothing on its way.
 */
export const MAX_DROPPED_REMEMBERED = 256;

/** What identifies a rendered image. `tile` is absent for the whole page. */
export interface ImageId {
  docId: number;
  page: number;
  /** The page's annotation revision (the backend's `pageRev`; 0 until its pixels change). */
  rev: number;
  /** The page slot's revision (a rotation raises it); with `rev` it is a tuple, not a sum. Absent is 0. */
  slotRev?: number;
  bucket: number;
  tile?: TileIndex | null;
}

/** The key of an image in the cache. */
export function imageKey(id: ImageId): string {
  const slot = id.slotRev === undefined || id.slotRev === 0 ? '' : `-${id.slotRev}`;
  const page = `${id.docId}:${id.page}:${id.rev}${slot}:${id.bucket}`;
  return id.tile === undefined || id.tile === null ? page : `${page}:${id.tile[0]},${id.tile[1]}`;
}

/** What a loader produces: the PNG and its size in pixels. */
export interface RenderedImage {
  blob: Blob;
  width: number;
  height: number;
}

/** An image in the cache. Never mutate it. */
export interface CacheEntry extends ImageId, RenderedImage {
  key: string;
  /** What the entry counts against the budget: the size of its PNG. */
  bytes: number;
}

export interface RenderCacheOptions {
  budgetBytes?: number;
  /** `URL.createObjectURL` and `URL.revokeObjectURL` by default; tests pass their own. */
  createUrl?: (blob: Blob) => string;
  revokeUrl?: (url: string) => void;
}

/** A budget inside the allowed range; the default for anything that is not a finite number. */
export function clampBudget(bytes: number): number {
  if (!Number.isFinite(bytes)) return DEFAULT_BUDGET_BYTES;
  return Math.min(MAX_BUDGET_BYTES, Math.max(MIN_BUDGET_BYTES, bytes));
}

type Listener = () => void;

/** Everything the cache knows about one page: its entries are found through `pageIndex`. */
function pageId(docId: number, page: number): string {
  return `${docId}:${page}`;
}

export class RenderCache {
  private budget: number;
  private readonly createUrl: (blob: Blob) => string;
  private readonly revokeUrl: (url: string) => void;
  /** Least recently used first (a Map keeps insertion order, and a touch re-inserts). */
  private readonly entries = new Map<string, CacheEntry>();
  private readonly urls = new Map<string, string>();
  private readonly inflight = new Map<string, Promise<CacheEntry | null>>();
  /** The keys each owner holds. An entry is pinned while any owner holds it. */
  private readonly pins = new Map<object, ReadonlySet<string>>();
  /** Whole-page entries by page, then by bucket: what `best` searches. */
  private readonly wholePages = new Map<string, Map<number, CacheEntry>>();
  private readonly listeners = new Map<string, Set<Listener>>();
  private readonly versions = new Map<string, number>();
  private readonly closed = new Set<number>();
  private total = 0;

  constructor(options: RenderCacheOptions = {}) {
    this.budget = clampBudget(options.budgetBytes ?? DEFAULT_BUDGET_BYTES);
    this.createUrl = options.createUrl ?? ((blob) => URL.createObjectURL(blob));
    this.revokeUrl = options.revokeUrl ?? ((url) => URL.revokeObjectURL(url));
  }

  /** What the entries weigh together. */
  get bytes(): number {
    return this.total;
  }

  get size(): number {
    return this.entries.size;
  }

  get budgetBytes(): number {
    return this.budget;
  }

  /** Changes the budget (clamped to the allowed range) and evicts down to it. */
  setBudget(bytes: number): void {
    this.budget = clampBudget(bytes);
    this.evict();
  }

  /** The entry for `key`, marked as the most recently used; `undefined` if there is none. */
  get(key: string): CacheEntry | undefined {
    const entry = this.entries.get(key);
    if (entry === undefined) return undefined;
    this.entries.delete(key);
    this.entries.set(key, entry);
    return entry;
  }

  /** The entry for `key` without counting as a use. */
  peek(key: string): CacheEntry | undefined {
    return this.entries.get(key);
  }

  has(key: string): boolean {
    return this.entries.has(key);
  }

  /**
   * The best whole-page image of the page to show while `bucket` is rendered: the entry of the smallest bucket that is at least
   * as sharp as `bucket` (so it is scaled down), else the sharpest one there is (scaled up, soft but there). `undefined` if
   * the page has none. Tiles are not considered. It is marked as used. `except` is a key to leave out: the image that is about
   * to replace the one this is for.
   */
  best(docId: number, page: number, rev: number, bucket: number, except?: string, slotRev = 0): CacheEntry | undefined {
    const buckets = this.wholePages.get(pageId(docId, page));
    if (buckets === undefined) return undefined;
    let above: CacheEntry | undefined;
    let below: CacheEntry | undefined;
    for (const entry of buckets.values()) {
      if (entry.rev !== rev || entry.slotRev !== slotRev || entry.key === except) continue;
      if (entry.bucket >= bucket) {
        if (above === undefined || entry.bucket < above.bucket) above = entry;
      } else if (below === undefined || entry.bucket > below.bucket) {
        below = entry;
      }
    }
    const found = above ?? below;
    if (found !== undefined) this.get(found.key);
    return found;
  }

  /**
   * Stores a rendered image and evicts down to the budget. Nothing is stored for a document that was dropped (an answer that
   * arrives after its document was closed). An entry that is already there is replaced.
   */
  put(id: ImageId, image: RenderedImage): CacheEntry | null {
    if (this.closed.has(id.docId)) return null;
    const key = imageKey(id);
    this.remove(key);
    const entry: CacheEntry = {
      docId: id.docId,
      page: id.page,
      rev: id.rev,
      slotRev: id.slotRev ?? 0,
      bucket: id.bucket,
      tile: id.tile ?? null,
      blob: image.blob,
      width: image.width,
      height: image.height,
      key,
      bytes: image.blob.size,
    };
    this.entries.set(key, entry);
    this.total += entry.bytes;
    if (entry.tile === null) {
      const page = pageId(entry.docId, entry.page);
      const buckets = this.wholePages.get(page) ?? new Map<number, CacheEntry>();
      buckets.set(entry.bucket, entry);
      this.wholePages.set(page, buckets);
    }
    this.evict(key);
    this.touched(entry.docId, entry.page);
    return this.entries.get(key) ?? null;
  }

  /**
   * The image for `id`: from the cache, or from `load`. Asking while the same image is being loaded returns the request that
   * is in flight, so a page that mounts twice, or two pages that want the same bucket, render once. Resolves to `null` when
   * nothing was stored (the document was dropped meanwhile). Rejects when `load` does.
   */
  fetch(id: ImageId, load: () => Promise<RenderedImage>): Promise<CacheEntry | null> {
    const key = imageKey(id);
    const cached = this.get(key);
    if (cached !== undefined) return Promise.resolve(cached);
    const pending = this.inflight.get(key);
    if (pending !== undefined) return pending;
    // Whatever happens, this request is no longer in flight (unless the document was dropped and the image asked for anew).
    const settle = () => {
      if (this.inflight.get(key) === request) this.inflight.delete(key);
    };
    const request: Promise<CacheEntry | null> = load().then(
      (image) => {
        settle();
        return this.put(id, image);
      },
      (error: unknown) => {
        settle();
        throw error;
      },
    );
    this.inflight.set(key, request);
    return request;
  }

  /** Whether the image is being loaded now. */
  isInflight(id: ImageId): boolean {
    return this.inflight.has(imageKey(id));
  }

  /** How many images are being loaded. */
  get inflightCount(): number {
    return this.inflight.size;
  }

  /**
   * The URL to show `entry` with. It is made on first use and lives as long as the entry does; it is revoked when the entry is
   * evicted, so only pinned entries (the ones on screen) are safe to keep showing.
   */
  urlOf(entry: CacheEntry): string {
    const known = this.urls.get(entry.key);
    if (known !== undefined) return known;
    const url = this.createUrl(entry.blob);
    this.urls.set(entry.key, url);
    return url;
  }

  /** A URL of its own for a blob: it outlives the entry (evicted or dropped) until `releaseUrl`. */
  leaseUrl(blob: Blob): string {
    return this.createUrl(blob);
  }

  releaseUrl(url: string): void {
    this.revokeUrl(url);
  }

  /**
   * Sets what `owner` shows: those entries are kept whatever the budget says, until the owner pins something else or
   * releases them. One owner per mounted page.
   */
  pin(owner: object, keys: Iterable<string>): void {
    const next = new Set(keys);
    const previous = this.pins.get(owner);
    if (previous !== undefined && previous.size === next.size && [...next].every((key) => previous.has(key))) return;
    if (next.size === 0) this.pins.delete(owner);
    else this.pins.set(owner, next);
    // Entries that were kept only by this owner may be over the budget now.
    this.evict();
  }

  /** Releases everything `owner` pinned. */
  unpin(owner: object): void {
    if (this.pins.delete(owner)) this.evict();
  }

  /**
   * Forgets every image of a document that was closed and refuses what is still in flight for it. Document ids are never
   * reused in a session, so the document stays dropped (the last `MAX_DROPPED_REMEMBERED` of them: an older one has nothing
   * on its way any more). What the cache keeps about its pages goes too: their versions, except those of a page that is still
   * listening, which are released when it stops.
   */
  dropDocument(docId: number): void {
    // Remembered as the most recent drop; the oldest one is forgotten when there are too many.
    this.closed.delete(docId);
    this.closed.add(docId);
    for (const old of this.closed) {
      if (this.closed.size <= MAX_DROPPED_REMEMBERED) break;
      this.closed.delete(old);
    }
    // What is still in flight for it is not waited for any more: it will not be stored, and a request that comes later is a new one.
    for (const key of [...this.inflight.keys()]) if (key.startsWith(`${docId}:`)) this.inflight.delete(key);
    const pages = new Set<string>();
    for (const [key, entry] of [...this.entries]) {
      if (entry.docId !== docId) continue;
      pages.add(pageId(entry.docId, entry.page));
      this.remove(key);
    }
    for (const page of pages) this.notify(page);
    // A version is only read by a page that listens to it. Nobody will ask for the pages of a closed document again.
    for (const page of [...this.versions.keys()]) {
      if (page.startsWith(`${docId}:`) && !this.listeners.has(page)) this.versions.delete(page);
    }
  }

  /** Whether `dropDocument` was called for the document. */
  isDropped(docId: number): boolean {
    return this.closed.has(docId);
  }

  /** A document is open: images of it are stored again. (Ids are never reused in a session; this is for a document that is shown anew.) */
  admit(docId: number): void {
    this.closed.delete(docId);
  }

  /** Empties the cache (and revokes every URL). Documents stay as they are. */
  clear(): void {
    const pages = new Set([...this.entries.values()].map((entry) => pageId(entry.docId, entry.page)));
    for (const key of [...this.entries.keys()]) this.remove(key);
    for (const page of pages) this.notify(page);
  }

  /**
   * Calls `listener` whenever an entry of the page is added or removed, and returns the way to stop. With `version`, which
   * changes at the same moments, this is what `useSyncExternalStore` needs.
   */
  subscribe(docId: number, page: number, listener: Listener): () => void {
    const id = pageId(docId, page);
    const set = this.listeners.get(id) ?? new Set<Listener>();
    set.add(listener);
    this.listeners.set(id, set);
    return () => {
      set.delete(listener);
      if (set.size === 0 && this.listeners.get(id) === set) {
        this.listeners.delete(id);
        // The last page that listened to a closed document's page lets go of what is kept for it.
        if (this.closed.has(docId)) this.versions.delete(id);
      }
    };
  }

  /** A number that changes when an entry of the page is added or removed. */
  version(docId: number, page: number): number {
    return this.versions.get(pageId(docId, page)) ?? 0;
  }

  private isPinned(key: string): boolean {
    for (const keys of this.pins.values()) if (keys.has(key)) return true;
    return false;
  }

  /** Drops least recently used entries until the budget holds. `keep` (the entry that was just added) always stays. */
  private evict(keep?: string): void {
    if (this.total <= this.budget) return;
    const pages = new Set<string>();
    for (const [key, entry] of [...this.entries]) {
      if (this.total <= this.budget) break;
      if (key === keep || this.isPinned(key)) continue;
      pages.add(pageId(entry.docId, entry.page));
      this.remove(key);
    }
    for (const page of pages) this.notify(page);
  }

  /** Takes an entry out: its bytes, its URL and its place in the page index. Does not notify. */
  private remove(key: string): void {
    const entry = this.entries.get(key);
    if (entry === undefined) return;
    this.entries.delete(key);
    this.total -= entry.bytes;
    const url = this.urls.get(key);
    if (url !== undefined) {
      this.urls.delete(key);
      this.revokeUrl(url);
    }
    if (entry.tile === null) {
      const page = pageId(entry.docId, entry.page);
      const buckets = this.wholePages.get(page);
      if (buckets?.get(entry.bucket) === entry) {
        buckets.delete(entry.bucket);
        if (buckets.size === 0) this.wholePages.delete(page);
      }
    }
  }

  private touched(docId: number, page: number): void {
    this.notify(pageId(docId, page));
  }

  private notify(page: string): void {
    this.versions.set(page, (this.versions.get(page) ?? 0) + 1);
    for (const listener of [...(this.listeners.get(page) ?? [])]) listener();
  }
}

/** The app's cache. */
export const renderCache = new RenderCache();
