import { create } from 'zustand';

import { releaseImageBatch } from '../../api/imagesToPdf';
import { useUi } from '../../stores/ui';

/** A batch of dropped images the backend holds for the dialog (ADR-049): the UI knows only the counts, never a name or a path. */
export interface DroppedBatch {
  batch: number;
  count: number;
  skipped: number;
}

interface ImagesToPdfState {
  /** The dropped batch the open dialog works on; `null` when the images come from Rust's open dialog. */
  dropped: DroppedBatch | null;
  setDropped: (dropped: DroppedBatch | null) => void;
}

export const useImagesToPdf = create<ImagesToPdfState>()((set) => ({
  dropped: null,
  setDropped: (dropped) => set({ dropped }),
}));

/** Lets go of the held batch (if any) and forgets it. */
export function releaseDropped(): void {
  const { dropped, setDropped } = useImagesToPdf.getState();
  if (dropped === null) return;
  setDropped(null);
  releaseImageBatch(dropped.batch).catch(() => undefined);
}

/** Opens the dialog for a dropped batch; an earlier batch that was never used is released. */
export function openWithBatch(next: DroppedBatch): void {
  releaseDropped();
  useImagesToPdf.getState().setDropped(next);
  useUi.getState().setImagesToPdfOpen(true);
}

/** Closes the dialog; a batch it still holds goes back to the backend (cancel). */
export function closeImagesToPdf(): void {
  releaseDropped();
  useUi.getState().setImagesToPdfOpen(false);
}
