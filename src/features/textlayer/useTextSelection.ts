import { useEffect, type RefObject } from 'react';

import { announce } from '../../components';
import { isTextEntry } from '../../lib/textEntry';
import { translators } from '../../i18n';
import { useLocaleStore } from '../../i18n/store';
import { useDocuments } from '../../stores/documents';
import { pageIdAt, positionOf } from '../../stores/pages';
import { useUi } from '../../stores/ui';
import { useView } from '../../stores/view';
import { textPointer } from '../viewer/lesen';
import { peekLayer } from './cache';
import { useMultiSelectGesture, useMultiSelection } from './multiSelection';
import { hasTextSelection, selectPageText, selectionText } from './selection';

/**
 * Copy for the text layer (DESIGN 3.17). The browser's `copy` event comes from primary+C, the Edit menu and the context menu alike;
 * when the selection is in a text layer the clipboard gets the page's own text between the two boundaries (as plain text only),
 * so line breaks are the page's and a ligature is its letters. Anything else is left to the browser.
 */
export function copySelection(event: Pick<ClipboardEvent, 'clipboardData' | 'preventDefault'>): boolean {
  const selection = window.getSelection();
  if (selection === null || !hasTextSelection(selection)) return false;
  const docId = useDocuments.getState().activeId;
  if (docId === null || event.clipboardData === null) return false;
  const text = selectionText(selection, (page) => peekLayer(docId, page)?.text, {
    position: (id) => positionOf(docId, id),
    id: (position) => pageIdAt(docId, position),
  });
  if (text === null) return false;
  // A page whose layer has left the cache: what the browser would copy is the next best.
  event.clipboardData.setData('text/plain', text === '' ? selection.toString() : text);
  event.preventDefault();
  announce(translators[useLocaleStore.getState().locale]('text.copied'));
  return true;
}

/** Binds `copySelection` to the document for as long as the canvas is mounted. */
export function useTextCopy(): void {
  useEffect(() => {
    const onCopy = (event: ClipboardEvent) => void copySelection(event);
    document.addEventListener('copy', onCopy);
    return () => document.removeEventListener('copy', onCopy);
  }, []);
}

/**
 * The canvas's keys for the text: primary+A selects the text of the current page, never the whole document, and Esc clears a
 * selection (last in the Esc order: a popover, a dialog or an active tool has it first), the pinned ranges of a multi-selection
 * included (F20.7). Copy is the `copy` event above. Primary+drag adds a range (`useMultiSelectGesture`).
 */
export function useTextKeys(region: RefObject<HTMLElement | null>, docId: number | null): void {
  useMultiSelectGesture(region, docId);
  useEffect(() => {
    const element = region.current;
    if (element === null || docId === null) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.defaultPrevented) return;
      if ((event.ctrlKey || event.metaKey) && !event.altKey && !event.shiftKey && event.key.toLowerCase() === 'a') {
        // In a field the browser's own select-all is the user's (a form field on the page, a comment box).
        if (isTextEntry(event.target)) return;
        const page = pageIdAt(docId, useView.getState().byDoc[docId]?.pageIndex ?? 0) ?? 0;
        if (selectPageText(element, page, window.getSelection())) event.preventDefault();
        return;
      }
      if (event.key === 'Escape' && textPointer(useUi.getState().activeTool)) {
        const selection = window.getSelection();
        const pinned = useMultiSelection.getState().spans.length > 0;
        if (pinned) useMultiSelection.getState().clear();
        if (hasTextSelection(selection)) {
          selection?.removeAllRanges();
          event.preventDefault();
        } else if (pinned) event.preventDefault();
      }
    };
    element.addEventListener('keydown', onKeyDown);
    return () => element.removeEventListener('keydown', onKeyDown);
  }, [region, docId]);
}
