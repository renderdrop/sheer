import type { DocumentInfo } from '../../api/documents';
import { holdDrop } from './state';

/**
 * How long opened documents are collected before they are shown. The backend opens a drop of many files one by one and pushes
 * one `opened` each; two or more within this window are one drop, which gets the merge banner (DESIGN 3.29) instead of
 * several tabs. 0 shows every document at once (tests).
 */
export const DROP_WINDOW_MS = 120;
/** A document opened this soon after files were dragged over the window may be part of a drop; any other (the OS, startup) is not. */
export const HOVER_GRACE_MS = 1500;

export interface DropBatcherOptions {
  windowMs?: number;
  /** Holds two or more documents of one drop for the banner. */
  hold?: (documents: readonly DocumentInfo[]) => void;
  now?: () => number;
}

/** Collects the documents the backend opened on its own; each batcher has its own state. */
export class DropBatcher {
  private windowMs: number;
  private readonly hold: (documents: readonly DocumentInfo[]) => void;
  private readonly now: () => number;
  private pending: DocumentInfo[] = [];
  private timer: ReturnType<typeof setTimeout> | undefined;
  private adopt: ((document: DocumentInfo) => void) | null = null;
  private hoverAt = Number.NEGATIVE_INFINITY;
  private hovering = false;

  constructor(options: DropBatcherOptions = {}) {
    this.windowMs = options.windowMs ?? DROP_WINDOW_MS;
    this.hold = options.hold ?? holdDrop;
    this.now = options.now ?? Date.now;
  }

  setWindow(ms: number): void {
    this.windowMs = ms;
  }

  /** Files are dragged over the window, or not any more: only a document that opens after that can be part of a drop. */
  noteHover(active: boolean): void {
    this.hovering = active;
    this.hoverAt = this.now();
  }

  private flush = (): void => {
    this.timer = undefined;
    const batch = this.pending;
    const show = this.adopt;
    this.pending = [];
    if (batch.length >= 2) this.hold(batch);
    else if (show !== null) for (const document of batch) show(document);
  };

  /** Takes a document the backend opened on its own; `show` makes it a tab if it turns out not to be part of a multi-file drop. */
  intake(document: DocumentInfo, show: (document: DocumentInfo) => void): void {
    const mayBeDrop = this.hovering || this.now() - this.hoverAt <= HOVER_GRACE_MS;
    // Nothing is waiting and no drop is under way: a single document shows at once, with no delay.
    if (this.windowMs <= 0 || (this.timer === undefined && !mayBeDrop)) {
      show(document);
      return;
    }
    this.adopt = show;
    this.pending.push(document);
    if (this.timer === undefined) this.timer = setTimeout(this.flush, this.windowMs);
  }

  /** Shows what is collected now (tests, and before the window closes). */
  flushNow(): void {
    if (this.timer !== undefined) clearTimeout(this.timer);
    this.flush();
  }
}

/** The batcher of the app window's events. */
export const appDropBatch = new DropBatcher();
