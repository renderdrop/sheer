import { SquareSlash } from 'lucide-react';
import type { ReactNode } from 'react';

import { Button, Icon } from '../../components';
import { useT } from '../../i18n';
import { selectActiveId, useDocuments } from '../../stores/documents';
import { useUi } from '../../stores/ui';
import { clearMarks } from './actions';
import { MarksList } from './MarksList';
import { marksOf, useRedact } from './store';

/** The empty state (DESIGN 3.15 column): a tile, "No marks", and how to make one. */
function Empty() {
  const t = useT();
  return (
    <div className="flex flex-col items-center gap-1 p-2 text-center">
      <span className="flex size-control-md items-center justify-center rounded-sm bg-tile text-tile-icon">
        <Icon icon={SquareSlash} size={24} />
      </span>
      <span className="text-md font-semibold">{t('redact.empty')}</span>
      <span className="text-sm text-text-muted">{t('redact.emptyHint')}</span>
    </div>
  );
}

/** The list, the metadata option and the fixed footer (clear, apply) of the redact mode. */
function RedactBody({ docId }: { docId: number }) {
  const t = useT();
  const marks = useRedact((state) => marksOf(state, docId));
  const removeMetadata = useRedact((state) => state.removeMetadata);
  const count = marks.length;
  return (
    <div className="flex min-h-full flex-col gap-1">
      <div className="flex flex-col gap-1">
        {count === 0 ? <Empty /> : <MarksList docId={docId} marks={marks} />}
        <label className="flex min-h-control-sm cursor-pointer items-center gap-1 text-md">
          <input
            type="checkbox"
            className="accent-accent"
            checked={removeMetadata}
            onChange={(event) => useRedact.getState().setRemoveMetadata(event.target.checked)}
          />
          {t('redact.metadata')}
        </label>
      </div>
      <div className="sticky bottom-0 mt-auto flex items-center gap-0-5 border-t border-divider bg-surface-strong pt-1">
        <Button
          variant="ghost"
          size="sm"
          disabled={count === 0}
          focusableWhenDisabled
          onClick={() => void clearMarks(docId)}
        >
          {t('redact.clear')}
        </Button>
        <span className="flex-auto" />
        <Button
          variant="primary"
          size="sm"
          disabled={count === 0}
          focusableWhenDisabled
          onClick={() => {
            if (count > 0) useRedact.getState().setApplyOpen(true);
          }}
        >
          {t('redact.apply')}
        </Button>
      </div>
    </div>
  );
}

/**
 * Inspector content of the redact mode (DESIGN 3.38): the header counts the marks, the body lists them for review, the checkbox
 * decides about the metadata, and the footer clears or opens the apply dialog (`aria-disabled` without marks).
 * `null` while the mode is off, so the standard inspector shows.
 */
export function useRedactInspector(): { title: string; body: ReactNode; footer?: ReactNode } | null {
  const t = useT();
  const mode = useUi((state) => state.redactMode);
  const docId = useDocuments(selectActiveId);
  const count = useRedact((state) => (docId === null ? 0 : Object.keys(state.marks[docId] ?? {}).length));
  if (!mode || docId === null) return null;
  return { title: t('redact.title', { count }), body: <RedactBody docId={docId} /> };
}
