import { useCallback, useEffect, useRef, useState } from 'react';

import { toAppError, type AppError } from '../../api/errors';
import { cancelJob, type JobEvent, type JobId } from '../../api/jobs';

/** After this long a job shows a progress bar instead of just a spinner (DESIGN 3.30). */
export const BAR_AFTER_MS = 1000;

export interface JobProgress {
  done: number;
  total: number;
}

export interface JobRun {
  running: boolean;
  /** The job has run longer than `BAR_AFTER_MS`. */
  slow: boolean;
  progress: JobProgress | null;
  error: AppError | null;
  /**
   * Starts a job: `launch` calls one of the job commands with the given listener. The command resolves to `null` when a native
   * dialog was cancelled (nothing ran). `onDone` gets the `done` event.
   */
  start: (
    launch: (onEvent: (event: JobEvent) => void) => Promise<JobId | null>,
    onDone: (event: Extract<JobEvent, { type: 'done' }>) => void,
  ) => void;
  /** Asks the backend to stop the job; it ends with a `cancelled` event and nothing changes. */
  cancel: () => void;
  clearError: () => void;
}

/** One running job of a dialog, with its progress. Leaving the dialog cancels it. */
export function useJobRun(): JobRun {
  const [running, setRunning] = useState(false);
  const [slow, setSlow] = useState(false);
  const [progress, setProgress] = useState<JobProgress | null>(null);
  const [error, setError] = useState<AppError | null>(null);
  const job = useRef<JobId | null>(null);
  const wantsCancel = useRef(false);
  const live = useRef(true);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  const finish = useCallback(() => {
    clearTimeout(timer.current);
    job.current = null;
    wantsCancel.current = false;
    if (!live.current) return;
    setRunning(false);
    setSlow(false);
    setProgress(null);
  }, []);

  useEffect(() => {
    live.current = true;
    return () => {
      live.current = false;
      clearTimeout(timer.current);
      if (job.current !== null) cancelJob(job.current).catch(() => undefined);
    };
  }, []);

  const start = useCallback<JobRun['start']>(
    (launch, onDone) => {
      setRunning(true);
      setSlow(false);
      setError(null);
      setProgress(null);
      wantsCancel.current = false;
      let ended = false;
      timer.current = setTimeout(() => live.current && setSlow(true), BAR_AFTER_MS);
      const onEvent = (event: JobEvent) => {
        if (event.type === 'progress') {
          if (live.current) setProgress({ done: event.done, total: event.total });
          return;
        }
        ended = true;
        finish();
        if (event.type === 'done') onDone(event);
        else if (event.type === 'failed' && live.current) setError(event.error);
      };
      launch(onEvent).then(
        (id) => {
          if (id === null) finish();
          else if (ended) return;
          else if (wantsCancel.current) cancelJob(id).catch(() => undefined);
          job.current = id;
        },
        (caught: unknown) => {
          finish();
          if (live.current) setError(toAppError(caught));
        },
      );
    },
    [finish],
  );

  const cancel = useCallback(() => {
    wantsCancel.current = true;
    if (job.current !== null) cancelJob(job.current).catch(() => undefined);
  }, []);

  const clearError = useCallback(() => setError(null), []);
  return { running, slow, progress, error, start, cancel, clearError };
}
