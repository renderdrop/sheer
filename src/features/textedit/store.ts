import { create } from 'zustand';

import type { FallbackFace, TextEditRefusal, TextLineInfo } from '../../api/textEdit';
import type { Rect } from '../../api/wire';

/**
 * Editing existing text (DESIGN 3.10, ADR-125, ADR-128): the one line being edited and what the surfaces around it show. Seam of
 * v1.5.1 wave 2: the edit layer (P1) writes `session`, `status`, `anchor`, `overflowPt` and `refusal`; the mini bar, Font popover and
 * fallback notice (P2) and the refusal tooltips and announcements (P3) only read them. Nothing here holds file bytes or paths.
 */
export type EditStatus = 'editing' | 'busy' | 'error';

export interface EditSession {
  docId: number;
  pageId: number;
  /** 1-based page number, for `editText.aria.line`. */
  pageNumber: number;
  line: TextLineInfo;
  draft: string;
  status: EditStatus;
  /** Points the draft runs past the free width (0 = fits); DESIGN 3.10 E2 overflow. */
  overflowPt: number;
  /** The substitute in use for this line, and the distinct characters set in it (E4); null = the original font. */
  fallback: { face: FallbackFace; chars: readonly string[] } | null;
}

/** Why the line under the pointer (or clicked) cannot be edited; `rect` is in client pixels, for the tooltip anchor. */
export interface Refusal {
  reason: TextEditRefusal | 'noText';
  rect: Rect;
  /** A click shows the tooltip at once and announces it; a hover waits for the normal tooltip delay. */
  via: 'hover' | 'click';
}

/** The one info notice of E4: which case, the original font's display name, the substitute and the characters set in it. */
export interface FallbackNotice {
  kind: 'notEmbedded' | 'missingGlyphs';
  font: string;
  face: FallbackFace;
  chars: readonly string[];
}

interface TextEditState {
  session: EditSession | null;
  /** The edit box in client pixels (mini bar placement, protected rects of the notice). */
  anchor: Rect | null;
  /** The paragraph rule in client pixels, if shown. */
  rule: Rect | null;
  refusal: Refusal | null;
  /** Set by P1 when an edit opens on a non-embedded font or an apply answers `fontFallback`; cleared on cancel, the next open or Hide. */
  notice: FallbackNotice | null;
  /** Where the edit box was when it closed with a notice still to show (client px): the notice's anchor and protected rect after Apply. */
  noticeAnchor?: Rect | null;
  set: (patch: Partial<Omit<TextEditState, 'set' | 'reset'>>) => void;
  patchSession: (patch: Partial<EditSession>) => void;
  reset: () => void;
}

const FRESH = { session: null, anchor: null, rule: null, refusal: null, notice: null, noticeAnchor: null };

export const useTextEdit = create<TextEditState>()((set) => ({
  ...FRESH,
  set: (patch) => set(patch),
  patchSession: (patch) => set((s) => (s.session ? { session: { ...s.session, ...patch } } : {})),
  reset: () => set(FRESH),
}));
