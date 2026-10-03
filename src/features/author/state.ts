import { create } from 'zustand';

/** Whether the one-time author field is showing in the toolbar row (ADR-034, DESIGN 3.13). */
export const useAuthorPrompt = create<{ open: boolean }>()(() => ({ open: false }));

let waiting: (() => void) | null = null;

/**
 * Shows the author field and resolves when the user has confirmed or skipped. A second call while the field is open shares
 * the first one's answer.
 */
export function askAuthorName(): Promise<void> {
  return new Promise<void>((resolve) => {
    const previous = waiting;
    waiting = () => {
      previous?.();
      resolve();
    };
    useAuthorPrompt.setState({ open: true });
  });
}

/** Closes the field and lets the waiting save go on. */
export function finishAuthorPrompt(): void {
  useAuthorPrompt.setState({ open: false });
  const done = waiting;
  waiting = null;
  done?.();
}
