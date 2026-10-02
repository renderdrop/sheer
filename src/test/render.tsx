import { render } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { ReactElement } from 'react';

interface SetupOptions {
  /** Pass `vi.advanceTimersByTime` when the test uses fake timers, so user-event's own delays do not hang. */
  advanceTimers?: (ms: number) => void | Promise<void>;
}

/** Renders `ui` and returns a user-event instance beside the Testing Library queries. */
export function setup(ui: ReactElement, options: SetupOptions = {}) {
  const user = userEvent.setup(options.advanceTimers ? { advanceTimers: options.advanceTimers } : undefined);
  return { user, ...render(ui) };
}

/** The open tooltip, or `null`. Tooltips are `aria-hidden`, so role queries skip them. */
export function openTooltip(): HTMLElement | null {
  return document.querySelector<HTMLElement>('[role="tooltip"]');
}
