import { FileText, X } from 'lucide-react';
import { AnimatePresence, motion } from 'motion/react';
import { useEffect } from 'react';

import { IconButton } from '../../components';
import { Icon } from '../../components/Icon';
import { useRevealMotion } from '../../components/motion';
import { useT } from '../../i18n';
import { selectActiveDocument, selectActiveId, useDocuments } from '../../stores/documents';
import { FlattenDialog } from './FlattenDialog';
import { useBannerWinner, useFormBannerWanted } from '../shell/bannerPriority';
import { runFirstField } from './actions';
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
 * The form banner (DESIGN v2 3.2, 4): Sand, 16 side padding, file-text icon, "Form detected – n fields", a link to the first
 * field and a 28 close button. Fields are live without a tool. Once per document and session; it yields to the redact band.
 */
function FormBannerRow() {
  const t = useT();
  const motionProps = useRevealMotion();
  const docId = useDocuments(selectActiveId);
  const count = useForms((state) => (docId === null ? 0 : (state.byDoc[docId]?.fields.length ?? 0)));
  const wanted = useFormBannerWanted();
  const show = useBannerWinner() === 'form' && wanted;
  return (
    <AnimatePresence initial={false}>
      {show && (
        <motion.div key="form" {...motionProps} className="shrink-0">
          <div className="px-2 pb-2">
            <div
              role="status"
              data-banner="form"
              className="t-label flex min-h-control-lg items-center gap-2 rounded-md bg-subtle py-1 pe-1 ps-4 text-text"
            >
              <span className="shrink-0 text-text">
                <Icon icon={FileText} />
              </span>
              <span className="min-w-0 flex-auto">
                {t('banner.form', { count })} ·{' '}
                <button
                  type="button"
                  className="cursor-pointer border-0 bg-transparent p-0 [font:inherit] text-text underline"
                  onClick={runFirstField}
                >
                  {t('banner.formFirst')}
                </button>
              </span>
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
