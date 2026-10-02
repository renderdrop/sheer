import { useEffect } from 'react';

import type { Platform } from '../api/app';
import { detectPlatform } from '../lib/platform';
import { useSettings } from '../stores/settings';
import { runAction } from './dispatch';
import { ACTIONS } from './registry';
import { isBareKey, matchesBinding, resolveBinding } from './shortcut';

/**
 * The attribute that marks the canvas (`data-action-scope="canvas"`): single-key shortcuts such as the tool letters work
 * only while focus is inside an element that has it.
 */
export const CANVAS_SCOPE_ATTRIBUTE = 'data-action-scope';

/** Input types that take no text: a key typed on them is not typing, so shortcuts still work there. */
const NON_TEXT_INPUTS: ReadonlySet<string> = new Set([
  'button',
  'checkbox',
  'color',
  'file',
  'image',
  'radio',
  'range',
  'reset',
  'submit',
]);

const EDITABLE =
  '[contenteditable]:not([contenteditable="false"]), [role="textbox"], [role="searchbox"], [role="combobox"], [role="spinbutton"]';

/**
 * Whether `target` is somewhere the user types: a text field, a text area, a select, or an element that is editable or
 * says it is a text box. A key pressed there belongs to the field, whatever shortcut it looks like.
 */
export function isTextEntry(target: EventTarget | null): boolean {
  if (!(target instanceof Element)) return false;
  if (target instanceof HTMLInputElement) return !NON_TEXT_INPUTS.has(target.type);
  if (target instanceof HTMLTextAreaElement || target instanceof HTMLSelectElement) return true;
  return target.closest(EDITABLE) !== null;
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
 *   (`defaultPrevented`, which is how the menus and popovers claim their arrows and Esc), or from an IME composition.
 * - A bare key (the tool letters) works only with the canvas focused (`isInCanvas`), so it can never be a typed character.
 * - A key that matches takes the browser's own meaning away (Ctrl and plus would zoom the whole window), also when the action
 *   is disabled or this is a repeat of a key that does not repeat; it just does not run then.
 */
export function handleKeyDown(event: KeyboardEvent, platform: Platform | null = currentPlatform()): boolean {
  if (event.defaultPrevented || event.isComposing || isTextEntry(event.target)) return false;
  for (const action of ACTIONS) {
    const binding = resolveBinding(action.shortcut, platform);
    if (binding === null || !matchesBinding(event, binding, platform)) continue;
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
