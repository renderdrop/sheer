import type { TextLineInfo } from '../../api/textEdit';
import { useAnnotations } from '../../stores/annotations';
import { pageNumberOf } from '../../stores/pages';
import { jumpToHit } from '../search/jump';
import { distinctChars, faceOf, knownLines, loadLines, neighbourLine, paragraphNeighbour, paragraphOf } from './lines';
import { unionRect } from './model';
import { useTextEdit } from './store';

/**
 * Commit, cancel and retry of the open line edit (DESIGN 3.10 E1, E6), and opening a line. Seam of v1.5.1 wave 2: the mini bar only
 * calls `commitEdit`, `cancelEdit` and `retryEdit`. One committed line is one document undo step; an unchanged text is no command.
 */

/** Where the caret goes when a line opens: the end, or the glyph boundary nearest to a client point (a click). */
export type Caret = 'end' | { x: number; y: number };

let pendingCaret: Caret = 'end';

/** The caret the box that just opened asks for (read once). */
export function takeCaret(): Caret {
  const caret = pendingCaret;
  pendingCaret = 'end';
  return caret;
}

export interface OpenTarget {
  docId: number;
  pageId: number;
  line: TextLineInfo;
  caret?: Caret;
  /** Scroll the line into view first (keyboard navigation onto another page). */
  reveal?: boolean;
}

const sameLine = (a: TextLineInfo, b: TextLineInfo) => a.key.rev === b.key.rev && a.key.line === b.key.line;

function close(): void {
  useTextEdit.getState().set({ session: null, anchor: null, rule: null });
}

/** Opens a line; commits the open one first. `false` if the commit failed (that line stays open) or the line is not editable. */
export async function openEdit(target: OpenTarget): Promise<boolean> {
  const { docId, pageId, line } = target;
  if (line.editable.type === 'no') return false;
  const open = useTextEdit.getState().session;
  if (open !== null) {
    if (open.docId === docId && open.pageId === pageId && sameLine(open.line, line)) return true;
    if (!(await commitAndClose())) return false;
  }
  if (target.reveal === true) {
    const { box } = line;
    jumpToHit(docId, {
      index: -1,
      page: pageId,
      quads: [
        [
          { x: box.x, y: box.y },
          { x: box.x + box.w, y: box.y },
          { x: box.x, y: box.y + box.h },
          { x: box.x + box.w, y: box.y + box.h },
        ],
      ],
    });
  }
  pendingCaret = target.caret ?? 'end';
  const fallback = line.editable.type === 'fallback' ? line.editable.face : null;
  // Umbrechen defaults on for a line of a multi-line paragraph (ADR-132); the user can switch it off for this edit.
  const known = knownLines(docId, pageId);
  const multi = known !== null && paragraphOf(known, line).length > 1;
  useTextEdit.getState().set({
    reflow: multi,
    refusal: null,
    anchor: null,
    rule: null,
    noticeAnchor: null,
    notice: fallback === null ? null : { kind: 'notEmbedded', font: line.font.name, face: fallback, chars: [] },
    session: {
      docId,
      pageId,
      pageNumber: pageNumberOf(docId, pageId),
      line,
      draft: line.text,
      status: 'editing',
      overflowPt: 0,
      fallback: fallback === null ? null : { face: fallback, chars: distinctChars(line.text) },
    },
  });
  return true;
}

/** Sends the draft; closes the box on success. `false` when the box stays (busy, or an error that keeps the text editable). */
export async function commitAndClose(): Promise<boolean> {
  const store = useTextEdit.getState();
  const session = store.session;
  if (session === null) return true;
  if (session.status === 'busy') return false;
  if (session.draft === session.line.text) {
    close();
    store.set({ notice: null, noticeAnchor: null });
    return true;
  }
  store.patchSession({ status: 'busy' });
  try {
    const changes = await useAnnotations.getState().apply(session.docId, {
      type: 'editTextLine',
      pageId: session.pageId,
      key: session.line.key,
      text: session.draft,
      fit: 'keepStart',
      scope: store.reflow ? 'paragraph' : 'line',
    });
    const original = new Set(session.line.text);
    const inserted = distinctChars(session.draft).filter((c) => !original.has(c));
    const substitute = session.line.editable.type === 'fallback' ? session.line.editable.face : null;
    // The notice after Apply anchors below the whole paragraph (box and rule), never over its neighbours.
    const { anchor, rule } = useTextEdit.getState();
    const lastBox = anchor === null ? null : unionRect(anchor, rule);
    const missing = changes.warnings?.includes('fontFallback') === true && substitute === null && inserted.length > 0;
    // A notice that outlives the box (a substitute font, missing glyphs) keeps the box's last rect as its anchor.
    const kept = substitute !== null ? useTextEdit.getState().notice : null;
    close();
    useTextEdit.getState().set({
      noticeAnchor: missing || kept !== null ? lastBox : null,
      notice: missing
        ? {
            kind: 'missingGlyphs',
            font: session.line.font.name,
            face: faceOf(session.line.font.name),
            chars: inserted,
          }
        : kept,
    });
    return true;
  } catch {
    useTextEdit.getState().patchSession({ status: 'error' });
    return false;
  }
}

export async function commitEdit(): Promise<void> {
  await commitAndClose();
}

export function cancelEdit(): void {
  const session = useTextEdit.getState().session;
  if (session === null || session.status === 'busy') return;
  useTextEdit.getState().reset();
}

export async function retryEdit(): Promise<void> {
  const session = useTextEdit.getState().session;
  if (session === null || session.status !== 'error') return;
  await commitAndClose();
}

/**
 * Tab and Shift+Tab: commits the open line (one step), then opens the next or previous editable line in reading order, onto the next
 * page when the page has no more. A failed commit stays on its line.
 */
export async function stepEdit(direction: 1 | -1): Promise<void> {
  const session = useTextEdit.getState().session;
  if (session === null) return;
  const { docId, pageId, line } = session;
  const target = await neighbourLine(docId, pageId, line.key, direction);
  if (target === null) return;
  const removed = session.draft === '' && session.draft !== line.text;
  if (!(await commitAndClose())) return;
  // The commit made a new revision: the keys of the old lines are gone, the index is what carries over (an emptied line is removed).
  const fresh = await loadLines(docId, target.pageId);
  const shift = removed && target.pageId === pageId && direction === 1 ? 1 : 0;
  const wanted = target.line.key.line - shift;
  const next = fresh.find((l) => l.key.line === wanted && l.editable.type !== 'no');
  if (next !== undefined) await openEdit({ docId, pageId: target.pageId, line: next, caret: 'end', reveal: true });
}

/** Whether Up or Down (Umbrechen on) has a line in the paragraph to go to; the key is the caret's when not. */
export function canStepParagraph(direction: 1 | -1): boolean {
  const session = useTextEdit.getState().session;
  if (session === null) return false;
  const lines = knownLines(session.docId, session.pageId);
  return lines !== null && paragraphNeighbour(lines, session.line, direction) !== null;
}

/**
 * Up and Down with Umbrechen on: commits the open line (the paragraph, one step), then opens the line above or below in the same
 * paragraph. `false` when there is none or the commit failed.
 */
export async function stepParagraph(direction: 1 | -1): Promise<boolean> {
  const session = useTextEdit.getState().session;
  if (session === null) return false;
  const { docId, pageId, line } = session;
  const before = knownLines(docId, pageId);
  const target = before === null ? null : paragraphNeighbour(before, line, direction);
  if (before === null || target === null) return false;
  if (!(await commitAndClose())) return false;
  // A reflow can add or remove lines of the paragraph: the lines after it move by the difference, the ones before stay.
  const fresh = await loadLines(docId, pageId);
  const shift = direction === 1 ? fresh.length - before.length : 0;
  const wanted = target.key.line + shift;
  const next = fresh.find((l) => l.key.line === wanted && l.editable.type !== 'no');
  if (next === undefined) return false;
  return openEdit({ docId, pageId, line: next, caret: 'end' });
}
