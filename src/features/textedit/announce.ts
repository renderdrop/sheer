import type { MessageParams, PlainKey } from '../../i18n';
import { refusalKey } from './refusalKey';
import type { EditSession, Refusal } from './store';

/** What the live region says, as a key (translated where it is shown, so a language change needs no state). */
export interface Announcement {
  key: PlainKey;
  params?: MessageParams;
  /** Errors are assertive, everything else polite (DESIGN 3.10 E8). */
  level: 'polite' | 'assertive';
}

export interface Snapshot {
  session: EditSession | null;
  refusal: Refusal | null;
  /** Umbrechen; absent counts as unchanged. */
  reflow?: boolean;
}

/** Per-session memory: the overflow is announced once, the substitute whenever its character count changes. */
export interface Memory {
  overflowSaid: boolean;
  fallbackCount: number;
}

export const freshMemory = (): Memory => ({ overflowSaid: false, fallbackCount: 0 });

const sameLine = (a: EditSession, b: EditSession): boolean =>
  a.docId === b.docId &&
  a.pageId === b.pageId &&
  a.line.key.rev === b.line.key.rev &&
  a.line.key.line === b.line.key.line;

/**
 * The announcements that the step from `prev` to `next` causes (DESIGN 3.10 E8). The store has no commit signal, so a session that
 * ends (or moves to another line) while it was `busy` counts as committed and any other end as cancelled. `memory` is updated.
 */
export function announcementsFor(prev: Snapshot, next: Snapshot, memory: Memory): Announcement[] {
  const out: Announcement[] = [];
  const before = prev.session;
  const after = next.session;
  const moved = before !== null && after !== null && !sameLine(before, after);
  if (before !== null && (after === null || moved)) {
    out.push({
      key: before.status === 'busy' ? 'editText.announce.committed' : 'editText.announce.cancelled',
      level: 'polite',
    });
  }
  if (after !== null && (before === null || moved)) {
    Object.assign(memory, freshMemory());
    out.push({ key: 'editText.announce.start', level: 'polite' });
  }
  if (after === null) Object.assign(memory, freshMemory());
  if (after !== null) {
    const count = after.fallback?.chars.length ?? 0;
    if (count > 0 && count !== memory.fallbackCount) {
      out.push({ key: 'editText.announce.fallback', params: { n: count }, level: 'polite' });
    }
    memory.fallbackCount = count;
    if (after.overflowPt > 0 && !memory.overflowSaid) {
      memory.overflowSaid = true;
      out.push({ key: 'editText.overflow', params: { n: Math.ceil(after.overflowPt) }, level: 'polite' });
    }
    if (after.status === 'error' && (before === null || moved || before.status !== 'error')) {
      out.push({ key: 'editText.error', level: 'assertive' });
    }
  }
  if (
    after !== null &&
    !moved &&
    prev.reflow !== undefined &&
    next.reflow !== undefined &&
    prev.reflow !== next.reflow
  ) {
    out.push({ key: next.reflow ? 'editText.announce.reflowOn' : 'editText.announce.reflowOff', level: 'polite' });
  }
  // Only a click on refused text is said; a hover is the tooltip's business.
  if (next.refusal !== null && next.refusal.via === 'click' && next.refusal !== prev.refusal) {
    out.push({ key: refusalKey(next.refusal.reason), level: 'polite' });
  }
  return out;
}
