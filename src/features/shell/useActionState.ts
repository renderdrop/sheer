import { useMemo } from 'react';

import type { ActionState } from '../../actions/state';
import { exportableCount } from '../comments/export/model';
import { useComments } from '../comments/store';
import { useCommentsData } from '../comments/useCommentsData';
import { useCitations } from '../citations/store';
import { hasRecognizedText } from '../ocr/model';
import { useOcr } from '../ocr/store';
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
  // The comment list is kept live for File: Export comments (DESIGN 3.16 E1); until it is read the command stays on.
  useCommentsData(docId, false);
  const hasExportableComments = useComments((state) => {
    const entry = docId === null ? undefined : state.byDoc[docId];
    return entry?.status === 'ready' ? exportableCount(entry.summaries) > 0 : true;
  });
  const readOnly = useDocuments((state) => (docId === null ? false : state.byId[docId]?.kind === 'welcome'));
  // The same lock as `readActionState` (DESIGN 3.8 S5), so the in-window menu and the shortcuts agree.
  const lock = useDocuments((state) => (docId === null ? 'none' : (state.byId[docId]?.signatureLock ?? 'none')));
  const signatureLocked = lock === 'locked';
  const signed = lock !== 'none';
  const canEdit = permissions === null || permissions.includes('edit');
  const signedFile = useDocuments((state) => (docId === null ? false : state.byId[docId]?.flags?.signed === true));
  const ocrUnavailable = useOcr((state) => state.capabilities?.backend === 'none');
  const ocrBusy = useOcr((state) => docId !== null && state.runs[docId] !== undefined);
  const hasOcrText = useOcr((state) => docId !== null && hasRecognizedText(state.classes[docId] ?? []));
  return useMemo(
    () => ({
      hasDocument,
      zoomAtMin,
      zoomAtMax,
      canUndo,
      canRedo,
      canPrint,
      canCopy,
      hasCitations,
      hasExportableComments,
      readOnly,
      signatureLocked,
      signed,
      canEdit,
      ocrUnavailable,
      ocrBusy,
      signedFile,
      hasOcrText,
    }),
    [
      hasDocument,
      zoomAtMin,
      zoomAtMax,
      canUndo,
      canRedo,
      canPrint,
      canCopy,
      hasCitations,
      hasExportableComments,
      readOnly,
      signatureLocked,
      signed,
      canEdit,
      ocrUnavailable,
      ocrBusy,
      signedFile,
      hasOcrText,
    ],
  );
}
