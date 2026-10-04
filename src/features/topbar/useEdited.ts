import { isDirty, useAnnotations } from '../../stores/annotations';
import { selectActiveId, useDocuments } from '../../stores/documents';

/** Whether the active document has changes that are not saved (a recovered one always has: it has no file yet). */
export function useActiveEdited(): boolean {
  const activeId = useDocuments(selectActiveId);
  const recovered = useDocuments((state) => activeId !== null && state.byId[activeId]?.kind === 'recovered');
  const dirty = useAnnotations((state) => activeId !== null && isDirty(state, activeId));
  return recovered || dirty;
}
