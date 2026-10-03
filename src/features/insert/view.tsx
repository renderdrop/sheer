import { useEffect, useState } from 'react';

import type { StdFont } from '../../api/annotations';
import type { Rect } from '../../api/wire';
import { rgbToCss } from '../inspector/palette';
import { assetUrl } from './assets';
import { LINE_HEIGHT } from './geometry';
import type { ContentObject } from './store';

/** The standard 14 faces of a text box, with their metric neighbours for systems without them. */
export const FONT_STACKS: Readonly<Record<StdFont, string>> = {
  sans: 'Helvetica, "Helvetica Neue", Arial, "Liberation Sans", sans-serif',
  serif: '"Times New Roman", Times, "Liberation Serif", serif',
  mono: '"Courier New", Courier, "Liberation Mono", monospace',
};

/** The preview of an image asset, stretched over its box (the box keeps the aspect, the backend refuses other aspects). */
export function ImageView({
  docId,
  assetId,
  box,
  opacity,
}: {
  docId: number;
  assetId: number;
  box: Rect;
  opacity: number;
}) {
  const [url, setUrl] = useState<string | null>(null);
  useEffect(() => {
    let cancelled = false;
    assetUrl(docId, assetId)
      .then((href) => {
        if (!cancelled) setUrl(href);
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [docId, assetId]);
  return (
    <div
      aria-hidden="true"
      data-insert-image=""
      className="pointer-events-none absolute"
      style={{ left: box.x, top: box.y, width: box.w, height: box.h, opacity }}
    >
      {url !== null && <img src={url} alt="" draggable={false} className="size-full select-none" />}
    </div>
  );
}

/** A text box or an image as it is drawn while unsaved (a save burns it into the page). `box` is the preview while it is dragged. */
export function ObjectView({ docId, object, box }: { docId: number; object: ContentObject; box: Rect }) {
  if (object.kind === 'image') {
    return <ImageView docId={docId} assetId={object.assetId} box={box} opacity={object.opacity} />;
  }
  return (
    <div
      aria-hidden="true"
      data-insert-text=""
      className="pointer-events-none absolute overflow-hidden"
      style={{
        left: box.x,
        top: box.y,
        width: box.w,
        height: box.h,
        fontFamily: FONT_STACKS[object.font],
        fontSize: object.fontSize,
        lineHeight: LINE_HEIGHT,
        color: rgbToCss(object.color),
        opacity: object.opacity,
        textAlign: object.align,
        whiteSpace: 'pre',
      }}
    >
      {object.lines.join('\n')}
    </div>
  );
}
