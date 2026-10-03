import type { ChangeSet } from '../../api/annotations';
import { toAppError } from '../../api/errors';
import { MAX_REDACT_MARKS_PER_COMMAND, markRedactions, type RedactMarkSpec } from '../../api/redaction';
import { announce } from '../../components';
import { translators } from '../../i18n';
import { useLocaleStore } from '../../i18n/store';
import { useAnnotations } from '../../stores/annotations';
import { selectActiveId, useDocuments } from '../../stores/documents';
import { pageIdAt, positionOf } from '../../stores/pages';
import { useUi } from '../../stores/ui';
import { jumpToHit } from '../search/jump';
import { useSearch } from '../search/store';
import { peekLayer } from '../textlayer/cache';
import { hasTextSelection, resolveBoundary } from '../textlayer/selection';
import type { Box } from '../viewer/transform';
import { boxToQuad, chunkQuads, quadsForRange } from './geometry';
import { useRedact, type RedactMark } from './store';

/** The undo label of a resized mark (a catalog key, shown with Undo). */
const LABEL_RESIZE = 'annotation.update';

/** Announces the number of marks (polite live region). */
function sayCount(docId: number): void {
  announce(translators[useLocaleStore.getState().locale]('redact.title', { count: marksCount(docId) }));
}

function fail(error: unknown): void {
  useUi.getState().showBanner(toAppError(error));
}

/** Enters the redact mode: Select is the tool (the text can be marked), and the mode is on. */
export function enterRedactMode(): void {
  const ui = useUi.getState();
  ui.releaseTool();
  ui.setRedactMode(true);
}

/** Ends the redact mode; the marks stay (the banner reminds of them). */
export function endRedactMode(): void {
  useUi.getState().setRedactMode(false);
}

/** Runs `markRedactions` and applies its change set. Resolves with it, or `null` after a failure (the banner shows it). */
export async function addMarks(docId: number, specs: readonly RedactMarkSpec[]): Promise<ChangeSet | null> {
  if (specs.length === 0) return null;
  try {
    const changes = await markRedactions(docId, specs);
    useAnnotations.getState().applyChanges(docId, changes);
    sayCount(docId);
    return changes;
  } catch (error) {
    fail(error);
    return null;
  }
}

function marksCount(docId: number): number {
  return Object.keys(useRedact.getState().marks[docId] ?? {}).length;
}

/** Marks a rectangle of a page (page space) and selects the new mark. */
export async function markArea(docId: number, pageId: number, box: Box): Promise<void> {
  const changes = await addMarks(docId, [{ pageId, quads: [boxToQuad(box)], source: 'area' }]);
  const created = changes?.content?.find((item) => item.kind === 'redactMark');
  if (created !== undefined) useRedact.getState().select(docId, created.id);
}

/** Turns the hits of the active search into marks, all as one undo step, and opens the mode. */
export async function redactSearchResults(docId: number): Promise<void> {
  const entry = useSearch.getState().byDoc[docId];
  if (entry === undefined || entry.hits.length === 0) return;
  const specs: RedactMarkSpec[] = [];
  for (const hit of entry.hits) {
    if (hit.quads.length === 0) continue;
    for (const quads of chunkQuads(hit.quads)) specs.push({ pageId: hit.page, quads, source: 'text' });
  }
  const limited = specs.slice(0, MAX_REDACT_MARKS_PER_COMMAND);
  enterRedactMode();
  await addMarks(docId, limited);
}

/** The selection of the text layers as marks: one per page it touches. `null` when nothing is selected there. */
export function selectionSpecs(
  docId: number,
  selection: Selection | null = window.getSelection(),
): RedactMarkSpec[] | null {
  if (selection === null || !hasTextSelection(selection)) return null;
  const range = selection.getRangeAt(0);
  const a = resolveBoundary(range.startContainer, range.startOffset);
  const b = resolveBoundary(range.endContainer, range.endOffset);
  if (a === null || b === null) return null;
  const pa = positionOf(docId, a.page);
  const pb = positionOf(docId, b.page);
  if (pa === null || pb === null) return null;
  const backwards = pa > pb || (pa === pb && a.index > b.index);
  const [from, to] = backwards ? [b, a] : [a, b];
  const first = Math.min(pa, pb);
  const last = Math.max(pa, pb);
  const specs: RedactMarkSpec[] = [];
  for (let position = first; position <= last; position += 1) {
    const pageId = pageIdAt(docId, position);
    const layer = pageId === null ? undefined : peekLayer(docId, pageId);
    if (pageId === null || layer === undefined) continue;
    const start = position === first ? from.index : 0;
    const end = position === last ? to.index : layer.text.length;
    for (const quads of chunkQuads(quadsForRange(layer, start, end))) specs.push({ pageId, quads, source: 'text' });
  }
  return specs.length === 0 ? null : specs;
}

/** Marks the selected text of the active document and clears the selection. Returns whether it marked anything. */
export function markSelection(): boolean {
  const docId = selectActiveId(useDocuments.getState());
  if (docId === null) return false;
  const specs = selectionSpecs(docId);
  if (specs === null) return false;
  window.getSelection()?.removeAllRanges();
  void addMarks(docId, specs);
  return true;
}

/** Removes marks as one undo step. */
export async function removeMarks(docId: number, ids: readonly number[]): Promise<void> {
  if (ids.length === 0) return;
  try {
    await useAnnotations.getState().apply(docId, { type: 'deleteAnnotations', ids });
    sayCount(docId);
  } catch (error) {
    fail(error);
  }
}

/** Removes every mark of the document (one undo step). */
export function clearMarks(docId: number): Promise<void> {
  return removeMarks(docId, Object.keys(useRedact.getState().marks[docId] ?? {}).map(Number));
}

/** Moves an area mark by a delta in page space. */
export async function moveMark(docId: number, id: number, dx: number, dy: number): Promise<void> {
  try {
    await useAnnotations.getState().apply(docId, { type: 'moveAnnotations', ids: [id], dx, dy });
  } catch (error) {
    fail(error);
  }
}

/** Replaces an area mark by one over `box` (the backend patches no quads of a mark): one undo step; the new mark is selected. */
export async function resizeMark(docId: number, mark: RedactMark, box: Box): Promise<void> {
  try {
    const changes = await useAnnotations.getState().apply(docId, {
      type: 'batch',
      label: LABEL_RESIZE,
      commands: [
        { type: 'deleteAnnotations', ids: [mark.id] },
        {
          type: 'createAnnotation',
          draft: {
            pageId: mark.pageId,
            color: mark.color,
            kind: 'redactMark',
            quads: [boxToQuad(box)],
            source: 'area',
          },
        },
      ],
    });
    const created = changes.content?.find((item) => item.kind === 'redactMark');
    if (created !== undefined) useRedact.getState().select(docId, created.id);
  } catch (error) {
    fail(error);
  }
}

/** Scrolls to a mark and selects it (MOTION 4.8). */
export function goToMark(docId: number, mark: RedactMark): void {
  useRedact.getState().select(docId, mark.id);
  jumpToHit(docId, { index: -1, page: mark.pageId, quads: mark.quads });
}
