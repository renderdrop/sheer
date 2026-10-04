import { CircleAlert, Download, X } from 'lucide-react';
import { AnimatePresence, motion } from 'motion/react';
import { useId, useState } from 'react';

import { Button, IconButton } from '../../components';
import { Icon } from '../../components/Icon';
import { useRevealMotion } from '../../components/motion';
import { useT } from '../../i18n';
import { ProgressBar } from '../jobs/ProgressBar';
import { useUpdate } from './store';

/**
 * The update notice (DESIGN 3.49, banner 3.12): an info banner, never a dialog, ranked below the document banners. A newer version
 * offers Download, Details (the release notes as plain text nodes) and Skip this version; the download shows progress, then
 * "verifying", then "Restart to update", which installs on quit through the normal quit flow. A bad signature deletes the download
 * and offers no retry. `role=status`; the failure line is the only `alert`.
 */
export function UpdateBannerRow() {
  const t = useT();
  const notesId = useId();
  const motionProps = useRevealMotion();
  const info = useUpdate((state) => state.info);
  const phase = useUpdate((state) => state.phase);
  const progress = useUpdate((state) => state.progress);
  const hidden = useUpdate((state) => state.hidden);
  const [details, setDetails] = useState(false);
  const show = info !== null && !hidden;

  const failed = phase === 'downloadFailed' || phase === 'unverified';
  const busy = phase === 'downloading' || phase === 'verifying';
  const actions = useUpdate.getState();

  let message = '';
  if (info !== null) {
    if (phase === 'available') message = t('update.available', { version: info.version });
    else if (phase === 'downloading') message = t('update.downloading', { version: info.version });
    else if (phase === 'verifying') message = t('update.verifying');
    else if (phase === 'ready') message = t('update.ready');
    else if (phase === 'downloadFailed') message = t('update.failedDownload');
    else message = t('update.failedVerify');
  }

  return (
    <AnimatePresence initial={false}>
      {show && (
        <motion.div key="update" {...motionProps} className="shrink-0">
          <div className="px-2 pb-2">
            <div className="bg-panel border border-border-subtle shadow-floating flex flex-col gap-2 rounded-panel py-2 pe-2 ps-4">
              <div className="flex min-h-banner-min items-center gap-2">
                <span className={failed ? 'shrink-0 text-error-text' : 'shrink-0 text-text'}>
                  <Icon icon={failed ? CircleAlert : Download} />
                </span>
                <span
                  role={failed ? 'alert' : 'status'}
                  className={failed ? 'min-w-0 flex-auto text-error-text' : 'min-w-0 flex-auto'}
                >
                  {message}
                </span>
                {phase === 'available' && (
                  <>
                    <Button variant="primary" size="sm" onClick={() => void actions.download()}>
                      {t('update.download')}
                    </Button>
                    <Button
                      variant="secondary"
                      size="sm"
                      aria-expanded={details}
                      aria-controls={notesId}
                      onClick={() => setDetails((open) => !open)}
                    >
                      {details ? t('update.hideDetails') : t('update.details')}
                    </Button>
                    <Button variant="ghost" size="sm" onClick={() => void actions.skip()}>
                      {t('update.skip')}
                    </Button>
                  </>
                )}
                {phase === 'downloadFailed' && (
                  <Button variant="primary" size="sm" onClick={() => void actions.download()}>
                    {t('update.retry')}
                  </Button>
                )}
                {phase === 'ready' && (
                  <Button variant="primary" size="sm" onClick={() => void actions.restart()}>
                    {t('update.restart')}
                  </Button>
                )}
                {!busy && <IconButton label={t('update.later')} icon={X} size="sm" onClick={() => actions.later()} />}
              </div>
              {busy && (
                <ProgressBar
                  label={t('update.downloading', { version: info?.version ?? '' })}
                  done={phase === 'verifying' ? 0 : progress.downloaded}
                  total={phase === 'verifying' ? 0 : (progress.total ?? 0)}
                  className="me-2"
                />
              )}
              {phase === 'available' && details && info !== null && (
                <pre
                  id={notesId}
                  tabIndex={0}
                  aria-label={t('update.notes')}
                  className="m-0 me-2 max-h-lib-list overflow-auto whitespace-pre-wrap rounded-sm bg-surface-strong p-2 font-sans text-sm text-text"
                >
                  {info.notes.length > 0 ? info.notes : t('update.noNotes')}
                </pre>
              )}
            </div>
          </div>
        </motion.div>
      )}
    </AnimatePresence>
  );
}
