import { ImageOff } from 'lucide-react';

import type { LibraryItem } from '../../../api/library';
import { Icon } from '../../../components';
import { cx } from '../../../components/cx';
import { useT } from '../../../i18n';
import { pathToD } from '../ink';

export const pathData = pathToD;

/**
 * The preview chip of a library row (DESIGN 3.35): 120 x 40 on the page colour (white in both themes, as the document is), with a
 * hairline border (`CanvasText` under forced colors). Vector art is drawn as an SVG fitted in the chip; a raster entry has no
 * preview from the backend yet, so the chip shows a placeholder glyph.
 */
export function SignaturePreview({ item, compact = false }: { item: LibraryItem; compact?: boolean }) {
  const t = useT();
  const art = item.preview !== null && 'vector' in item.preview ? item.preview.vector : null;
  return (
    <span
      data-lib-preview=""
      className={cx(
        'flex shrink-0 items-center justify-center overflow-hidden rounded-sm border border-divider bg-page px-1 forced-colors:border-text',
        compact ? 'h-(--sig-thumb-menu-h) w-(--sig-thumb-menu-w)' : 'h-sig-thumb-h w-sig-thumb-w',
      )}
    >
      {art !== null ? (
        <svg
          aria-hidden="true"
          viewBox={`0 0 ${art.w} ${art.h}`}
          preserveAspectRatio="xMidYMid meet"
          className="size-full text-doc-ink"
        >
          <path d={pathData(art.paths)} fill="currentColor" />
        </svg>
      ) : (
        <span role="img" aria-label={t('lib.previewLater')} title={t('lib.previewLater')} className="text-doc-ink">
          <Icon icon={ImageOff} />
        </span>
      )}
    </span>
  );
}
