import { Info, X } from 'lucide-react';
import { AnimatePresence, motion } from 'motion/react';
import { useEffect } from 'react';

import { Button, IconButton } from '../../components';
import { Icon } from '../../components/Icon';
import { useRevealMotion } from '../../components/motion';
import { useT } from '../../i18n';
import { selectActiveDocument, selectActiveId, useDocuments } from '../../stores/documents';
import { FlattenDialog } from './FlattenDialog';
import { runNextField } from './actions';
import { useForms } from './store';

/** Whether the document may have a form to read: its flags say so (a document without them is asked). */
function mayHaveForm(flags: { hasForms: boolean } | undefined): boolean {
  return flags === undefined || flags.hasForms;
}

/** Loads the form of the active document and forgets those of closed ones. Fields are always live (DESIGN 3.58): no tool to enter. */
function useFormEffects(): void {
  const docId = useDocuments(selectActiveId);
  const flags = useDocuments((state) => selectActiveDocument(state)?.flags);
  const may = mayHaveForm(flags);

  useEffect(() => {
    if (docId !== null && may) void useForms.getState().load(docId);
  }, [docId, may]);

  useEffect(
    () =>
      useDocuments.subscribe((state, previous) => {
        for (const id of Object.keys(previous.byId)) {
          if (state.byId[Number(id)] === undefined) useForms.getState().remove(Number(id));
        }
      }),
    [],
  );
}

/**
 * The info banner of a document with fields (DESIGN 3.58, banner 3.12): once per document and session, with the highlight toggle, Go to first empty
 * field and a close button. It pushes the content down like the other banners.
 */
function FormBannerRow() {
  const t = useT();
  const motionProps = useRevealMotion();
  const docId = useDocuments(selectActiveId);
  const has = useForms((state) => docId !== null && (state.byDoc[docId]?.fields.length ?? 0) > 0);
  const dismissed = useForms((state) => docId !== null && state.bannerDismissed[docId] === true);
  const highlight = useForms((state) => state.highlight);
  return (
    <AnimatePresence initial={false}>
      {has && !dismissed && (
        <motion.div key="form" {...motionProps} className="shrink-0">
          <div className="px-1 pb-1">
            <div
              role="status"
              className="glass-1 flex min-h-banner-min items-center gap-1 rounded-panel py-1 pe-1 ps-2"
            >
              <span className="shrink-0 text-text-accent">
                <Icon icon={Info} />
              </span>
              <span className="min-w-0 flex-auto">{t('form.banner')}</span>
              <Button
                variant="secondary"
                size="sm"
                aria-pressed={highlight}
                className="aria-pressed:bg-selected"
                onClick={() => useForms.getState().setHighlight(!highlight)}
              >
                {t('form.highlight')}
              </Button>
              <Button variant="ghost" size="sm" onClick={runNextField}>
                {t('form.next')}
              </Button>
              <IconButton
                label={t('action.dismiss')}
                icon={X}
                size="sm"
                onClick={() => docId !== null && useForms.getState().dismissBanner(docId)}
              />
            </div>
          </div>
        </motion.div>
      )}
    </AnimatePresence>
  );
}

/** Everything of the form UI that is not on a page: its effects, the info banner and the flatten dialog. Mounted once with the shell. */
export function FormHost() {
  useFormEffects();
  const flattenOpen = useForms((state) => state.flattenOpen);
  return (
    <>
      <FormBannerRow />
      <AnimatePresence>{flattenOpen && <FlattenDialog key="flatten" />}</AnimatePresence>
    </>
  );
}
