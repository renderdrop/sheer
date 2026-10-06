import { useEffect } from 'react';

import { onUndoCue } from '../../stores/undoCue';
import { useDocuments } from '../../stores/documents';
import { useUi } from '../../stores/ui';
import { useTextEdit } from './store';

/** Drops the substitute-font notice and its anchor (it belongs to one edit of one document). */
export function clearNotice(): void {
  const state = useTextEdit.getState();
  if (state.notice !== null || (state.noticeAnchor ?? null) !== null) state.set({ notice: null, noticeAnchor: null });
}

/**
 * The notice outlives neither an undo or redo, nor a switch of the active document, nor the release of the Edit text tool
 * (DESIGN 3.10 E4, ADR-130). While a line is still being written on tool release, the notice goes once the write has closed.
 */
export function useNoticeLifetime(): void {
  const tool = useUi((s) => s.activeTool);
  const hasNotice = useTextEdit((s) => s.notice !== null);
  const editing = useTextEdit((s) => s.session !== null);
  useEffect(() => onUndoCue(() => clearNotice()), []);
  useEffect(
    () =>
      useDocuments.subscribe((state, prev) => {
        if (state.activeId !== prev.activeId) clearNotice();
      }),
    [],
  );
  useEffect(() => {
    if (tool !== 'editText' && hasNotice && !editing) clearNotice();
  }, [tool, hasNotice, editing]);
}
