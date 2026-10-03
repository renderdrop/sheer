import { useEffect } from 'react';

import type { Platform } from '../api/app';
import { detectPlatform } from '../lib/platform';
import { isTextEntry } from '../lib/textEntry';
import { useSettings } from '../stores/settings';
import { MODAL_SELECTOR, runAction } from './dispatch';
import { ACTIONS } from './registry';
import { isBareKey, matchesBinding, resolveBindings } from './shortcut';

/**
 * The attribute that marks the canvas (`data-action-scope="canvas"`): single-key shortcuts such as the tool letters work
 * only while focus is inside an element that has it.
 */
export const CANVAS_SCOPE_ATTRIBUTE = 'data-action-scope';

export { isTextEntry };

/** Whether `target` is inside a modal dialog (`aria-modal="true"`): the dialog owns the keyboard while it is open. */
export function isInModal(target: EventTarget | null): boolean {
  return target instanceof Element && target.closest(MODAL_SELECTOR) !== null;
}

/** `KeyboardEvent.keyCode` of a key that an input method is handling (deprecated, but the only signal WebKit gives after `compositionend`). */
const IME_KEY_CODE = 229;

/**
 * Whether the key event belongs to an input method: during a composition (`isComposing`), and for the keydown that ends one
 * in WebKit, which reports `isComposing: false` but the legacy key code 229 (the macOS WebView). Such a key is part of the
 * text being composed, never a shortcut.
 */
export function isImeEvent(event: Pick<KeyboardEvent, 'isComposing' | 'keyCode'>): boolean {
  return event.isComposing || event.keyCode === IME_KEY_CODE;
}

/** Whether `target` is the canvas or inside it. */
export function isInCanvas(target: EventTarget | null): boolean {
  return target instanceof Element && target.closest(`[${CANVAS_SCOPE_ATTRIBUTE}="canvas"]`) !== null;
}

/** The platform the shortcuts are resolved for: the backend's answer, or the user agent's until it has come. */
export function currentPlatform(): Platform | null {
  return useSettings.getState().platform ?? detectPlatform();
}

/**
 * The global key handler. Finds the action bound to the key press and runs it; returns whether a binding matched.
 *
 * - The platform's primary modifier is Cmd on macOS and Ctrl elsewhere (`matchesBinding`).
 * - It never takes a key from somewhere the user types (`isTextEntry`), from an event something else has already handled
 *   (`defaultPrevented`, which is how the menus and popovers claim their arrows and Esc), from an IME composition (`isImeEvent`,
 *   also the WebKit keydown with key code 229), or from a modal dialog (`isInModal`: Open or Close must not run behind it).
 * - A bare key (the tool letters) works only with the canvas focused (`isInCanvas`), so it can never be a typed character.
 * - A key that matches takes the browser's own meaning away (Ctrl and plus would zoom the whole window), also when the action
 *   is disabled or this is a repeat of a key that does not repeat; it just does not run then.
 */
export function handleKeyDown(event: KeyboardEvent, platform: Platform | null = currentPlatform()): boolean {
  if (event.defaultPrevented || isImeEvent(event) || isTextEntry(event.target) || isInModal(event.target)) return false;
  for (const action of ACTIONS) {
    const binding = resolveBindings(action.shortcut, platform).find((candidate) =>
      matchesBinding(event, candidate, platform),
    );
    if (binding === undefined) continue;
    if (isBareKey(binding) && !isInCanvas(event.target)) return false;
    event.preventDefault();
    if (!event.repeat || action.repeat === true) runAction(action.id);
    return true;
  }
  return false;
}

/** Binds `handleKeyDown` to the window for as long as the caller is mounted. */
export function useActionKeys(): void {
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => void handleKeyDown(event);
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, []);
}

/** Renders nothing: it hosts `useActionKeys` in a component of its own. Mount it once (the shell does). */
export function ActionKeys(): null {
  useActionKeys();
  return null;
}
