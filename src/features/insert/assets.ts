import { getAssetPreview } from '../../api/content';

/** The long side of the preview of an image asset, in pixels: enough for a page at a high zoom without holding the full picture. */
export const PREVIEW_PX = 1_024;

const urls = new Map<string, Promise<string>>();

const key = (docId: number, assetId: number) => `${docId}:${assetId}`;

/**
 * An object URL of the preview of an image asset (the pixels stay in the backend). One request and one URL per asset; they are
 * revoked when the document closes (`forgetAssets`).
 */
export function assetUrl(docId: number, assetId: number): Promise<string> {
  const k = key(docId, assetId);
  let known = urls.get(k);
  if (known === undefined) {
    known = getAssetPreview(docId, assetId, PREVIEW_PX).then((frame) =>
      URL.createObjectURL(new Blob([frame.data], { type: 'image/png' })),
    );
    // A failed request is not remembered, so the next try asks again.
    known.catch(() => urls.delete(k));
    urls.set(k, known);
  }
  return known;
}

/** Revokes the previews of a closed document. */
export function forgetAssets(docId: number): void {
  const prefix = `${docId}:`;
  for (const [k, url] of [...urls]) {
    if (!k.startsWith(prefix)) continue;
    urls.delete(k);
    url.then((href) => URL.revokeObjectURL(href)).catch(() => undefined);
  }
}
