import { useEffect, useMemo } from 'react';

import { listDocumentAnnotations, type AnnotationPatch, type DocCommand } from '../../api/annotations';
import { TAGS_MAX, TAGS_PER_ANNOT, TAG_NAME_MAX, TAG_PALETTE, type TagDef } from '../../api/cite';
import type { Rgb } from '../../api/annotations';
import { toAppError } from '../../api/errors';
import { translators } from '../../i18n';
import { useLocaleStore } from '../../i18n/store';
import { useAnnotations } from '../../stores/annotations';
import { useDocuments } from '../../stores/documents';
import { useSettings } from '../../stores/settings';
import { useUi } from '../../stores/ui';
import { useComments } from '../comments/store';

/**
 * The tag definitions (DESIGN 3.7 C6, ADR-119 item 9): global, kept in the settings and validated again in Rust. Names, not ids, travel in the
 * file (`AnnotationPatch.tags`), so a rename or a delete here also rewrites the assignments of the open documents (see `retagOpenDocuments`).
 */

const NONE: TagDef[] = [];

/** The coalesce-free step label of a tag rewrite across annotations (a catalog key). */
const STEP_LABEL = 'tags.assign';

/** The tag definitions in order. */
export function useTags(): TagDef[] {
  return (useSettings((state) => state.tags) as TagDef[] | undefined) ?? NONE;
}

/** The definitions now, for code outside React. */
export function currentTags(): TagDef[] {
  return (useSettings.getState().tags as TagDef[] | undefined) ?? NONE;
}

export type TagProblem = 'empty' | 'long' | 'control' | 'duplicate' | 'limit' | 'rejected';
export type TagResult = { ok: true; name: string } | { ok: false; problem: TagProblem };

const sameName = (a: string, b: string): boolean => a.toLowerCase() === b.toLowerCase();
const sameColor = (a: Rgb, b: Rgb): boolean => a[0] === b[0] && a[1] === b[1] && a[2] === b[2];
const lengthOf = (text: string): number => [...text].length;

/** The colour of the definition called `name` (ignoring case), or `null` when there is none (it shows neutral). */
export function tagColor(tags: readonly TagDef[], name: string): Rgb | null {
  return tags.find((tag) => sameName(tag.name, name))?.color ?? null;
}

/** The next palette colour in order for a new tag. */
export function nextTagColor(tags: readonly TagDef[]): Rgb {
  return TAG_PALETTE[tags.length % TAG_PALETTE.length] as Rgb;
}

/**
 * Why `raw` is not a name for a tag (the checks of the Rust side: 1 to 40 characters, no control characters, unique ignoring case), or `null`.
 * `except` is the name of the tag that is being renamed.
 */
export function tagNameProblem(raw: string, tags: readonly TagDef[], except?: string): TagProblem | null {
  const name = raw.trim();
  if (name === '') return 'empty';
  if (lengthOf(name) > TAG_NAME_MAX) return 'long';
  // eslint-disable-next-line no-control-regex -- the point is to refuse control characters
  if (/[\u0000-\u001f\u007f-\u009f]/u.test(name)) return 'control';
  if (tags.some((tag) => sameName(tag.name, name) && !(except !== undefined && sameName(tag.name, except))))
    return 'duplicate';
  return null;
}

/** Writes the list through `update_settings` and says whether the backend kept it (the store then holds exactly `next`). */
async function persist(next: readonly TagDef[]): Promise<boolean> {
  await useSettings.getState().update({ tags: next });
  const stored = currentTags();
  return (
    stored.length === next.length &&
    stored.every((tag, i) => tag.name === next[i]?.name && sameColor(tag.color, next[i]?.color as Rgb))
  );
}

/** Makes a tag; the colour is the next palette colour unless given. */
export async function createTag(name: string, color?: Rgb): Promise<TagResult> {
  const tags = currentTags();
  const trimmed = name.trim();
  if (tags.length >= TAGS_MAX) return { ok: false, problem: 'limit' };
  const problem = tagNameProblem(trimmed, tags);
  if (problem !== null) return { ok: false, problem };
  const kept = await persist([...tags, { name: trimmed, color: color ?? nextTagColor(tags) }]);
  return kept ? { ok: true, name: trimmed } : { ok: false, problem: 'rejected' };
}

/** Changes the colour of a tag. */
export async function recolorTag(name: string, color: Rgb): Promise<TagResult> {
  const tags = currentTags();
  if (!tags.some((tag) => tag.name === name)) return { ok: false, problem: 'rejected' };
  const kept = await persist(tags.map((tag) => (tag.name === name ? { ...tag, color } : tag)));
  return kept ? { ok: true, name } : { ok: false, problem: 'rejected' };
}

function report(caught: unknown): void {
  useUi.getState().showBanner(toAppError(caught));
}

/** The documents the rewrite covers: every open one except the welcome sample (read-only). */
function openDocumentIds(): number[] {
  const { order, byId } = useDocuments.getState();
  return order.filter((id) => byId[id] !== undefined && byId[id]?.kind !== 'welcome');
}

/** Annotations of `docId` that carry `name` (ignoring case), with their tag lists. */
async function carriers(docId: number, name: string): Promise<{ id: number; tags: readonly string[] }[]> {
  const summaries = await listDocumentAnnotations(docId);
  return summaries.flatMap((s) =>
    s.tags?.some((tag) => sameName(tag, name)) === true ? [{ id: s.id, tags: s.tags }] : [],
  );
}

/** One undo step that sets the tag lists of several annotations (a single command when there is one). */
async function applyTagLists(docId: number, lists: readonly { id: number; tags: readonly string[] }[]): Promise<void> {
  if (lists.length === 0) return;
  const commands: DocCommand[] = lists.map(({ id, tags }) => ({
    type: 'updateAnnotation',
    id,
    patch: { tags } satisfies AnnotationPatch,
  }));
  const command: DocCommand =
    commands.length === 1 ? (commands[0] as DocCommand) : { type: 'batch', label: STEP_LABEL, commands };
  try {
    await useAnnotations.getState().apply(docId, command);
  } catch (caught) {
    report(caught);
  }
}

/**
 * Rewrites the assignments of `from` in every open document (scope of the rename and the delete): `to` replaces it, `null` removes it. Returns
 * the annotations that carried it, per document, for an Undo.
 */
async function retagOpenDocuments(from: string, to: string | null): Promise<{ docId: number; ids: number[] }[]> {
  const touched: { docId: number; ids: number[] }[] = [];
  for (const docId of openDocumentIds()) {
    try {
      const found = await carriers(docId, from);
      if (found.length === 0) continue;
      const lists = found.map(({ id, tags }) => {
        const rest = tags.filter((tag) => !sameName(tag, from));
        const next = to === null || rest.some((tag) => sameName(tag, to)) ? rest : [...rest, to];
        return { id, tags: next.slice(0, TAGS_PER_ANNOT) };
      });
      await applyTagLists(docId, lists);
      touched.push({ docId, ids: found.map((item) => item.id) });
    } catch (caught) {
      report(caught);
    }
  }
  return touched;
}

/** Renames a tag and the assignments in the open documents. */
export async function renameTag(name: string, next: string): Promise<TagResult> {
  const tags = currentTags();
  const trimmed = next.trim();
  if (!tags.some((tag) => tag.name === name)) return { ok: false, problem: 'rejected' };
  const problem = tagNameProblem(trimmed, tags, name);
  if (problem !== null) return { ok: false, problem };
  if (trimmed === name) return { ok: true, name };
  const kept = await persist(tags.map((tag) => (tag.name === name ? { ...tag, name: trimmed } : tag)));
  if (!kept) return { ok: false, problem: 'rejected' };
  await retagOpenDocuments(name, trimmed);
  return { ok: true, name: trimmed };
}

/**
 * Deletes a tag and takes it off the annotations of the open documents. The toast offers Undo, which puts the definition back at its place and
 * the name back on the annotations that had it (those of documents that are still open).
 */
export async function deleteTag(name: string): Promise<boolean> {
  const tags = currentTags();
  const index = tags.findIndex((tag) => tag.name === name);
  const def = tags[index];
  if (def === undefined) return false;
  if (!(await persist(tags.filter((tag) => tag !== def)))) return false;
  const touched = await retagOpenDocuments(name, null);
  const t = translators[useLocaleStore.getState().locale];
  useUi.getState().showToast({
    message: t('tags.deleted', { name }),
    action: {
      label: t('action.undo'),
      run: () => {
        void (async () => {
          const now = currentTags();
          if (now.some((tag) => sameName(tag.name, name)) || now.length >= TAGS_MAX) return;
          const restored = [...now.slice(0, index), def, ...now.slice(index)];
          if (!(await persist(restored))) return;
          for (const { docId, ids } of touched) {
            if (useDocuments.getState().byId[docId] === undefined) continue;
            try {
              const wanted = new Set(ids);
              const lists = (await listDocumentAnnotations(docId))
                .filter((s) => wanted.has(s.id))
                .map((s) => ({ id: s.id, tags: [...(s.tags ?? []), name].slice(0, TAGS_PER_ANNOT) }));
              await applyTagLists(docId, lists);
            } catch (caught) {
              report(caught);
            }
          }
        })();
      },
    },
  });
  return true;
}

/**
 * How many annotations of `docId` carry each tag (keyed by the lower-case name), from the comments list of the document. The list is asked for
 * when it is not there yet. Without a document the counts are empty.
 */
export function useTagUsage(docId: number | undefined): ReadonlyMap<string, number> {
  const entry = useComments((state) => (docId === undefined ? undefined : state.byDoc[docId]));
  useEffect(() => {
    if (docId !== undefined && entry === undefined) useComments.getState().load(docId);
  }, [docId, entry]);
  const summaries = entry?.status === 'ready' ? entry.summaries : undefined;
  return useMemo(() => {
    const counts = new Map<string, number>();
    for (const s of summaries ?? []) {
      if (s.state !== undefined) continue;
      for (const tag of s.tags ?? []) counts.set(tag.toLowerCase(), (counts.get(tag.toLowerCase()) ?? 0) + 1);
    }
    return counts;
  }, [summaries]);
}
