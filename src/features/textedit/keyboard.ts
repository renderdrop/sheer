import { useEffect } from 'react';
import { create } from 'zustand';

import type { LineKey } from '../../api/textEdit';
import { isImeEvent, isInCanvas, isTextEntry } from '../../actions/keys';
import { selectActiveId, useDocuments } from '../../stores/documents';
import { readSlots } from '../../stores/pages';
import { useUi } from '../../stores/ui';
import { openEdit } from './actions';
import { loadLines, neighbourLine } from './lines';

/** What a key does inside the edit box (DESIGN 3.10 E1, E7). */
export type EditKey = 'commit' | 'cancel' | 'next' | 'previous' | 'save' | 'undoTyping' | 'ignore';

export interface KeyLike {
  key: string;
  shiftKey: boolean;
  ctrlKey: boolean;
  metaKey: boolean;
  altKey: boolean;
  isComposing?: boolean;
  keyCode?: number;
}

/**
 * The meaning of a key press in the box, `null` for the keys that type or move the caret natively (arrows, Home, End, Ctrl/Cmd+A,
 * word jumps, Shift selection). Composition keys are never ours. Shift+Enter is ignored: no new paragraphs in v1.5.
 */
export function editKeyOf(e: KeyLike): EditKey | null {
  if (e.isComposing === true || e.keyCode === 229) return null;
  const mod = e.ctrlKey || e.metaKey;
  const key = e.key.length === 1 ? e.key.toLowerCase() : e.key;
  if (mod && !e.altKey) {
    if (key === 'z' || key === 'y') return 'undoTyping';
    if (key === 's') return 'save';
    return null;
  }
  if (e.altKey) return null;
  if (key === 'Enter') return e.shiftKey ? 'ignore' : 'commit';
  if (key === 'Escape') return 'cancel';
  if (key === 'Tab') return e.shiftKey ? 'previous' : 'next';
  return null;
}

/** The line the keyboard focus outline is on while no line is being edited (DESIGN 3.10 E6, E7). */
export interface KeyboardFocus {
  docId: number;
  pageId: number;
  key: LineKey;
}

interface FocusState {
  focus: KeyboardFocus | null;
  set: (focus: KeyboardFocus | null) => void;
}

export const useLineFocus = create<FocusState>()((set) => ({ focus: null, set: (focus) => set({ focus }) }));

/** Whether a line with this key on this page has the keyboard focus outline. */
export const isFocused = (focus: KeyboardFocus | null, docId: number, pageId: number, key: LineKey): boolean =>
  focus !== null &&
  focus.docId === docId &&
  focus.pageId === pageId &&
  focus.key.line === key.line &&
  focus.key.rev === key.rev;

async function onKeyDown(event: KeyboardEvent): Promise<void> {
  if (event.defaultPrevented || isImeEvent(event) || isTextEntry(event.target) || !isInCanvas(event.target)) return;
  if (useUi.getState().activeTool !== 'editText') return;
  const docId = selectActiveId(useDocuments.getState());
  if (docId === null || event.ctrlKey || event.metaKey || event.altKey) return;
  const focus = useLineFocus.getState();
  const current = focus.focus !== null && focus.focus.docId === docId ? focus.focus : null;
  if (event.key === 'Tab') {
    event.preventDefault();
    const first = readSlots(docId)[0]?.id ?? 0;
    const from = current === null ? null : current.key;
    const found = await neighbourLine(docId, current?.pageId ?? first, from, event.shiftKey ? -1 : 1);
    if (found === null) {
      focus.set(null);
      return;
    }
    focus.set({ docId, pageId: found.pageId, key: found.line.key });
    return;
  }
  if ((event.key === 'Enter' || event.key === 'F2') && current !== null) {
    event.preventDefault();
    const line = (await loadLines(docId, current.pageId)).find((l) => l.key.line === current.key.line);
    if (line !== undefined && line.editable.type !== 'no') {
      focus.set(null);
      await openEdit({ docId, pageId: current.pageId, line, caret: 'end' });
    }
  }
}

let listeners = 0;
const handler = (event: KeyboardEvent) => void onKeyDown(event);

/** Tab, Shift+Tab, Enter and F2 over the lines while the tool is active and no line is open; one listener for all pages. */
export function useLineKeys(): void {
  useEffect(() => {
    if (listeners === 0) window.addEventListener('keydown', handler);
    listeners += 1;
    return () => {
      listeners -= 1;
      if (listeners === 0) window.removeEventListener('keydown', handler);
    };
  }, []);
}
