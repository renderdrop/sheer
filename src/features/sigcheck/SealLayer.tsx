import { memo, useMemo, useState, type CSSProperties, type FC } from 'react';

import { Tooltip } from '../../components';
import { useT } from '../../i18n';
import { selectActiveId, useDocuments } from '../../stores/documents';
import { fileRotationOf } from '../viewer/fileRotation';
import type { PageLayerProps } from '../viewer/pageLayer';
import { normalizeRotation, overlayBox, swapsSides, totalRotation, unrotatedSize } from '../viewer/transform';
import { openSignaturesDialog } from './open';
import { useSigcheck } from './store';
import { clean, isBad, sealBox, signerName, stateOf, type SigState } from './summary';

function stateWord(t: ReturnType<typeof useT>, state: SigState): string {
  if (state === 'intact') return t('sigs.state.intact');
  if (state === 'later') return t('sigs.state.later');
  if (state === 'changed') return t('sigs.state.changed');
  return t('sigs.state.unknown');
}

/**
 * The seals of the signed signature fields on one page (DESIGN v1.4 S6, "Seal on the page", in-app only): a transparent button over
 * each seal, in the page's Tab order. Hover or focus draws the outline pair of DESIGN 2.1 and shows "{name} · {state}"; a changed or
 * unverifiable signature adds a 2 px danger outline. Enter or a click opens the Signatures dialog at that card. The seal's own
 * picture is untouched, so a copied or altered seal cannot fake a status: this layer is the only place that says what is valid.
 */
export const SealLayer: FC<PageLayerProps> = memo(function SealLayer({
  docId,
  pageIndex,
  boxWidth,
  boxHeight,
  widthPt,
  heightPt,
  rotation: rotationProp,
  ready,
}) {
  const t = useT();
  const activeDocument = useDocuments(selectActiveId) === docId;
  const entry = useSigcheck((state) => state.byDoc[docId]);
  const shown = useSigcheck((state) => state.shown);
  const [active, setActive] = useState<number | null>(null);

  const seals = useMemo(
    () =>
      entry?.status === 'ready'
        ? entry.report.signatures.filter((sig) => sig.widget !== null && sig.widget.pageId === pageIndex)
        : [],
    [entry, pageIndex],
  );

  const rotation = normalizeRotation(rotationProp);
  const file = fileRotationOf(docId, pageIndex);
  const page = useMemo(() => unrotatedSize([widthPt, heightPt], file), [widthPt, heightPt, file]);
  const total = totalRotation(file, rotation);
  const shownWidthPt = swapsSides(rotation) ? heightPt : widthPt;
  const pxPerPt = shownWidthPt > 0 ? boxWidth / shownWidthPt : 1;

  if (!ready || !activeDocument || seals.length === 0) return null;

  const style = {
    ...overlayBox(boxWidth, boxHeight, page, pxPerPt, total),
    transformOrigin: 'center',
    '--page-scale': pxPerPt,
  } as CSSProperties;

  return (
    <div data-seal-layer="" className="pointer-events-none absolute inset-0 z-canvas-annotations">
      <div role="group" className="absolute" style={style}>
        {seals.map((sig) => {
          if (sig.widget === null) return null;
          const box = sealBox(sig.widget.rect, page[1]);
          const state = stateOf(sig);
          const name = signerName(sig);
          const word = stateWord(t, state);
          const on = active === sig.index || (shown?.docId === docId && shown.index === sig.index);
          const scale = 'var(--page-scale, 1)';
          const outlines: string[] = [];
          if (on) outlines.push(`0 0 0 calc(var(--focus-width) / ${scale}) var(--color-focus)`);
          if (isBad(state)) outlines.push(`0 0 0 calc(2px / ${scale}) var(--color-danger)`);
          return (
            <Tooltip key={sig.index} label={`${clean(name)} · ${word}`}>
              <button
                type="button"
                data-seal={sig.index}
                data-state={state}
                aria-label={t('sigs.aria', { name, state: word })}
                className="pointer-events-auto absolute cursor-pointer appearance-none border-0 bg-transparent p-0"
                style={{
                  left: box.x,
                  top: box.y,
                  width: box.w,
                  height: box.h,
                  boxShadow: outlines.length > 0 ? outlines.join(', ') : undefined,
                  outline: on ? `calc(var(--hairline) / ${scale}) solid var(--color-ink)` : 'none',
                  outlineOffset: `calc(var(--focus-width) / ${scale})`,
                }}
                onPointerEnter={() => setActive(sig.index)}
                onPointerLeave={() => setActive((current) => (current === sig.index ? null : current))}
                onFocus={() => setActive(sig.index)}
                onBlur={() => setActive((current) => (current === sig.index ? null : current))}
                onClick={() => openSignaturesDialog(docId, sig.index)}
              />
            </Tooltip>
          );
        })}
      </div>
    </div>
  );
});
