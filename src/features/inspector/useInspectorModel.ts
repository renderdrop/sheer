import { useCallback, useMemo } from 'react';

import type { Annotation, AnnotationKind, Rgb } from '../../api/annotations';
import { toAppError } from '../../api/errors';
import { selectActiveId, useDocuments } from '../../stores/documents';
import { useAnnotations } from '../../stores/annotations';
import { creationKind, useTools, type CreationKind } from '../../stores/tools';
import { useUi } from '../../stores/ui';
import { recentColours } from './palette';
import {
  commandFor,
  sectionsOfSelection,
  sectionsOfTool,
  valuesOfSelection,
  valuesOfStyle,
  type Section,
  type SelectionValues,
} from './properties';
import { styleFor, useStyleStore, type AnnotationStyle } from './style';

export type InspectorModel =
  | { mode: 'empty' }
  | {
      mode: 'selection' | 'tool';
      sections: readonly Section[];
      values: SelectionValues;
      /** The colours of the file that are not in the palette (DESIGN 3.24 "Recent"). */
      recent: readonly Rgb[];
      /** False when the selection holds a locked annotation: the controls show but do nothing. */
      editable: boolean;
      /** What the header names: the type of one annotation, a number of items, or the tool. */
      subject:
        | { type: 'kind'; kind: AnnotationKind }
        | { type: 'items'; count: number }
        | { type: 'tool'; tool: CreationKind };
      /** Applies a change to the selection (one undo step) or, for tool options, to the style new annotations get. */
      change: (change: Partial<AnnotationStyle>) => Promise<void>;
    };

const NONE: readonly number[] = [];

/** What the inspector shows now: the selection of the active document, else the options of the active tool, else nothing. */
export function useInspectorModel(): InspectorModel {
  const docId = useDocuments(selectActiveId);
  const selectedIds = useAnnotations((state) => (docId === null ? undefined : state.selectedIds[docId])) ?? NONE;
  const byId = useAnnotations((state) => (docId === null ? undefined : state.byDoc[docId]?.byId));
  const activeTool = useUi((state) => state.activeTool);
  const markup = useTools((state) => state.markup);
  const shapes = useTools((state) => state.shapes);
  const overrides = useStyleStore((state) => state.overrides);

  const selection = useMemo<readonly Annotation[]>(
    () =>
      selectedIds.flatMap((id) => {
        const found = byId?.[id];
        return found === undefined ? [] : [found];
      }),
    [selectedIds, byId],
  );
  const recent = useMemo(() => recentColours(Object.values(byId ?? {})), [byId]);
  const tool = creationKind(activeTool, { markup, shapes });

  const changeSelection = useCallback(
    async (change: Partial<AnnotationStyle>) => {
      if (docId === null) return;
      const state = useAnnotations.getState();
      const current = (state.selectedIds[docId] ?? NONE).flatMap((id) => {
        const found = state.byDoc[docId]?.byId[id];
        return found === undefined || found.locked ? [] : [found];
      });
      const command = commandFor(current, change);
      if (command === null) return;
      try {
        await state.apply(docId, command);
      } catch (caught) {
        useUi.getState().showBanner(toAppError(caught));
      }
    },
    [docId],
  );

  const changeTool = useCallback(
    (change: Partial<AnnotationStyle>) => {
      if (tool !== null) useStyleStore.getState().set(tool, change);
      return Promise.resolve();
    },
    [tool],
  );

  return useMemo<InspectorModel>(() => {
    if (selection.length > 0) {
      const [first] = selection;
      return {
        mode: 'selection',
        sections: sectionsOfSelection(selection),
        values: valuesOfSelection(selection),
        recent,
        editable: selection.every((annotation) => !annotation.locked),
        subject:
          selection.length === 1 && first !== undefined
            ? { type: 'kind', kind: first.kind }
            : { type: 'items', count: selection.length },
        change: changeSelection,
      };
    }
    if (tool !== null) {
      return {
        mode: 'tool',
        sections: sectionsOfTool(tool),
        values: valuesOfStyle(styleFor(tool, overrides)),
        recent,
        editable: true,
        subject: { type: 'tool', tool },
        change: changeTool,
      };
    }
    return { mode: 'empty' };
  }, [selection, tool, overrides, recent, changeSelection, changeTool]);
}
