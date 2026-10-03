import { create } from 'zustand';

/**
 * The shared-element transition of MOTION 4.5 and 4.6: something on screen (the drop's preview card, a thumbnail) becomes a page.
 * The source is noted before the document (or the jump) happens; the canvas then flies a clone of it to the page's rect. This is
 * only state: the clone is `OpenClone`, drawn by the canvas.
 */

/** A rect in window px. */
export interface SourceRect {
  left: number;
  top: number;
  width: number;
  height: number;
}

export interface OpenSource {
  rect: SourceRect;
  /** The preview card of a drop, an image (a thumbnail) or the file tile of a recents row. */
  kind: 'card' | 'image' | 'tile';
  /** The image's URL for `kind: 'image'`. */
  src?: string;
}

/** A source that is older than this was for something else and is not used. */
export const SOURCE_MAX_AGE_MS = 3000;
/** A document that opens within this long after the drag left the window was the drop. */
export const DROP_WINDOW_MS = 1500;

export interface TransitionState {
  /** The clone to fly, `null` when there is none. */
  active: { id: number; kind: 'open' | 'jump'; docId: number; page: number; source: OpenSource } | null;
  /** Counts the drops that were accepted: the preview card falls. */
  dropAccepted: number;
}

let serial = 0;

export const useTransition = create<TransitionState>()(() => ({ active: null, dropAccepted: 0 }));

let pending: { source: OpenSource; at: number } | null = null;
let dropCard: (() => OpenSource | null) | null = null;
let hoverEndedAt = Number.NEGATIVE_INFINITY;

/** The documents that were just opened and still wait for their opening zoom (fit width, at most 100 %). */
const fresh = new Set<number>();
const openedAt = new Map<number, number>();

/** How long after it opened a document's first page still makes its entrance when it mounts. */
export const ENTRANCE_WINDOW_MS = 2000;

/** How the first page of `docId` appears if it mounts now (MOTION 4.6): under a clone it only fades, else it scales in. */
export function entranceFor(docId: number): 'scale' | 'fade' | undefined {
  const at = openedAt.get(docId);
  if (at === undefined || performance.now() - at > ENTRANCE_WINDOW_MS) return undefined;
  const active = useTransition.getState().active;
  return active?.kind === 'open' && active.docId === docId ? 'fade' : 'scale';
}

export function setPendingSource(source: OpenSource): void {
  pending = { source, at: performance.now() };
}

/** The preview card says where it is (while it is shown). Returns the function that unregisters it. */
export function registerDropCard(read: () => OpenSource | null): () => void {
  dropCard = read;
  return () => {
    if (dropCard === read) dropCard = null;
  };
}

/** The drag has left the window (hovering ended): a document that opens soon was dropped. */
export function noteHoverEnded(): void {
  hoverEndedAt = performance.now();
}

/** A document arrived from the backend (not from the dialog): if the drag ended a moment ago, it was dropped; the card falls. */
export function noteOpenedFromApp(): void {
  if (performance.now() - hoverEndedAt > DROP_WINDOW_MS) return;
  hoverEndedAt = Number.NEGATIVE_INFINITY;
  const source = dropCard?.() ?? null;
  if (source !== null) setPendingSource(source);
  useTransition.setState((state) => ({ dropAccepted: state.dropAccepted + 1 }));
}

/** A new document is shown: its opening zoom is due, and the source that was noted (if any) is flown to its first page. */
export function beginOpening(docId: number): void {
  fresh.add(docId);
  openedAt.set(docId, performance.now());
  const taken = pending;
  pending = null;
  if (taken !== null && performance.now() - taken.at <= SOURCE_MAX_AGE_MS) {
    serial += 1;
    useTransition.setState({ active: { id: serial, kind: 'open', docId, page: 0, source: taken.source } });
  } else {
    useTransition.setState({ active: null });
  }
}

/** A click on a thumbnail: after the jump, a clone of the thumbnail flies to the page. */
export function launchJump(docId: number, page: number, source: OpenSource): void {
  serial += 1;
  useTransition.setState({ active: { id: serial, kind: 'jump', docId, page, source } });
}

export function finishTransition(id: number): void {
  if (useTransition.getState().active?.id === id) useTransition.setState({ active: null });
}

export function isFresh(docId: number): boolean {
  return fresh.has(docId);
}

export function resolveFresh(docId: number): void {
  fresh.delete(docId);
}

/** A document was closed: nothing is waited for any more. */
export function forgetOpening(docId: number): void {
  fresh.delete(docId);
  openedAt.delete(docId);
}

/** For tests. */
export function resetTransition(): void {
  pending = null;
  dropCard = null;
  hoverEndedAt = Number.NEGATIVE_INFINITY;
  fresh.clear();
  openedAt.clear();
  useTransition.setState({ active: null, dropAccepted: 0 });
}
