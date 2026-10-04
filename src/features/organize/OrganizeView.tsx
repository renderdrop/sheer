import { motion, useReducedMotion } from 'motion/react';
import { useEffect, type CSSProperties } from 'react';

import { SPRING } from '../../components/motion';
import { useT } from '../../i18n';
import { selectActiveId, useDocuments } from '../../stores/documents';
import { useView } from '../../stores/view';
import { setPageSelectionProvider } from '../jobs/actions';
import { targetsOf } from './commands';
import { OrganizeBar } from './OrganizeBar';
import { OrganizeGrid } from './OrganizeGrid';
import { readSlots } from './source';
import { useOrganize } from './store';

/**
 * The canvas slot in the mode Seiten (DESIGN v2 3.2, ADR-102): the size strip over the page grid, in the track the canvas
 * has otherwise (`<main>`, radius 16, `--color-canvas`). It is a mode of the mode row: it ends with another tab or Enter on a
 * page, and the viewer comes back at the focused page (the grid does that when it unmounts). The grid enters with a fade (base);
 * reduced motion changes nothing about it, a fade is the reduced form already. The selection of a document is dropped on leaving.
 */
export function OrganizeView({ style }: { style?: CSSProperties }) {
  const t = useT();
  const docId = useDocuments(selectActiveId);
  const reduce = useReducedMotion() === true;

  // The page the viewer is on is where the grid starts: focused (not selected), and scrolled to.
  useEffect(() => {
    if (docId === null) return;
    const slots = readSlots(docId);
    const page = useView.getState().byDoc[docId]?.pageIndex ?? 0;
    const start = slots[Math.min(Math.max(0, page), slots.length - 1)];
    useOrganize.getState().setSelection(docId, { selected: [], anchor: null, focus: start?.id ?? null });
    return () => useOrganize.getState().clear(docId);
  }, [docId]);

  // The jobs (Extract) ask which pages are selected here.
  useEffect(() => {
    if (docId === null) return;
    setPageSelectionProvider(() => {
      const { selected } = useOrganize.getState().byDoc[docId] ?? { selected: [] };
      return selected.length > 0 ? targetsOf(docId) : null;
    });
    return () => setPageSelectionProvider(null);
  }, [docId]);

  return (
    <motion.main
      data-action-scope="canvas"
      data-organize=""
      aria-label={t('toolbar.tool.pages')}
      style={style}
      initial={{ opacity: 0 }}
      animate={{ opacity: 1, transition: reduce ? SPRING.fast : SPRING.base }}
      className="relative isolate flex min-h-0 min-w-0 flex-col overflow-hidden rounded-panel bg-page-area"
    >
      {docId !== null && (
        <>
          <OrganizeBar />
          <OrganizeGrid key={docId} docId={docId} />
        </>
      )}
    </motion.main>
  );
}
