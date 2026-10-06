import { TriangleAlert, Type } from 'lucide-react';

import { Button, Icon, Popover } from '../../components';
import { formatNumber, useLocale, useT } from '../../i18n';
import { FACE_NAME } from './model';
import { useTextEdit } from './store';

/** Marks a control as one stop of the bar's roving focus (the same attribute the properties bar uses). */
const ITEM = { 'data-mb-item': '' } as const;

/** The popover's width (DESIGN 3.10 E3). */
const WIDTH = 280;

function Row({ label, children, numeric = false }: { label?: string; children: string; numeric?: boolean }) {
  return (
    <div className="flex flex-col">
      {label !== undefined && <dt className="t-caption text-text-muted">{label}</dt>}
      <dd className={`t-body m-0 break-words text-text${numeric ? ' tabular-nums' : ''}`}>{children}</dd>
    </div>
  );
}

/**
 * The Font button of the edit bar and its popover (DESIGN 3.10 E3): a fixed label, never the font name (Q9), and `triangle-alert`
 * while a substitute is in use. The rows are text only: the PostScript name comes from the document and is never interpreted.
 */
export function FontPopover() {
  const t = useT();
  const locale = useLocale();
  const session = useTextEdit((s) => s.session);
  if (session === null) return null;
  const { font } = session.line;
  const fallback = session.fallback;
  return (
    <Popover
      label={t('editText.font')}
      side="bottom"
      align="start"
      width={WIDTH}
      trigger={(trigger) => (
        <Button {...trigger} {...ITEM} data-textedit-font="" variant="ghost" className="h-8! gap-1 px-2! text-md">
          {fallback !== null && <Icon icon={TriangleAlert} size={16} />}
          <Icon icon={Type} size={16} />
          {t('editText.font')}
        </Button>
      )}
    >
      <dl data-surface="textedit-font-popover" className="m-0 flex flex-col gap-3 p-3">
        <Row label={t('editText.font.original')}>{font.name}</Row>
        <Row>{t(font.embedded ? 'editText.font.embedded' : 'editText.font.notEmbedded')}</Row>
        {fallback !== null && <Row label={t('editText.font.fallback')}>{FACE_NAME[fallback.face]}</Row>}
        {fallback !== null && (
          <Row label={t('editText.font.count')} numeric>
            {formatNumber(new Set(fallback.chars).size, locale)}
          </Row>
        )}
      </dl>
    </Popover>
  );
}
