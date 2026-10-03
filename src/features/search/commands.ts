import { useEffect } from 'react';

import { currentPlatform, isTextEntry } from '../../actions/keys';
import { useUi } from '../../stores/ui';
import { stepHit } from './jump';
import { useSearch } from './store';

/**
 * Find (primary+F): shows the left panel on its Search tab and asks the field to take the focus with its text selected. The
 * panel serves the request once it is mounted, so it works also when the panel was collapsed or on another tab.
 */
export function openSearch(): void {
  const ui = useUi.getState();
  if (ui.leftPanelCollapsed) ui.setLeftPanelCollapsed(false);
  if (ui.leftPanelTab !== 'search') ui.setLeftPanelTab('search');
  useSearch.getState().requestFocus();
}

/** Marks a text field in which F3 and Shift+F3 still step through the hits (the page field of the status bar, DESIGN 3.16). */
export const FIND_KEYS_ATTRIBUTE = 'data-find-keys';

/** Whether F3 and Shift+F3 are Find next and previous on this platform: Windows only (DESIGN 3.16); macOS has primary+G. */
export function f3FindsNext(): boolean {
  return currentPlatform() === 'windows';
}

/** F3 and Shift+F3 are Find next and previous too (DESIGN 3.16, Windows). An action has one binding, so the keys live here. */
export function useFindKeys(): void {
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.defaultPrevented || event.key !== 'F3' || event.ctrlKey || event.metaKey || event.altKey) return;
      if (!f3FindsNext() || document.querySelector('[aria-modal="true"]') !== null) return;
      const inFindField = event.target instanceof Element && event.target.closest(`[${FIND_KEYS_ATTRIBUTE}]`) !== null;
      if (isTextEntry(event.target) && !inFindField) return;
      event.preventDefault();
      stepHit(event.shiftKey ? -1 : 1);
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, []);
}
