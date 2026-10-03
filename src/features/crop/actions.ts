import { announce } from '../../components/SuccessPulse';
import { cropPages, type CropSpec, type PageCrop, type PageSlotInfo } from '../../api/pages';
import { toAppError } from '../../api/errors';
import { translators } from '../../i18n';
import { useLocaleStore } from '../../i18n/store';
import { useAnnotations } from '../../stores/annotations';
import { useDocuments } from '../../stores/documents';
import { readSlots } from '../../stores/pages';
import { useUi } from '../../stores/ui';
import { pageIndices, parseRanges } from '../jobs/ranges';
import { MIN_CROP_PT } from './geometry';
import { useCrop, type Scope } from './store';

/**
 * The pages a scope covers, as page ids in page order: the current page, all pages, or the ranges as typed ("1-3, 5", positions 1-based).
 * `null` when a range is not valid, and for an empty one.
 */
export function targetPages(
  slots: readonly PageSlotInfo[],
  current: PageSlotInfo,
  scope: Scope,
  range: string,
): PageSlotInfo[] | null {
  if (scope === 'current') return [current];
  if (scope === 'all') return [...slots];
  const ranges = parseRanges(range, slots.length);
  if (ranges === null) return null;
  const picked = pageIndices(ranges)
    .map((index) => slots[index])
    .filter((slot): slot is PageSlotInfo => slot !== undefined);
  return picked.length > 0 ? picked : null;
}

/** Whether the margins leave at least the minimum on every one of the pages (the backend would refuse it otherwise). */
export function fitsAll(margins: PageCrop, pages: readonly PageSlotInfo[]): boolean {
  return pages.every((page) => {
    const width = page.media?.width ?? page.width;
    const height = page.media?.height ?? page.height;
    return (
      width - margins.left - margins.right >= MIN_CROP_PT - 1e-6 &&
      height - margins.top - margins.bottom >= MIN_CROP_PT - 1e-6
    );
  });
}

/** Whether the pages differ in size (the inspector says the same margins apply to each). */
export function sizesDiffer(pages: readonly PageSlotInfo[]): boolean {
  const [first] = pages;
  if (first === undefined) return false;
  const size = (page: PageSlotInfo) => `${page.media?.width ?? page.width}x${page.media?.height ?? page.height}`;
  return pages.some((page) => size(page) !== size(first));
}

/** The tour's sample cannot change. */
function isReadOnly(docId: number): boolean {
  return useDocuments.getState().byId[docId]?.kind === 'welcome';
}

/**
 * Sends the crop of `pages` as one command (one undo step), ends the mode and says what happened. A refusal goes to the banner and the
 * mode stays, so the user can correct the margins. Resolves to whether the crop was applied.
 */
export async function runCrop(docId: number, pages: readonly PageSlotInfo[], spec: CropSpec): Promise<boolean> {
  if (pages.length === 0 || isReadOnly(docId)) return false;
  try {
    await useAnnotations.getState().apply(
      docId,
      cropPages(
        pages.map((page) => page.id),
        spec,
      ),
    );
  } catch (caught) {
    useUi.getState().showBanner(toAppError(caught));
    return false;
  }
  const t = translators[useLocaleStore.getState().locale];
  announce(t('crop.done', { count: pages.length }));
  useUi.getState().releaseTool();
  return true;
}

/** Apply: the margins of the draft (or of the current crop) on the pages of the chosen scope. Does nothing when the input is not valid. */
export function applyCrop(docId: number, current: PageSlotInfo, margins: PageCrop): Promise<boolean> {
  const { scope, range } = useCrop.getState();
  const pages = targetPages(readSlots(docId), current, scope, range);
  if (pages === null || !fitsAll(margins, pages)) return Promise.resolve(false);
  return runCrop(docId, pages, { type: 'margins', ...margins });
}

/** Reset: the pages of the chosen scope go back to their MediaBox. */
export function resetCrop(docId: number, current: PageSlotInfo): Promise<boolean> {
  const { scope, range } = useCrop.getState();
  const pages = targetPages(readSlots(docId), current, scope, range);
  if (pages === null) return Promise.resolve(false);
  return runCrop(docId, pages, { type: 'reset' });
}

/** Cancel: leaves the mode; nothing was sent. */
export function cancelCrop(): void {
  useUi.getState().releaseTool();
}
