import { create } from 'zustand';

import { toAppError } from '../../api/errors';
import {
  getFormFields,
  setFieldValueCommand,
  type FieldId,
  type FieldState,
  type FieldValue,
  type FormField,
} from '../../api/forms';
import { useAnnotations } from '../../stores/annotations';
import { useUi } from '../../stores/ui';

/**
 * The UI's replica of each open document's form (ARCHITECTURE section 8; ADR-041). Rust owns the values; this store holds the fields
 * as `get_form_fields` described them and follows them with the `FieldState`s of every change set (a command, an undo, a redo), so
 * the overlay never guesses an outcome except the one it shows at once while a command is on its way (`commit`).
 */
export type FormStatus = 'loading' | 'ready' | 'none';

export interface DocForm {
  status: FormStatus;
  fields: readonly FormField[];
  /** The form has calculation or format scripts, which are never run (SECURITY). */
  hasScripts: boolean;
}

/** Where focus should go when the widget mounts: its page was not on screen. */
export interface FocusRequest {
  docId: number;
  key: string;
  at: number;
}

const HIGHLIGHT_KEY = 'sheer.formHighlight';

function loadHighlight(): boolean {
  try {
    return globalThis.localStorage.getItem(HIGHLIGHT_KEY) !== 'off';
  } catch {
    return true;
  }
}

function saveHighlight(on: boolean): void {
  try {
    globalThis.localStorage.setItem(HIGHLIGHT_KEY, on ? 'on' : 'off');
  } catch {
    // Storage unavailable: the choice lasts for the session.
  }
}

export interface FormsState {
  byDoc: Readonly<Record<number, DocForm>>;
  /** The subtle tint over fillable widgets (DESIGN 3.32, setting `formHighlight`, on by default). */
  highlight: boolean;
  /** Documents whose info banner was closed: it comes once per document and session (DESIGN 3.58). */
  bannerDismissed: Readonly<Record<number, true>>;
  focusRequest: FocusRequest | null;
  flattenOpen: boolean;

  setHighlight: (on: boolean) => void;
  dismissBanner: (docId: number) => void;
  requestFocus: (docId: number, key: string) => void;
  clearFocus: () => void;
  setFlattenOpen: (open: boolean) => void;
  /** Reads the form of a document once; later calls answer from the replica. A document without a (supported) form has `none`. */
  load: (docId: number) => Promise<void>;
  /** Applies the field states of a change set. */
  applyStates: (docId: number, states: readonly FieldState[]) => void;
  /** Sets a field's value: shown at once, then sent as one command; a refusal puts the old value back and shows the banner. */
  commit: (docId: number, field: FieldId, value: FieldValue, coalesce?: boolean) => Promise<void>;
  remove: (docId: number) => void;
}

/** The loads in flight, so two callers share one request. */
const loading = new Map<number, Promise<void>>();

function withValues(fields: readonly FormField[], states: readonly FieldState[]): readonly FormField[] {
  const byId = new Map(states.map((state) => [state.id, state]));
  let changed = false;
  const next = fields.map((field) => {
    const state = byId.get(field.id);
    if (state === undefined) return field;
    if (state.sync === field.sync && JSON.stringify(state.value) === JSON.stringify(field.value)) return field;
    changed = true;
    return { ...field, value: state.value, sync: state.sync };
  });
  return changed ? next : fields;
}

export const useForms = create<FormsState>()((set, get) => ({
  byDoc: {},
  highlight: loadHighlight(),
  bannerDismissed: {},
  focusRequest: null,
  flattenOpen: false,

  setHighlight: (highlight) => {
    set({ highlight });
    saveHighlight(highlight);
  },
  dismissBanner: (docId) => set((state) => ({ bannerDismissed: { ...state.bannerDismissed, [docId]: true } })),
  requestFocus: (docId, key) => set({ focusRequest: { docId, key, at: Date.now() } }),
  clearFocus: () => set((state) => (state.focusRequest === null ? state : { focusRequest: null })),
  setFlattenOpen: (flattenOpen) => set({ flattenOpen }),

  load: (docId) => {
    if (get().byDoc[docId] !== undefined) return Promise.resolve();
    const pending = loading.get(docId);
    if (pending !== undefined) return pending;
    set((state) => ({ byDoc: { ...state.byDoc, [docId]: { status: 'loading', fields: [], hasScripts: false } } }));
    const request = getFormFields(docId)
      .then(
        (info) => {
          set((state) => ({
            byDoc: {
              ...state.byDoc,
              [docId]: {
                status: info.fields.length > 0 ? 'ready' : 'none',
                fields: info.fields,
                hasScripts: info.hasScripts,
              },
            },
          }));
        },
        () => {
          // A full XFA form (the XFA banner explains it) or a failed read: no fields to fill in.
          set((state) => ({ byDoc: { ...state.byDoc, [docId]: { status: 'none', fields: [], hasScripts: false } } }));
        },
      )
      .finally(() => loading.delete(docId));
    loading.set(docId, request);
    return request;
  },

  applyStates: (docId, states) =>
    set((state) => {
      const form = state.byDoc[docId];
      if (form === undefined || states.length === 0) return state;
      const fields = withValues(form.fields, states);
      return fields === form.fields ? state : { byDoc: { ...state.byDoc, [docId]: { ...form, fields } } };
    }),

  commit: async (docId, field, value, coalesce = true) => {
    const before = get().byDoc[docId]?.fields.find((candidate) => candidate.id === field);
    if (before === undefined) return;
    if (JSON.stringify(before.value) === JSON.stringify(value)) return;
    get().applyStates(docId, [{ id: field, value, sync: 'modified' }]);
    try {
      await useAnnotations.getState().apply(docId, setFieldValueCommand(field, value, coalesce));
    } catch (caught) {
      get().applyStates(docId, [{ id: field, value: before.value, sync: before.sync }]);
      useUi.getState().showBanner(toAppError(caught));
    }
  },

  remove: (docId) =>
    set((state) => {
      if (state.byDoc[docId] === undefined) return state;
      return { byDoc: Object.fromEntries(Object.entries(state.byDoc).filter(([id]) => Number(id) !== docId)) };
    }),
}));

/** Applies the field states a change set carried (`stores/annotations`). */
export function applyFieldStates(docId: number, states: readonly FieldState[]): void {
  useForms.getState().applyStates(docId, states);
}
