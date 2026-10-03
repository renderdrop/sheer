import { useMemo } from 'react';
import { create } from 'zustand';

import type { PageCrop, PageSlotInfo } from '../../api/pages';
import { selectActiveId, useDocuments } from '../../stores/documents';
import { useSlots } from '../../stores/pages';
import { useView } from '../../stores/view';
import { totalRotation, type Rotation } from '../viewer/transform';
import { NO_MARGINS, type CropFrame } from './geometry';

export type Scope = 'current' | 'all' | 'range';

/** What the user has changed in the crop mode so far (nothing is sent before Apply). `key` ties the margins to one page of one document. */
interface Draft {
  key: string | null;
  margins: PageCrop | null;
  scope: Scope;
  range: string;
}

interface CropState extends Draft {
  setMargins: (key: string, margins: PageCrop) => void;
  setScope: (scope: Scope) => void;
  setRange: (range: string) => void;
  /** Back to the start (the mode begins or ends). */
  clear: () => void;
}

const FRESH: Draft = { key: null, margins: null, scope: 'current', range: '' };

export const useCrop = create<CropState>()((set) => ({
  ...FRESH,
  setMargins: (key, margins) => set({ key, margins }),
  setScope: (scope) => set({ scope }),
  setRange: (range) => set({ range }),
  clear: () => set(FRESH),
}));

export const keyOf = (docId: number, pageId: number): string => `${docId}:${pageId}`;

/** The frame of a page: its MediaBox and the part that is shown now. A page without both is taken to be uncropped at its own size. */
export function frameOf(slot: PageSlotInfo): CropFrame {
  return {
    media: slot.media ?? { width: slot.width, height: slot.height },
    bounds: slot.crop ?? NO_MARGINS,
  };
}

/** The crop the page has as margins (the rectangle the mode starts with). */
export function currentMargins(slot: PageSlotInfo): PageCrop {
  return slot.crop ?? NO_MARGINS;
}

export interface CropTarget {
  docId: number;
  slot: PageSlotInfo;
  slots: readonly PageSlotInfo[];
  frame: CropFrame;
  /** The rotation of what is on screen: the file's `/Rotate` and the view's. */
  total: Rotation;
  /** The rectangle in margins: the draft's, else the crop the page has. */
  margins: PageCrop;
}

/** The page the crop mode works on (the current page of the active document), or `null` without a document. */
export function useCropTarget(): CropTarget | null {
  const docId = useDocuments(selectActiveId);
  const slots = useSlots(docId);
  const pageIndex = useView((state) => (docId === null ? 0 : (state.byDoc[docId]?.pageIndex ?? 0)));
  const view = useView((state) => (docId === null ? 0 : (state.byDoc[docId]?.rotation ?? 0)));
  const draft = useCrop((state) => state.margins);
  const key = useCrop((state) => state.key);
  const slot = slots[Math.min(pageIndex, slots.length - 1)];
  return useMemo(() => {
    if (docId === null || slot === undefined) return null;
    const own = key === keyOf(docId, slot.id) && draft !== null;
    return {
      docId,
      slot,
      slots,
      frame: frameOf(slot),
      total: totalRotation(slot.rotation, view),
      margins: own ? draft : currentMargins(slot),
    };
  }, [docId, slot, slots, view, draft, key]);
}
