import { currentPlatform } from '../../actions/keys';
import { formatBinding, type Binding } from '../../actions/shortcut';
import { announce } from '../../components';
import { tokenPx } from '../../components/tokens';
import { translators } from '../../i18n';
import { useLocaleStore } from '../../i18n/store';
import { useDocuments } from '../../stores/documents';
import { pageIdAt, positionOf, readSlots } from '../../stores/pages';
import { useView } from '../../stores/view';
import { pageLabelOf } from '../topbar/format';
import { anchorAt, pageTopAnchor, type ScrollAnchor } from '../viewer/layout';
import { layoutFor } from '../viewer/model';
import { markJump, readScroll, waitForJumpEnd } from '../viewer/scrollBridge';
import { useViewer } from '../viewer/useViewer';
import { PULSE_STEP_MS, SCROLL_MAX_MS } from '../viewer/jump';
import { showMark } from './marks';
import { useHistoryStore, type HistoryEntry, type Rect } from './store';

/** The bindings of Back and Forward (DESIGN 3.11 L7): Alt+Left/Right, on macOS Cmd+[ and Cmd+]. */
export function historyBinding(direction: 'back' | 'forward', platform = currentPlatform()): Binding {
  if (platform === 'macos') return { key: direction === 'back' ? '[' : ']', mods: ['primary'] };
  return { key: direction === 'back' ? 'ArrowLeft' : 'ArrowRight', mods: ['alt'] };
}

/** Where a page target lands: its top this far below the canvas top (`--space-6`). */
const PAGE_TOP_OFFSET_FALLBACK = 24;
/** The target band is the target's box plus this many points on every side. */
const BAND_PAD_PT = 2;

/** The page number or label a page is shown with. */
function labelOfPage(docId: number, pageId: number): string {
  const position = positionOf(docId, pageId) ?? pageId;
  return pageLabelOf(readSlots(docId)[position]?.label, position);
}

/** The view as it is now, as a history entry; `null` without a document or a page. */
export function captureView(docId: number): HistoryEntry | null {
  const view = useView.getState().byDoc[docId];
  if (view === undefined) return null;
  const layout = layoutFor(docId, useViewer.getState().viewport ?? null);
  const anchor = layout === null ? null : anchorAt(layout, readScroll(), 0, 0);
  const pageId = pageIdAt(docId, anchor?.page ?? view.pageIndex);
  if (pageId === null) return null;
  return { pageId, xPt: anchor?.xPt ?? 0, yPt: Math.max(0, anchor?.yPt ?? 0), zoom: view.zoom, fit: view.fit };
}

/** The focused element if it got focus from the keyboard (so a keyboard jump gives focus back to the run it left). */
function keyboardFocus(): HTMLElement | null {
  const element = document.activeElement;
  if (!(element instanceof HTMLElement) || element === document.body) return null;
  try {
    return element.matches(':focus-visible') ? element : null;
  } catch {
    return null;
  }
}

function viewportHeight(): number {
  return useViewer.getState().viewport?.height ?? 0;
}

/** Saves the current view before a navigation that is not a scroll (outline row, page field, a link). */
export function pushView(docId: number, origin?: { pageId: number; rect: Rect }): void {
  const current = captureView(docId);
  if (current === null) return;
  const entry: HistoryEntry = { ...current };
  if (origin !== undefined) {
    entry.origin = origin;
    entry.focus = keyboardFocus();
  }
  useHistoryStore.getState().push(docId, entry, viewportHeight());
}

/** Zoom and fit first, then the scroll, both at once (a return must land exactly). `false` when the page is gone. */
function restore(docId: number, entry: HistoryEntry): boolean {
  const position = positionOf(docId, entry.pageId);
  if (position === null) return false;
  const anchor: ScrollAnchor = { page: position, xPt: entry.xPt, yPt: entry.yPt, viewX: 0, viewY: 0 };
  const view = useView.getState();
  if (entry.fit === 'none') view.setZoom(docId, entry.zoom, anchor);
  else view.setFit(docId, entry.fit, entry.zoom, anchor);
  view.setPage(docId, position, anchor);
  return true;
}

function say(key: 'smartlinks.announce.jump' | 'nav.announce.back', params: Record<string, string | number>): void {
  announce(translators[useLocaleStore.getState().locale](key, params));
}

function shownBinding(direction: 'back' | 'forward'): string {
  const platform = currentPlatform();
  return formatBinding(historyBinding(direction, platform), platform, translators[useLocaleStore.getState().locale])
    .label;
}

/**
 * Follows a smart or real link to `target` (DESIGN 3.11 L6): pushes the view it leaves (`origin` is the run that was followed),
 * scrolls with spell 8 (instant under reduced motion), shows the band, announces the jump. `rect` is in view-space page points
 * (rotation applied, top-left origin). Without a rect the page's top lands 24 px below the canvas top and there is no band.
 */
export function jumpTo(
  docId: number,
  target: { pageId: number; rect?: Rect | null },
  origin?: { pageId: number; rect: Rect },
): void {
  const position = positionOf(docId, target.pageId);
  if (position === null || useView.getState().byDoc[docId] === undefined) return;
  pushView(docId, origin);
  const rect = target.rect ?? null;
  if (rect !== null) {
    useViewer.getState().goToPoint(position, rect.y);
    const band = {
      x: rect.x - BAND_PAD_PT,
      y: rect.y - BAND_PAD_PT,
      w: rect.w + 2 * BAND_PAD_PT,
      h: rect.h + 2 * BAND_PAD_PT,
    };
    // The band appears when the scroll has landed (spell 8 then pulse); an instant jump lands at once.
    waitForJumpEnd(() => showMark('band', docId, target.pageId, band), SCROLL_MAX_MS + PULSE_STEP_MS);
  } else {
    const layout = layoutFor(docId, useViewer.getState().viewport ?? null, { current: position });
    const top = layout === null ? null : pageTopAnchor(layout, position, readScroll());
    const anchor = top === null ? null : { ...top, viewY: tokenPx('--space-6', PAGE_TOP_OFFSET_FALLBACK) };
    markJump();
    useView.getState().setPage(docId, position, anchor);
  }
  say('smartlinks.announce.jump', { page: labelOfPage(docId, target.pageId), back: shownBinding('back') });
}

function liveIds(docId: number): ReadonlySet<number> | null {
  const slots = readSlots(docId);
  return slots.length === 0 ? null : new Set(slots.map((slot) => slot.id));
}

function step(docId: number, direction: 'back' | 'forward'): void {
  const store = useHistoryStore.getState();
  const valid = liveIds(docId);
  if (valid !== null) store.prune(docId, valid);
  const current = captureView(docId);
  if (current === null) return;
  const target =
    direction === 'back' ? store.stepBack(docId, current) : useHistoryStore.getState().stepForward(docId, current);
  if (target === null || !restore(docId, target)) return;
  if (direction === 'back') {
    if (target.origin !== undefined) {
      showMark('origin', docId, target.origin.pageId, target.origin.rect);
    }
    const focus = target.focus;
    if (focus?.isConnected === true) focus.focus({ preventScroll: true });
    say('nav.announce.back', { page: labelOfPage(docId, target.pageId) });
  }
}

/** Back to the previous view (L7). Nothing when there is none. */
export function back(docId: number): void {
  step(docId, 'back');
}

/** Forward again after a Back. */
export function forward(docId: number): void {
  step(docId, 'forward');
}

/** The active document, or `null`. */
export function activeDoc(): number | null {
  return useDocuments.getState().activeId;
}
