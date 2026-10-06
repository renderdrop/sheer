import { CircleAlert, LifeBuoy, LoaderCircle, X } from 'lucide-react';
import { AnimatePresence, motion } from 'motion/react';
import { useEffect, useId, useState } from 'react';

import type { RecoveryEntry } from '../../api/recovery';
import { Button, IconButton } from '../../components';
import { cx } from '../../components/cx';
import { Icon } from '../../components/Icon';
import { useRevealMotion } from '../../components/motion';
import { APP_NAME } from '../../config/app';
import { useLocale, useT, type Locale, type Translate } from '../../i18n';
import { useUi } from '../../stores/ui';
import { middleTruncate } from '../tabs/TabStrip';
import { discardEverything, discardOne, loadRecoveries, restoreAll, restoreOne } from './actions';
import { useRecovery } from './store';

/** From this many records on, the row list is collapsed behind a "Show all" toggle (B-006). */
const COLLAPSE_AT = 3;

function metaOf(entry: RecoveryEntry, locale: Locale, t: Translate): string {
  if (entry.original !== 'unchanged') return t('recover.asCopy');
  const time = new Intl.DateTimeFormat(locale, { dateStyle: 'medium', timeStyle: 'short' }).format(
    Date.parse(entry.savedAt),
  );
  return t('recover.meta', { time });
}

function Row({ entry }: { entry: RecoveryEntry }) {
  const t = useT();
  const locale = useLocale();
  const busy = useRecovery((state) => state.busy.includes(entry.id));
  const failed = useRecovery((state) => state.failed.includes(entry.id));
  const metaId = useId();
  return (
    <li>
      <div
        role="group"
        aria-label={entry.displayName}
        aria-busy={busy}
        aria-describedby={metaId}
        className="flex h-control-lg items-center gap-2 rounded-button ps-10 pe-2 hover:bg-subtle"
      >
        <div className="min-w-0 flex-auto">
          <div className="truncate text-md" title={entry.displayName}>
            {middleTruncate(entry.displayName, 48)}
          </div>
          <div id={metaId} className="truncate text-sm text-text-muted">
            {failed ? (
              <span role="alert" className="inline-flex items-center gap-1 text-error-text">
                <Icon icon={CircleAlert} size={16} />
                {t('recover.failed')}
              </span>
            ) : (
              metaOf(entry, locale, t)
            )}
          </div>
        </div>
        <Button variant="ghost" size="sm" disabled={busy} onClick={() => discardOne(entry.id)}>
          {t('recover.discard')}
        </Button>
        <Button size="sm" disabled={busy} onClick={() => void restoreOne(entry)} icon={busy ? LoaderCircle : undefined}>
          {t('recover.restore')}
        </Button>
      </div>
    </li>
  );
}

/**
 * The recovery banner (DESIGN 3.50): after an unexpected exit, the autosaved documents with Restore and Discard per row. It never
 * takes focus, never blocks, and yields to an error banner. "Decide later" hides it for the session; the records stay.
 */
export function RecoveryBanner() {
  const t = useT();
  const motionProps = useRevealMotion();
  const entries = useRecovery((state) => state.entries);
  const hidden = useRecovery((state) => state.hidden);
  const errorShown = useUi((state) => state.banner !== null);
  const titleId = useId();
  const listId = useId();
  const [expanded, setExpanded] = useState(false);
  const collapsible = entries.length >= COLLAPSE_AT;
  const listShown = !collapsible || expanded;
  useEffect(() => {
    void loadRecoveries();
  }, []);
  const show = entries.length > 0 && !hidden && !errorShown;
  return (
    <AnimatePresence initial={false}>
      {show && (
        <motion.div key="recovery" {...motionProps} className="shrink-0 overflow-hidden">
          <div className="px-2 pb-2">
            <section
              aria-labelledby={titleId}
              className="bg-panel border border-border-subtle shadow-floating rounded-panel p-2"
            >
              <div className="flex items-center gap-2">
                <span className="flex size-control-md shrink-0 items-center justify-center rounded-button bg-tile text-tile-icon">
                  <Icon icon={LifeBuoy} />
                </span>
                <div className="min-w-0 flex-auto">
                  <h2 id={titleId} className="truncate text-md font-semibold">
                    {t('recover.title', { app: APP_NAME })}
                  </h2>
                  <p role="status" className="truncate text-sm text-text-muted">
                    {t('recover.body', { count: entries.length })}
                  </p>
                </div>
                {collapsible && (
                  <Button
                    variant="ghost"
                    size="sm"
                    aria-expanded={expanded}
                    aria-controls={listId}
                    onClick={() => setExpanded((value) => !value)}
                  >
                    {t(expanded ? 'recover.hideAll' : 'recover.showAll')}
                  </Button>
                )}
                {entries.length >= 2 && (
                  <>
                    <Button variant="ghost" size="sm" onClick={discardEverything}>
                      {t('recover.discardAll')}
                    </Button>
                    <Button size="sm" onClick={() => void restoreAll()}>
                      {t('recover.restoreAll')}
                    </Button>
                  </>
                )}
                <IconButton
                  label={t('recover.later')}
                  icon={X}
                  size="sm"
                  onClick={() => useRecovery.getState().hide()}
                />
              </div>
              {listShown && (
                <ul
                  id={listId}
                  aria-label={t('recover.rows')}
                  className={cx('mt-2 flex max-h-recover-list flex-col gap-1 overflow-y-auto', 'list-none p-0')}
                >
                  {entries.map((entry) => (
                    <Row key={entry.id} entry={entry} />
                  ))}
                </ul>
              )}
            </section>
          </div>
        </motion.div>
      )}
    </AnimatePresence>
  );
}
