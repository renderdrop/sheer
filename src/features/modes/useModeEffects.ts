import { useEffect } from 'react';

import { isImeEvent, isInModal, isTextEntry } from '../../actions/keys';
import { announce } from '../../components';
import { translators } from '../../i18n';
import { useLocaleStore } from '../../i18n/store';
import { useAnnotations } from '../../stores/annotations';
import { selectActiveId, useDocuments } from '../../stores/documents';
import { useUi } from '../../stores/ui';
import { MODE_LABEL, modeOfKey } from './model';
import { switchMode } from './switch';

/** Where a digit belongs to something else: a menu, a dialog or popover, a list, a live form field. */
const OWNS_DIGITS =
  '[role="menu"], [role="menuitem"], [role="dialog"], [role="listbox"], [role="radiogroup"] [role="radio"], [data-form-widget]';

/**
 * The keys 1 to 5 switch the mode, anywhere on the window (DESIGN v2 3.2). Not with a modifier (Ctrl+1, Ctrl+2, Ctrl+0 are the zoom
 * keys), not while the user types (inputs, contenteditable, the live form fields), not in menus, popovers and dialogs.
 */
export function handleModeKey(event: KeyboardEvent): boolean {
  if (event.defaultPrevented || event.repeat || isImeEvent(event)) return false;
  if (event.ctrlKey || event.metaKey || event.altKey || event.shiftKey) return false;
  const mode = modeOfKey(event.key);
  if (mode === null) return false;
  if (isTextEntry(event.target) || isInModal(event.target)) return false;
  if (event.target instanceof Element && event.target.closest(OWNS_DIGITS) !== null) return false;
  event.preventDefault();
  switchMode(mode);
  return true;
}

/**
 * What follows a change of mode, installed once by the mode row (it is in the editor only): the keys 1 to 5, the polite
 * announcement, and the selection of the document's annotations, which Seiten (entered or left) drops (the page grid
 * has its own selection, and it ends with the mode).
 */
export function useModeEffects(): void {
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => void handleModeKey(event);
    window.addEventListener('keydown', onKeyDown);
    const stop = useUi.subscribe((state, previous) => {
      if (state.mode === previous.mode) return;
      const t = translators[useLocaleStore.getState().locale];
      announce(t('modes.announce', { mode: t(MODE_LABEL[state.mode]) }));
      if (state.mode === 'pages' || previous.mode === 'pages') {
        const docId = selectActiveId(useDocuments.getState());
        if (docId !== null) useAnnotations.getState().clearSelection(docId);
      }
    });
    return () => {
      window.removeEventListener('keydown', onKeyDown);
      stop();
    };
  }, []);
}
