import { useEffect, useState } from 'react';

import {
  getSignaturePreview,
  useSignature as copyIntoDocument,
  type AssetInfo,
  type SignatureArt,
  type SignatureRef,
} from '../../../api/signatures';

/**
 * The art of the signatures placed in this session. `useSignature` copies art into the document's assets once per (document, source);
 * the answer carries the art, which the layer draws until the file is read again (then the page bitmap shows the file's own picture).
 * Nothing here holds file bytes: vector art is polygons, raster art is fetched as a PNG frame.
 */

type Source = Extract<SignatureRef, { type: 'library' | 'draft' }>;

const assets = new Map<string, Promise<AssetInfo>>();
const arts = new Map<string, SignatureArt>();

const sourceKey = (ref: Source): string => (ref.type === 'library' ? `l:${ref.id}` : `d:${ref.id}`);
const artKey = (docId: number, assetId: number): string => `${docId}:${assetId}`;

/** The document's asset for this source: made on the first call, the same one afterwards. A failed call is tried again next time. */
export function ensureAsset(docId: number, ref: Source): Promise<AssetInfo> {
  const key = `${docId}:${sourceKey(ref)}`;
  const known = assets.get(key);
  if (known !== undefined) return known;
  const made = copyIntoDocument(docId, ref).then((info) => {
    arts.set(artKey(docId, info.assetId), info.art);
    return info;
  });
  assets.set(key, made);
  made.catch(() => assets.delete(key));
  return made;
}

/** The art of an asset of this session, `null` for one that is only in the file. */
export function assetArt(docId: number, assetId: number): SignatureArt | null {
  return arts.get(artKey(docId, assetId)) ?? null;
}

/** Forgets everything held (tests). */
export function forgetAssets(): void {
  assets.clear();
  arts.clear();
}

/** Longest side of the preview of raster art, in px. */
const PREVIEW_PX = 512;

/** An object URL of the PNG of a raster asset: `null` until it is there or when it cannot be had. Revoked when not needed. */
export function useRasterUrl(docId: number, assetId: number, enabled: boolean): string | null {
  const [url, setUrl] = useState<string | null>(null);
  useEffect(() => {
    if (!enabled) return;
    let current: string | null = null;
    let cancelled = false;
    getSignaturePreview({ type: 'asset', docId, assetId }, PREVIEW_PX).then(
      (frame) => {
        if (cancelled) return;
        current = URL.createObjectURL(new Blob([frame.data], { type: 'image/png' }));
        setUrl(current);
      },
      () => undefined,
    );
    return () => {
      cancelled = true;
      if (current !== null) URL.revokeObjectURL(current);
      setUrl(null);
    };
  }, [docId, assetId, enabled]);
  return enabled ? url : null;
}
