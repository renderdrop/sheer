import { usePulseMessage } from '../../components';
import { useT } from '../../i18n';
import { selectActiveId, useDocuments } from '../../stores/documents';
import { useDocView } from '../../stores/view';
import { useSave } from '../save/state';
import { useSettledValue } from '../shell/hooks';
import { useViewer } from '../viewer/useViewer';

/** The page announcement waits this long after the page last changed (DESIGN 3.10). */
export const ANNOUNCE_DELAY_MS = 500;

/**
 * The top bar's polite live regions, for screen readers only: save and render activity, the settled page ("Page 3 of 120" 500 ms
 * after it stopped changing) and the success pulses (MOTION 4.7).
 */
export function LiveRegions() {
  const t = useT();
  const activeId = useDocuments(selectActiveId);
  const rendering = useViewer((state) => state.rendering);
  const saveHint = useSave((state) =>
    activeId === null ? null : state.saving[activeId] === true ? 'saving' : state.saved === activeId ? 'saved' : null,
  );
  const { pageIndex, pageCount } = useDocView(activeId);
  const settledPage = useSettledValue(pageIndex, ANNOUNCE_DELAY_MS);
  const pulse = usePulseMessage();
  return (
    <>
      <span role="status" className="sr-only">
        {saveHint === 'saving'
          ? t('save.saving')
          : saveHint === 'saved'
            ? t('save.saved')
            : rendering
              ? t('status.rendering')
              : ''}
      </span>
      <span role="status" className="sr-only">
        {activeId !== null && pageCount > 0 ? t('status.page', { page: settledPage + 1, total: pageCount }) : ''}
      </span>
      <span role="status" className="sr-only">
        {pulse}
      </span>
    </>
  );
}
