import { create } from 'zustand';

/** Whether the one-time author dialog is showing (ADR-034, ADR-109). */
export const useAuthorPrompt = create<{ open: boolean }>()(() => ({ open: false }));

let waiting: (() => void) | null = null;
let hosts = 0;

/**
 * The mounted prompt UI registers itself here. Without a host nothing could ever answer, so a save must not wait (ADR-109).
 * Returns the unregister function; the last host leaving releases a waiting save as if the user had skipped.
 */
export function registerAuthorHost(): () => void {
  hosts += 1;
  return () => {
    hosts = Math.max(0, hosts - 1);
    if (hosts === 0) finishAuthorPrompt();
  };
}

/**
 * Shows the author dialog and resolves when the user has confirmed or skipped. A second call while it is open shares the first
 * one's answer. Resolves at once (as a skip) when no prompt host is mounted.
 */
export function askAuthorName(): Promise<void> {
  if (hosts === 0) return Promise.resolve();
  return new Promise<void>((resolve) => {
    const previous = waiting;
    waiting = () => {
      previous?.();
      resolve();
    };
    useAuthorPrompt.setState({ open: true });
  });
}

/** Closes the dialog and lets the waiting save go on. */
export function finishAuthorPrompt(): void {
  useAuthorPrompt.setState({ open: false });
  const done = waiting;
  waiting = null;
  done?.();
}
