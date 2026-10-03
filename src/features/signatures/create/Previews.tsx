import { useEffect, useState } from 'react';

import { getSignaturePreview, type SignatureArt, type SignatureRef } from '../../../api/signatures';
import { useT } from '../../../i18n';
import { isVector, pathData, type SigColour } from './model';

export const INK_CLASS: Readonly<Record<SigColour, string>> = { black: 'text-annot-black', blue: 'text-annot-blue' };

/** The surface of the pad and of the previews: a document surface, white in both themes (DESIGN 3.33). */
export const PAD_SURFACE =
  'relative overflow-hidden rounded-button border border-divider bg-page forced-colors:border-text';

const RASTER_PREVIEW_PX = 512;

/** Vector art as one filled path (nonzero rule), scaled to fit. */
export function VectorPreview({ art, colour }: { art: Extract<SignatureArt, { type: 'vector' }>; colour: SigColour }) {
  return (
    <svg
      viewBox={`0 0 ${art.w} ${art.h}`}
      preserveAspectRatio="xMidYMid meet"
      aria-hidden="true"
      className={`size-full ${INK_CLASS[colour]}`}
    >
      <path d={pathData(art.paths)} fill="currentColor" fillRule="nonzero" />
    </svg>
  );
}

/** A PNG of raster art from the backend, shown through an object URL that is revoked when it is replaced. */
function RasterPreview({ draftId, label }: { draftId: number; label: string }) {
  const [url, setUrl] = useState<string | null>(null);
  useEffect(() => {
    let cancelled = false;
    let made: string | null = null;
    const ref: SignatureRef = { type: 'draft', id: draftId };
    getSignaturePreview(ref, RASTER_PREVIEW_PX)
      .then((frame) => {
        if (cancelled) return;
        made = URL.createObjectURL(new Blob([frame.data], { type: 'image/png' }));
        setUrl(made);
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
      if (made !== null) URL.revokeObjectURL(made);
    };
  }, [draftId]);
  return url === null ? null : <img src={url} alt={label} className="size-full object-contain" />;
}

/** The preview of a draft in the pad surface: vector art as a path, raster art as an image. */
export function ArtPreview({ draft, colour }: { draft: { id: number; art: SignatureArt }; colour: SigColour }) {
  const t = useT();
  return isVector(draft.art) ? (
    <VectorPreview art={draft.art} colour={colour} />
  ) : (
    <RasterPreview draftId={draft.id} label={t('sign.preview')} />
  );
}
