import { call } from './call';
import { toAppError } from './errors';
import { parseFrame, type RenderFrame } from './frame';
import { isUint } from './wire';

/**
 * Text boxes and images on the page (ARCHITECTURE section 5, "Edit and protect"; ADR-047; src-tauri/src/commands/content.rs).
 * Both are created, updated, moved and deleted with the annotation commands (`createAnnotation` of kind `textBox` or `image`, see
 * `annotations.ts`); they are page content that the next save burns in, not comments. The pixels of an image stay in the backend: the
 * UI holds an asset id and asks for frames. No path crosses in either direction.
 */

/** The size range of `getAssetPreview` in pixels on the long side. */
export const MIN_ASSET_PREVIEW_PX = 16;
export const MAX_ASSET_PREVIEW_PX = 2_048;

/** An inserted image: its asset, its size in pixels after downsizing (at most 4 096 on the long side) and width over height. */
export interface ImageAssetInfo {
  assetId: number;
  width: number;
  height: number;
  aspect: number;
}

/** Validates the answer of `insert_image_dialog`; `null` if it is not an `ImageAssetInfo`. Extra keys are dropped. */
export function parseImageAssetInfo(value: unknown): ImageAssetInfo | null {
  if (typeof value !== 'object' || value === null) return null;
  const { assetId, width, height, aspect } = value as Record<string, unknown>;
  if (
    !isUint(assetId) ||
    !isUint(width, 8_192) ||
    !isUint(height, 8_192) ||
    width < 1 ||
    height < 1 ||
    typeof aspect !== 'number' ||
    !(aspect > 0 && aspect <= 100_000)
  )
    return null;
  return { assetId, width, height, aspect };
}

/**
 * Opens the Rust image dialog (PNG, JPEG) and stores the chosen picture as an asset of the document. `null`: the dialog was cancelled.
 * Then send `createAnnotation` with `kind: 'image'` and the returned `assetId` and `aspect`. Rejects with `limit_exceeded` (`image`),
 * `invalid_argument` (`image`), or `read_only` (`permission`).
 */
export async function insertImageDialog(docId: number): Promise<ImageAssetInfo | null> {
  const answer = await call<unknown>('insert_image_dialog', { docId });
  if (answer === null) return null;
  const info = parseImageAssetInfo(answer);
  if (info === null) throw toAppError(null);
  return info;
}

/** A PNG frame of an image asset, at most `maxPx` (16 to 2 048) on its long side. */
export async function getAssetPreview(docId: number, assetId: number, maxPx: number): Promise<RenderFrame> {
  const body = await call<ArrayBuffer>('get_asset_preview', { docId, assetId, maxPx });
  const frame = parseFrame(new Uint8Array(body));
  if (frame === null) throw toAppError(null);
  return frame;
}
