import { useEffect } from 'react';

import type { Platform } from '../../api/app';
import { currentPlatform, isImeEvent, isInModal } from '../../actions/keys';
import { matchesBinding } from '../../actions/shortcut';
import { isTextEntry } from '../../lib/textEntry';
import { useDocuments } from '../../stores/documents';
import { readSlots, usePages } from '../../stores/pages';
import { useUi } from '../../stores/ui';
import { back, forward, historyBinding } from './actions';
import { useHistoryStore } from './store';

/** Places that keep their own Alt+arrows: crop handles (and the organize grid, by mode). */
const OWN_ARROWS = '[data-crop-rect], [data-crop-catcher], [data-keeps-alt-arrows]';

/** Whether history keys and mouse buttons may act here: not in a field, a modal, a crop handle or the organize grid. */
function mayNavigate(target: EventTarget | null): boolean {
  if (isTextEntry(target) || isInModal(target)) return false;
  if (target instanceof Element && target.closest(OWN_ARROWS) !== null) return false;
  return useUi.getState().mode !== 'pages' && useDocuments.getState().activeId !== null;
}

/** Which direction a key press asks for (DESIGN 3.11 L7), or `null`. Alt+Left/Right; on macOS Cmd+[ and Cmd+]. */
export function historyKey(
  event: KeyboardEvent,
  platform: Platform | null = currentPlatform(),
): 'back' | 'forward' | null {
  if (event.defaultPrevented || isImeEvent(event) || !mayNavigate(event.target)) return null;
  if (matchesBinding(event, historyBinding('back', platform), platform)) return 'back';
  if (matchesBinding(event, historyBinding('forward', platform), platform)) return 'forward';
  return null;
}

/** Mouse button 4 (index 3) is back, 5 (index 4) forward. */
export function historyButton(event: Pick<MouseEvent, 'button' | 'target'>): 'back' | 'forward' | null {
  if ((event.button !== 3 && event.button !== 4) || !mayNavigate(event.target)) return null;
  return event.button === 3 ? 'back' : 'forward';
}

function run(direction: 'back' | 'forward'): void {
  const docId = useDocuments.getState().activeId;
  if (docId === null) return;
  if (direction === 'back') back(docId);
  else forward(docId);
}

/** Binds the history keys and the mouse buttons 4/5 to the window while mounted. */
export function useHistoryKeys(): void {
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      const direction = historyKey(event);
      if (direction === null) return;
      // Taken even when there is nowhere to go: Alt+Left must not open the menu row or navigate the window.
      event.preventDefault();
      if (!event.repeat) run(direction);
    };
    const onMouse = (event: MouseEvent) => {
      const direction = historyButton(event);
      if (direction === null) return;
      event.preventDefault();
      if (event.type === 'mousedown') run(direction);
    };
    window.addEventListener('keydown', onKeyDown);
    window.addEventListener('mousedown', onMouse);
    window.addEventListener('mouseup', onMouse);
    window.addEventListener('auxclick', onMouse);
    return () => {
      window.removeEventListener('keydown', onKeyDown);
      window.removeEventListener('mousedown', onMouse);
      window.removeEventListener('mouseup', onMouse);
      window.removeEventListener('auxclick', onMouse);
    };
  }, []);
}

/** Renders nothing: it hosts the keys and keeps the history in step with the open documents and their pages. Mount once (the shell). */
export function HistoryEffects(): null {
  useHistoryKeys();
  useEffect(() => {
    const sync = () => {
      const { byDoc } = useHistoryStore.getState();
      const open = useDocuments.getState().byId;
      for (const key of Object.keys(byDoc)) {
        const docId = Number(key);
        if (open[docId] === undefined) {
          useHistoryStore.getState().drop(docId);
          continue;
        }
        const slots = readSlots(docId);
        if (slots.length > 0) useHistoryStore.getState().prune(docId, new Set(slots.map((slot) => slot.id)));
      }
    };
    const stops = [useDocuments.subscribe(sync), usePages.subscribe(sync)];
    return () => stops.forEach((stop) => stop());
  }, []);
  return null;
}
