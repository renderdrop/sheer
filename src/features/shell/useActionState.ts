import { useMemo } from 'react';

import type { ActionState } from '../../actions/state';
import { useCitations } from '../citations/store';
import { MAX_ZOOM, MIN_ZOOM } from '../../lib/zoom';
import { historyOf, useAnnotations } from '../../stores/annotations';
import { selectActiveId, useDocuments } from '../../stores/documents';
import { useDocViewValue } from '../../stores/view';

/**
 * What the actions' `enabled` looks at, followed live: the toolbar's tools and the in-window menus are built from it. Flags only,
 * so the component that uses it renders when one flips (a document opens, a limit is reached, a history step appears) and not
 * for every page or zoom step.
 */
export function useActionState(): ActionState {
  const docId = useDocuments(selectActiveId);
  const zoomAtMin = useDocViewValue(docId, (view) => view.zoom <= MIN_ZOOM);
  const zoomAtMax = useDocViewValue(docId, (view) => view.zoom >= MAX_ZOOM);
  const canUndo = useAnnotations((state) => historyOf(state, docId).canUndo);
  const canRedo = useAnnotations((state) => historyOf(state, docId).canRedo);
  const permissions = useDocuments((state) =>
    docId === null ? null : (state.byId[docId]?.flags?.permissions ?? null),
  );
  const canPrint = permissions === null || permissions.includes('print');
  const canCopy = permissions === null || permissions.includes('copy');
  const hasDocument = docId !== null;
  // The list is read for the menu's Copy and Save Citation List, and kept live by the change sets.
  const hasCitations = useCitations(docId).length > 0;
  const readOnly = useDocuments((state) => (docId === null ? false : state.byId[docId]?.kind === 'welcome'));
  return useMemo(
    () => ({ hasDocument, zoomAtMin, zoomAtMax, canUndo, canRedo, canPrint, canCopy, hasCitations, readOnly }),
    [hasDocument, zoomAtMin, zoomAtMax, canUndo, canRedo, canPrint, canCopy, hasCitations, readOnly],
  );
}
