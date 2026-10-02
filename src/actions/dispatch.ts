import { getAction, type ActionDef } from './registry';
import { readActionState } from './state';

/** A modal dialog (`role="dialog"` with `aria-modal="true"`): the app behind it is inert and the dialog owns the keyboard. */
export const MODAL_SELECTOR = '[aria-modal="true"]';

/** Whether a modal dialog is open now (one that is closing has dropped `aria-modal`, so it no longer counts). */
export function isModalOpen(): boolean {
  return typeof document !== 'undefined' && document.querySelector(MODAL_SELECTOR) !== null;
}

/** The ids that still run while a modal dialog is open: About, which closes the dialog it opened. */
const RUNS_WHILE_MODAL: ReadonlySet<string> = new Set(['about']);

/**
 * The action with this id when it exists and may run now: its `enabled` holds for the current state of the stores, and
 * while a modal dialog is open nothing but `about` runs. This one rule is behind `canRunAction` and `runAction`.
 */
function runnable(id: string): ActionDef | undefined {
  const action = getAction(id);
  if (action === undefined || !action.enabled(readActionState())) return undefined;
  if (isModalOpen() && !RUNS_WHILE_MODAL.has(id)) return undefined;
  return action;
}

/**
 * Whether the action with this id exists and can run now (its `enabled` for the current state of the stores, and no modal
 * dialog in the way). For the click that is a variant of a command and so cannot call `runAction` itself (a tool's click
 * toggles it), but must obey the same rule.
 */
export function canRunAction(id: string): boolean {
  return runnable(id) !== undefined;
}

/**
 * Runs the action with this id if there is one and it can run now. The one way a command is carried out, whether it came
 * from the keyboard, the native menu bar or a menu, toolbar or empty-state click, so each of them gets the same rules.
 * Returns whether the action ran. An id that is not an action (a message from the native menu is data, never trusted)
 * does nothing, and so does every action but `about` while a modal dialog is open: the dialog owns the app until it closes,
 * and a command from the native menu or a key typed outside the dialog must not run behind it (`isModalOpen`).
 */
export function runAction(id: string): boolean {
  const action = runnable(id);
  if (action === undefined) return false;
  action.run();
  return true;
}
