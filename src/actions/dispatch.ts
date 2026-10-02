import { getAction } from './registry';
import { readActionState } from './state';

/**
 * Runs the action with this id if there is one and it is enabled now. The one way a command is carried out, whether it came
 * from the keyboard, the native menu bar or a menu or toolbar click, so each of them gets the same rules. Returns whether
 * the action ran. An id that is not an action (a message from the native menu is data, never trusted) does nothing.
 */
export function runAction(id: string): boolean {
  const action = getAction(id);
  if (action === undefined || !action.enabled(readActionState())) return false;
  action.run();
  return true;
}
