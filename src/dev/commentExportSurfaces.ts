// Dev only: the comment export dialog for the surface gate (DESIGN 3.16 CE-AC 12): default, markdown with a filter, nothing to export.
import { closeCommentExport } from '../features/comments/export/runtime';
import { useCommentExport } from '../features/comments/export/store';
import { NO_FILTER, type Filter } from '../features/comments/model';
import { useComments } from '../features/comments/store';
import { selectActiveId, useDocuments } from '../stores/documents';
import type { DevSurface } from './surfaces';

function surface(id: string, filter: Filter): DevSurface {
  return {
    id,
    open: () => {
      const docId = selectActiveId(useDocuments.getState()) ?? 0;
      if (useComments.getState().byDoc[docId] === undefined) useComments.getState().load(docId);
      useCommentExport.getState().openDialog({ docId, filter });
      return Promise.resolve();
    },
    close: closeCommentExport,
  };
}

export function commentExportSurfaces(): DevSurface[] {
  return [
    surface('comment-export', NO_FILTER),
    surface('comment-export-filtered', { ...NO_FILTER, groups: ['highlight'], statuses: ['open'] }),
    surface('comment-export-nothing', { ...NO_FILTER, groups: ['shape'], tags: ['__none__'] }),
  ];
}
