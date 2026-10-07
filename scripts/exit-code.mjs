// ADR-139: the exit code a script must return for a finished child (spawnSync result). A non-zero status is passed on, a child
// killed by a signal or one that could not start is a failure, never 0.
import os from 'node:os';

/** @param {{ status?: number | null, signal?: string | null, error?: Error }} run */
export function exitCodeOf(run) {
  if (typeof run.status === 'number') return run.status;
  if (run.signal) return 128 + (os.constants.signals[run.signal] ?? 1);
  return 1;
}
