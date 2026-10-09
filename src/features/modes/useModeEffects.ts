import { useEffect } from 'react';

import { useAnnotations } from '../../stores/annotations';
import { selectActiveId, useDocuments } from '../../stores/documents';
import { useUi } from '../../stores/ui';

/**
 * What follows a change of mode, installed once by the tool row (editor only): the selection of the annotations, which Seiten
 * (entered or left) drops (the page grid has its own selection, and it ends with the mode).
 */
export function useModeEffects(): void {
  useEffect(() => {
    const stop = useUi.subscribe((state, previous) => {
      if (state.mode === previous.mode) return;
      if (state.mode === 'pages' || previous.mode === 'pages') {
        const docId = selectActiveId(useDocuments.getState());
        if (docId !== null) useAnnotations.getState().clearSelection(docId);
      }
    });
    return stop;
  }, []);
}
