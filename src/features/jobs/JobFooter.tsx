import { CircleAlert, LoaderCircle } from 'lucide-react';
import type { ReactNode } from 'react';

import type { AppError } from '../../api/errors';
import { Icon } from '../../components';
import { errorText, useT } from '../../i18n';
import { ProgressBar } from './ProgressBar';
import type { JobRun } from './useJobRun';

/** The inline error of a job dialog (the app behind the dialog is inert, so the banner row could not be read or used). */
export function JobError({ error }: { error: AppError | null }) {
  const t = useT();
  return (
    <div className="flex min-h-4 items-start text-sm text-error-text">
      {error !== null && (
        <p role="alert" className="m-0 flex items-start gap-1">
          <span className="shrink-0">
            <Icon icon={CircleAlert} size={12} />
          </span>
          {errorText(t, error)}
        </p>
      )}
    </div>
  );
}

/** The spinner that stands in a primary button's label while its job runs. */
export function Spinner({ size }: { size?: 12 | 16 }) {
  return <Icon icon={LoaderCircle} size={size} className="animate-spin motion-reduce:animate-none" />;
}

/** The progress bar of a job that has run longer than a second, with its caption; nothing before that. */
export function JobProgress({ run, label, caption }: { run: JobRun; label: string; caption?: ReactNode }) {
  if (!run.running || !run.slow) return null;
  return (
    <div className="flex flex-col gap-1">
      <ProgressBar label={label} done={run.progress?.done ?? 0} total={run.progress?.total ?? 0} />
      {caption !== undefined && <p className="m-0 text-sm text-text-muted tabular-nums">{caption}</p>}
    </div>
  );
}
