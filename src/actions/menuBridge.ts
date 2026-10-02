import { subscribeMenu } from '../api/app';
import { runAction } from './dispatch';

/** The part of `subscribeMenu` (src/api/app.ts) that is used here. */
export type SubscribeMenu = (onAction: (id: string) => void, systemLanguage: string) => Promise<void>;

/**
 * Connects the macOS menu bar to the command registry: the backend sends the id of each menu item that is chosen over a
 * channel this call opens, and `runAction` carries it out with the same rules as a key press (an unknown id or a disabled
 * action does nothing). The OS language goes along, for the menu's labels while the language setting is "system". Resolves
 * once the channel is open. Never rejects: where there is no backend (a browser, a test) or no menu bar (Windows), nothing
 * arrives, and the commands stay on the toolbar, in More and on the keyboard.
 */
export async function watchNativeMenu(
  subscribe: SubscribeMenu = subscribeMenu,
  run: (id: string) => boolean = runAction,
  systemLanguage: string = typeof navigator === 'undefined' ? '' : navigator.language,
): Promise<void> {
  try {
    await subscribe((id) => void run(id), systemLanguage);
  } catch {
    // No native menu to hear from.
  }
}
