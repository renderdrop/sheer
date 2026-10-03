import type { DocumentInfo } from '../../api/documents';
import { holdDrop } from './state';

/**
 * How long opened documents are collected before they are shown. The backend opens a drop of many files one by one and pushes
 * one `opened` each; two or more within this window are one drop, which gets the merge banner (DESIGN 3.29) instead of
 * several tabs. 0 shows every document at once (tests).
 */
let windowMs = 120;
let pending: DocumentInfo[] = [];
let timer: ReturnType<typeof setTimeout> | undefined;
let adopt: ((document: DocumentInfo) => void) | null = null;

export function setDropWindow(ms: number): void {
  windowMs = ms;
}

function flush(): void {
  timer = undefined;
  const batch = pending;
  const show = adopt;
  pending = [];
  if (batch.length >= 2) holdDrop(batch);
  else if (show !== null) for (const document of batch) show(document);
}

/** Takes a document the backend opened on its own; `show` makes it a tab if it turns out not to be part of a multi-file drop. */
export function intakeOpened(document: DocumentInfo, show: (document: DocumentInfo) => void): void {
  if (windowMs <= 0) {
    show(document);
    return;
  }
  adopt = show;
  pending.push(document);
  if (timer === undefined) timer = setTimeout(flush, windowMs);
}

/** Shows what is collected now (tests, and before the window closes). */
export function flushDropBatch(): void {
  if (timer !== undefined) clearTimeout(timer);
  flush();
}
