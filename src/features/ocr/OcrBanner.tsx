import { ScanText, X } from 'lucide-react';
import { AnimatePresence, motion } from 'motion/react';
import { useEffect } from 'react';

import { Button, Icon, IconButton } from '../../components';
import { useRevealMotion } from '../../components/motion';
import { useT } from '../../i18n';
import { selectActiveId, useDocuments } from '../../stores/documents';
import { pageIdAt, useSlots } from '../../stores/pages';
import { useView } from '../../stores/view';
import { useBannerWinner } from '../shell/bannerPriority';
import { offerWanted } from './model';
import { ensureCapabilities, openOcrDialog, refreshClasses, stopOcr } from './runtime';
import { useOcr } from './store';

/** Background work of the feature: the recognizer's capabilities once, the page classes after the first render and each revision. */
function useOcrEffects(docId: number | null): void {
  const slots = useSlots(docId);
  useEffect(() => {
    void ensureCapabilities();
  }, []);
  useEffect(() => {
    if (docId !== null) void refreshClasses(docId);
  }, [docId, slots]);
}

/** The 2 px determinate bar on the inner bottom edge of the banner (O3): Ink on the pressed surface, `role="progressbar"`. */
function Bar({ done, total, text }: { done: number; total: number; text: string }) {
  const ratio = total > 0 ? Math.min(1, Math.max(0, done / total)) : 0;
  return (
    <div
      role="progressbar"
      data-ocr="bar"
      aria-label={text}
      aria-valuemin={0}
      aria-valuemax={total}
      aria-valuenow={Math.min(done, total)}
      aria-valuetext={text}
      className="pointer-events-none absolute inset-x-3 bottom-0 h-[calc(var(--space-1)/2)] overflow-hidden rounded-pill bg-pressed"
    >
      <div
        className="h-full bg-text transition-[width] duration-base ease-out motion-reduce:transition-none"
        style={{ width: `${Math.round(ratio * 100)}%` }}
      />
    </div>
  );
}

const BOX = 't-label relative flex min-h-control-lg items-center gap-2 rounded-md bg-subtle py-1 pe-1 ps-4 text-text';

function Progress({ docId }: { docId: number }) {
  const t = useT();
  const run = useOcr((state) => state.runs[docId]);
  if (run === undefined) return null;
  const text = run.stopping
    ? t('ocr.stopping')
    : t('ocr.progress', { page: Math.min(run.done + 1, Math.max(run.total, 1)), total: run.total });
  return (
    <div
      role="status"
      data-surface="ocr-banner"
      data-variant="progress"
      data-stopping={run.stopping || undefined}
      className={BOX}
    >
      <span className="shrink-0 text-text">
        <Icon icon={ScanText} />
      </span>
      <span className="min-w-0 flex-auto tabular-nums" data-ocr="label">
        {text}
      </span>
      <Button
        variant="ghost"
        size="sm"
        data-ocr="stop"
        disabled={run.stopping}
        focusableWhenDisabled
        onClick={() => stopOcr(docId)}
      >
        {t('ocr.stop')}
      </Button>
      <Bar done={run.done} total={run.total} text={text} />
    </div>
  );
}

function Offer({ docId, pages, current }: { docId: number; pages: number; current: boolean }) {
  const t = useT();
  return (
    <div
      role="status"
      data-surface="ocr-banner"
      data-variant="offer"
      data-scope={current ? 'page' : 'pages'}
      className={BOX}
    >
      <span className="shrink-0 text-text">
        <Icon icon={ScanText} />
      </span>
      <span className="min-w-0 flex-auto">
        {current ? t('ocr.banner.page') : t('ocr.banner.pages', { count: pages })}
      </span>
      <Button variant="ghost" size="sm" data-ocr="offer-action" onClick={openOcrDialog}>
        {t('ocr.banner.action')}
      </Button>
      <IconButton label={t('ocr.banner.dismiss')} icon={X} size="sm" onClick={() => useOcr.getState().dismiss(docId)} />
    </div>
  );
}

/**
 * The OCR banner (DESIGN 3.12 O1, O3): the progress variant of a run in this tab, which takes the slot right after the signature banner,
 * else the offer when scan pages were found, which only shows when no other banner has the slot (it is the lowest). It also runs the
 * feature's background work.
 */
export function OcrBanner() {
  const docId = useDocuments(selectActiveId);
  useOcrEffects(docId);
  const motionProps = useRevealMotion();
  const winner = useBannerWinner();
  const running = useOcr((state) => docId !== null && state.runs[docId] !== undefined);
  const backendNone = useOcr((state) => state.capabilities?.backend === 'none' || state.capabilities === null);
  const classes = useOcr((state) => (docId === null ? undefined : state.classes[docId]));
  const dismissed = useOcr((state) => docId !== null && state.dismissed[docId] === true);
  const locked = useDocuments((state) => docId !== null && state.byId[docId]?.signatureLock === 'locked');
  const readOnly = useDocuments((state) => {
    const doc = docId === null ? undefined : state.byId[docId];
    return doc?.kind === 'welcome' || doc?.flags?.permissions?.includes('edit') === false;
  });
  const pageIndex = useView((state) => (docId === null ? 0 : (state.byDoc[docId]?.pageIndex ?? 0)));
  const scanPages = classes?.filter((entry) => entry.class === 'scan').length ?? 0;
  const currentId = docId === null ? null : pageIdAt(docId, pageIndex);
  const current = classes?.some((entry) => entry.page === currentId && entry.class === 'scan') === true;
  const offer = winner === 'other' && !running && offerWanted({ backendNone, scanPages, locked, dismissed, readOnly });
  const key = running && winner === 'ocr' ? 'progress' : offer ? 'offer' : null;
  return (
    <AnimatePresence initial={false}>
      {docId !== null && key !== null && (
        <motion.div key={key} {...motionProps} className="shrink-0" data-ocr-slot={key}>
          <div className="px-2 pb-2">
            {key === 'progress' ? (
              <Progress docId={docId} />
            ) : (
              <Offer docId={docId} pages={scanPages} current={current} />
            )}
          </div>
        </motion.div>
      )}
    </AnimatePresence>
  );
}
