import { BookMarked, ChevronDown, TriangleAlert } from 'lucide-react';
import { useEffect, useMemo, useRef, useState } from 'react';

import {
  CITATION_FILE_FORMATS,
  CITATION_STYLES,
  listCitations,
  type CitationFileFormat,
  type CitationStyle,
} from '../../api/citations';
import { Button, IconButton, Icon, Menu, Skeleton, type MenuEntry } from '../../components';
import { cx } from '../../components/cx';
import { Popover } from '../../components/Popover';
import { tokenPx } from '../../components/tokens';
import { useT, type PlainKey } from '../../i18n';
import { openReferenceDetails } from '../properties/openReference';
import { useBibliography } from './bibliography';
import { copyCitationList, copyReference, saveCitationList } from './exportActions';
import { formatReference, isReferenceBlank, isReferenceIncomplete } from './format';
import { useCitationFormat, useCitationStyle } from './style';

const STYLE_KEYS: Record<CitationStyle, PlainKey> = {
  apa7: 'reference.style.apa',
  mla9: 'reference.style.mla',
  chicago17AuthorDate: 'reference.style.chicago',
  dinIso690: 'reference.style.din',
};

const FORMAT_KEYS: Record<CitationFileFormat, PlainKey> = {
  txt: 'reference.format.txt',
  html: 'reference.format.html',
  md: 'reference.format.md',
  ris: 'reference.format.ris',
  bib: 'reference.format.bib',
};

/** The popover is as wide as the left panel it opens from, less 16 (DESIGN 3.7 C7); elsewhere the default range. */
export function popoverWidthIn(anchor: HTMLElement | null): number | undefined {
  const panel = anchor?.closest<HTMLElement>('[data-region="left"]');
  return panel === null || panel === undefined
    ? undefined
    : panel.getBoundingClientRect().width - tokenPx('--space-4', 16);
}

/** The document id (the backend's opaque number). */
type DocId = number;

export interface ReferenceButtonProps {
  docId: DocId;
  /** Opens Document properties on the Reference tab; the default is `openReferenceDetails`. */
  onEditReference?: () => void;
}

/** The number of citations of the document, read when the popover opens. */
function useCitationCount(docId: DocId): number | undefined {
  const [count, setCount] = useState<number | undefined>(undefined);
  useEffect(() => {
    let current = true;
    listCitations(docId).then(
      (list) => {
        if (current) setCount(list.length);
      },
      () => {
        if (current) setCount(undefined);
      },
    );
    return () => {
      current = false;
    };
  }, [docId]);
  return count;
}

function ReferenceBody({
  docId,
  close,
  onEditReference,
  constrained,
}: {
  constrained: boolean;
  docId: DocId;
  close: () => void;
  onEditReference: () => void;
}) {
  const t = useT();
  const lang = t.locale === 'de' ? 'de' : 'en';
  const [style, setStyle] = useCitationStyle();
  const [format, setFormat] = useCitationFormat();
  const { info, loading } = useBibliography(docId);
  const count = useCitationCount(docId);
  const block = useMemo(
    () => (info === undefined ? undefined : formatReference(info.record, style, lang)),
    [info, style, lang],
  );
  const incomplete = info !== undefined && isReferenceIncomplete(info.record);
  const blank = info !== undefined && isReferenceBlank(info.record);
  const empty = count === 0;
  const unknown = count === undefined;

  const styleEntries: MenuEntry[] = CITATION_STYLES.map((value) => ({
    id: value,
    label: t(STYLE_KEYS[value]),
    checked: value === style,
    radio: true,
    onSelect: () => setStyle(value),
  }));
  const formatEntries: MenuEntry[] = CITATION_FILE_FORMATS.map((value) => ({
    id: value,
    label: t(FORMAT_KEYS[value]),
    checked: value === format,
    radio: true,
    onSelect: () => setFormat(value),
  }));
  const emptyTip = empty ? t('reference.empty') : undefined;

  return (
    <div className={cx('flex flex-col gap-3', constrained ? 'w-full' : 'w-popover-max max-w-full')}>
      <div className="flex flex-col gap-1">
        <span className="t-label text-text">{t('reference.style')}</span>
        <Menu
          label={t('reference.style')}
          side="bottom"
          align="start"
          entries={styleEntries}
          trigger={(trigger) => (
            <Button {...trigger} className="w-full justify-between">
              <span className="min-w-0 truncate">{t(STYLE_KEYS[style])}</span>
              <Icon icon={ChevronDown} />
            </Button>
          )}
        />
      </div>

      <div className="flex flex-col gap-1">
        <span className="t-caption text-text-muted">{t('reference.preview')}</span>
        <div
          aria-live="polite"
          aria-busy={loading}
          className="min-h-[var(--preview-min-height)] rounded-sm bg-subtle p-3 text-md text-text"
        >
          {/* The 24 hanging indent of a reference entry (DESIGN 3.7 C7). */}
          <div className="ps-6 -indent-6">
            {block === undefined ? (
              <Skeleton shape="line" className="w-full" />
            ) : blank ? null : (
              block.runs.map((run, index) =>
                run.italic ? <i key={index}>{run.text}</i> : <span key={index}>{run.text}</span>,
              )
            )}
          </div>
        </div>
        {incomplete && (
          <p className="t-caption m-0 flex items-center gap-1 text-text">
            <Icon icon={TriangleAlert} />
            {t('reference.missing')}
          </p>
        )}
      </div>

      <Button
        disabled={info === undefined}
        onClick={() => {
          void copyReference(docId);
        }}
      >
        {t('reference.copy')}
      </Button>

      <div role="separator" className="h-px bg-border-subtle" />

      <div className="flex flex-col gap-2">
        <div className="flex items-baseline justify-between gap-2">
          <span className="t-label text-text">{t('reference.list')}</span>
          {count !== undefined && (
            <span className="t-caption tabular-nums text-text-muted">{t('reference.count', { count })}</span>
          )}
        </div>
        {empty && <p className="t-caption m-0 text-text-muted">{t('reference.empty')}</p>}
        <div className="flex items-center gap-2">
          <Button
            className="min-w-0 flex-1"
            disabled={empty || unknown}
            focusableWhenDisabled
            title={emptyTip}
            onClick={() => {
              void copyCitationList(docId);
            }}
          >
            {t('reference.copyList')}
          </Button>
          <Button
            className="min-w-0 flex-1"
            disabled={(empty && format !== 'ris' && format !== 'bib') || unknown}
            focusableWhenDisabled
            title={emptyTip}
            onClick={() => {
              void saveCitationList(docId);
            }}
          >
            {t('reference.saveList')}
          </Button>
          <Menu
            label={t(FORMAT_KEYS[format])}
            side="bottom"
            align="end"
            entries={formatEntries}
            trigger={(trigger) => (
              <IconButton {...trigger} size="sm" icon={ChevronDown} label={t(FORMAT_KEYS[format])} />
            )}
          />
        </div>
      </div>

      <Button
        variant="ghost"
        className="self-start"
        onClick={() => {
          close();
          onEditReference();
        }}
      >
        {t('citation.editReference')}
      </Button>
    </div>
  );
}

/**
 * The Reference button and its popover (DESIGN 3.7 C7), for the filter row of the Comments tab: citation style, a live preview of the
 * reference, Copy reference, the citation list (Copy, Save) and Edit reference.
 */
export function ReferenceButton({ docId, onEditReference }: ReferenceButtonProps) {
  const t = useT();
  const edit = onEditReference ?? (() => openReferenceDetails(docId));
  const anchor = useRef<HTMLElement | null>(null);
  const [width, setWidth] = useState<number | undefined>(undefined);
  const [open, setOpen] = useState(false);
  // The width follows the panel while the popover is open (a splitter drag or a collapse changes it).
  useEffect(() => {
    const panel = open ? anchor.current?.closest<HTMLElement>('[data-region="left"]') : null;
    if (panel === null || panel === undefined || typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(() => setWidth(popoverWidthIn(anchor.current)));
    observer.observe(panel);
    return () => observer.disconnect();
  }, [open]);
  return (
    <Popover
      label={t('reference.button')}
      side="bottom"
      align="end"
      width={width}
      onOpenChange={(open) => {
        setOpen(open);
        if (open) setWidth(popoverWidthIn(anchor.current));
      }}
      trigger={(trigger) => (
        <IconButton
          {...trigger}
          ref={(element) => {
            anchor.current = element;
            trigger.ref(element);
          }}
          size="sm"
          icon={BookMarked}
          label={t('reference.button')}
        />
      )}
    >
      {({ close }) => (
        <ReferenceBody
          constrained={width !== undefined}
          docId={docId}
          close={() => close('select')}
          onEditReference={edit}
        />
      )}
    </Popover>
  );
}
