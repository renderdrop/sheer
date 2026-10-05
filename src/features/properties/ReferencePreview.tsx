import { useMemo } from 'react';

import type { BibRecord } from '../../api/citations';
import { useT } from '../../i18n';
import { formatReference, isReferenceBlank } from '../citations/format';
import { useCitationStyle } from '../citations/style';

/** The preview of the reference in the current style (DESIGN 3.7 C5, as C7): Sand box, italics as the style needs, polite live region. */
export function ReferencePreview({ record }: { record: BibRecord }) {
  const t = useT();
  const [style] = useCitationStyle();
  const block = useMemo(() => formatReference(record, style, t.locale), [record, style, t.locale]);
  return (
    <div className="flex flex-col gap-1">
      <span className="t-caption text-text-muted">{t('reference.preview')}</span>
      <p
        aria-live="polite"
        lang={t.locale}
        className="t-body m-0 min-h-[var(--preview-min-height,var(--space-16))] rounded-sm bg-subtle p-3 text-text [overflow-wrap:break-word]"
      >
        {isReferenceBlank(record)
          ? null
          : block.runs.map((run, i) => (run.italic ? <em key={i}>{run.text}</em> : <span key={i}>{run.text}</span>))}
      </p>
    </div>
  );
}
