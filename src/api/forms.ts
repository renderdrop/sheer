import { call } from './call';
import { toAppError } from './errors';
import { isRecord, isUint, parseRect, type Rect } from './wire';

/**
 * The form of a document (ARCHITECTURE section 5, "Forms and signatures"; ADR-041; src-tauri/src/commands/forms.rs and
 * src-tauri/src/model/form.rs). Rust reads the AcroForm once and holds the values; the UI sees fields by `FieldId`, never object
 * numbers. A value changes only through the `setFieldValue` command (`applyCommand` in `./annotations`), which answers with the
 * `FieldState`s that changed (`ChangeSet.fields`). Every answer goes through a parser here; one that does not have the documented
 * shape is an internal error.
 */

/** Fields and widgets of one form, options of one choice field, on-states of one radio group (`MAX_FORM_FIELDS`, ...). */
export const MAX_FORM_FIELDS = 10_000;
export const MAX_FORM_WIDGETS = 20_000;
export const MAX_FIELD_OPTIONS = 1_000;
/** Longest text value and fully qualified name, in characters (`MAX_FIELD_TEXT_CHARS`, `MAX_FIELD_NAME_CHARS`). */
export const MAX_FIELD_TEXT_CHARS = 32_768;
export const MAX_FIELD_NAME_CHARS = 512;

export type FieldId = number;
export type Rgb = readonly [number, number, number];

/** What the user typed or chose (wire `{ type, ..fields }`). */
export type FieldValue =
  | { type: 'text'; text: string }
  | { type: 'checked'; on: boolean }
  /** `selected` is an index into the field's `states`. */
  | { type: 'radio'; selected: number | null }
  /** Export values; `custom` only for an editable combo box. */
  | { type: 'choice'; selected: readonly string[]; custom: string | null };

export interface ChoiceOption {
  export: string;
  label: string;
}

export type FieldKind =
  | {
      type: 'text';
      multiline: boolean;
      maxLen: number | null;
      comb: boolean;
      password: boolean;
      align: 'left' | 'center' | 'right';
      /** Points; 0 is automatic. */
      fontSize: number;
    }
  | { type: 'checkbox' }
  /** `states` are the on-state names, sanitized, for display only. */
  | { type: 'radio'; states: readonly string[]; noToggleOff: boolean }
  | { type: 'choice'; combo: boolean; editable: boolean; multiSelect: boolean; options: readonly ChoiceOption[] }
  | { type: 'signature' }
  | { type: 'button' }
  | { type: 'unsupported' };

/** Whether the file has the field's value (`clean`) or the session changed it (`modified`). */
export type FieldSync = 'clean' | 'modified';

export interface Widget {
  pageId: number;
  /** Page space (ADR-003). */
  rect: Rect;
  /** The position among the widgets of its page in the page's tab order. */
  tabOrder: number;
  /** Radio: the index into the field's `states` this widget stands for. */
  state: number | null;
  fill: Rgb | null;
  border: Rgb | null;
  textColor: Rgb;
}

export interface FormField {
  id: FieldId;
  /** Fully qualified. */
  name: string;
  tooltip: string | null;
  kind: FieldKind;
  readOnly: boolean;
  required: boolean;
  value: FieldValue;
  /** What Reset sets; `null` for a field that is not filled (signature, button, unsupported). */
  defaultValue: FieldValue | null;
  widgets: readonly Widget[];
  sync: FieldSync;
}

export type Xfa = 'none' | 'hybrid' | 'full';

export interface FormInfo {
  fields: readonly FormField[];
  /** The form has calculation, format or validation scripts, which Sheer never runs. */
  hasScripts: boolean;
  xfa: Xfa;
  needAppearances: boolean;
}

/** A field's value and whether it is saved, as a change set carries it. */
export interface FieldState {
  id: FieldId;
  value: FieldValue;
  sync: FieldSync;
}

/** The form member of `DocCommand`. Edits of one field with the same `coalesce` key within 1.5 s are one undo step. */
export interface SetFieldValueCommand {
  type: 'setFieldValue';
  field: FieldId;
  value: FieldValue;
  coalesce?: string;
}

/** The command that sets a field, coalescing the edits of one field into one undo step (`field:<id>`). */
export function setFieldValueCommand(field: FieldId, value: FieldValue, coalesce = true): SetFieldValueCommand {
  return coalesce
    ? { type: 'setFieldValue', field, value, coalesce: `field:${field}` }
    : { type: 'setFieldValue', field, value };
}

// --- Parsers ---------------------------------------------------------------------------------------------------------

const ALIGNS: ReadonlySet<unknown> = new Set(['left', 'center', 'right']);
const SYNCS: ReadonlySet<unknown> = new Set<FieldSync>(['clean', 'modified']);
const XFAS: ReadonlySet<unknown> = new Set<Xfa>(['none', 'hybrid', 'full']);

/** A string no longer than `max` characters (a UTF-16 string is at most twice as long in units). */
function isText(value: unknown, max: number): value is string {
  return typeof value === 'string' && value.length <= 2 * max;
}

function parseRgb(value: unknown): Rgb | null {
  if (!Array.isArray(value) || value.length !== 3) return null;
  const [r, g, b] = value as unknown[];
  return isUint(r, 255) && isUint(g, 255) && isUint(b, 255) ? [r, g, b] : null;
}

function parseStrings(value: unknown, maxItems: number, maxChars: number): string[] | null {
  if (!Array.isArray(value) || value.length > maxItems) return null;
  return (value as unknown[]).every((item) => isText(item, maxChars)) ? (value as string[]) : null;
}

/** Validates a field value; `null` if it is not one. Extra keys are dropped. */
export function parseFieldValue(value: unknown): FieldValue | null {
  if (!isRecord(value)) return null;
  switch (value.type) {
    case 'text':
      return isText(value.text, MAX_FIELD_TEXT_CHARS) ? { type: 'text', text: value.text } : null;
    case 'checked':
      return typeof value.on === 'boolean' ? { type: 'checked', on: value.on } : null;
    case 'radio':
      return value.selected === null || isUint(value.selected, MAX_FIELD_OPTIONS)
        ? { type: 'radio', selected: value.selected }
        : null;
    case 'choice': {
      const selected = parseStrings(value.selected, MAX_FIELD_OPTIONS, MAX_FIELD_NAME_CHARS);
      const { custom } = value;
      if (selected === null || !(custom === null || isText(custom, MAX_FIELD_TEXT_CHARS))) return null;
      return { type: 'choice', selected, custom };
    }
    default:
      return null;
  }
}

function parseOption(value: unknown): ChoiceOption | null {
  if (!isRecord(value)) return null;
  return isText(value.export, MAX_FIELD_NAME_CHARS) && isText(value.label, MAX_FIELD_NAME_CHARS)
    ? { export: value.export, label: value.label }
    : null;
}

/** Validates a field kind; `null` if it is not one. Extra keys are dropped. */
export function parseFieldKind(value: unknown): FieldKind | null {
  if (!isRecord(value)) return null;
  switch (value.type) {
    case 'text': {
      const { multiline, maxLen, comb, password, align, fontSize } = value;
      if (
        typeof multiline !== 'boolean' ||
        !(maxLen === null || isUint(maxLen, MAX_FIELD_TEXT_CHARS)) ||
        typeof comb !== 'boolean' ||
        typeof password !== 'boolean' ||
        !ALIGNS.has(align) ||
        typeof fontSize !== 'number' ||
        !Number.isFinite(fontSize) ||
        fontSize < 0 ||
        fontSize > 1000
      )
        return null;
      return { type: 'text', multiline, maxLen, comb, password, align: align as 'left' | 'center' | 'right', fontSize };
    }
    case 'checkbox':
    case 'signature':
    case 'button':
    case 'unsupported':
      return { type: value.type };
    case 'radio': {
      const states = parseStrings(value.states, MAX_FIELD_OPTIONS, MAX_FIELD_NAME_CHARS);
      return states !== null && typeof value.noToggleOff === 'boolean'
        ? { type: 'radio', states, noToggleOff: value.noToggleOff }
        : null;
    }
    case 'choice': {
      const { combo, editable, multiSelect, options } = value;
      if (
        typeof combo !== 'boolean' ||
        typeof editable !== 'boolean' ||
        typeof multiSelect !== 'boolean' ||
        !Array.isArray(options) ||
        options.length > MAX_FIELD_OPTIONS
      )
        return null;
      const parsed: ChoiceOption[] = [];
      for (const item of options as unknown[]) {
        const option = parseOption(item);
        if (option === null) return null;
        parsed.push(option);
      }
      return { type: 'choice', combo, editable, multiSelect, options: parsed };
    }
    default:
      return null;
  }
}

function parseWidget(value: unknown): Widget | null {
  if (!isRecord(value)) return null;
  const rect = parseRect(value.rect);
  const fill = value.fill === null ? null : parseRgb(value.fill);
  const border = value.border === null ? null : parseRgb(value.border);
  const textColor = parseRgb(value.textColor);
  const { pageId, tabOrder, state } = value;
  if (
    rect === null ||
    (value.fill !== null && fill === null) ||
    (value.border !== null && border === null) ||
    textColor === null ||
    !isUint(pageId) ||
    !isUint(tabOrder) ||
    !(state === null || isUint(state, MAX_FIELD_OPTIONS))
  )
    return null;
  return { pageId, rect, tabOrder, state, fill, border, textColor };
}

/** Whether a value is a value this kind of field holds. */
function fits(kind: FieldKind, value: FieldValue): boolean {
  switch (kind.type) {
    case 'text':
      return value.type === 'text';
    case 'checkbox':
      return value.type === 'checked';
    case 'radio':
      return value.type === 'radio';
    case 'choice':
      return value.type === 'choice';
    default:
      return true;
  }
}

/** Validates one field; `null` if it is not one. */
export function parseFormField(value: unknown): FormField | null {
  if (!isRecord(value)) return null;
  const kind = parseFieldKind(value.kind);
  const fieldValue = parseFieldValue(value.value);
  const defaultValue = value.defaultValue === null ? null : parseFieldValue(value.defaultValue);
  const { id, name, tooltip, readOnly, required, sync, widgets } = value;
  if (
    kind === null ||
    fieldValue === null ||
    (value.defaultValue !== null && defaultValue === null) ||
    !isUint(id) ||
    !isText(name, MAX_FIELD_NAME_CHARS) ||
    !(tooltip === null || isText(tooltip, MAX_FIELD_NAME_CHARS)) ||
    typeof readOnly !== 'boolean' ||
    typeof required !== 'boolean' ||
    !SYNCS.has(sync) ||
    !Array.isArray(widgets) ||
    widgets.length > MAX_FORM_WIDGETS ||
    !fits(kind, fieldValue) ||
    (defaultValue !== null && !fits(kind, defaultValue))
  )
    return null;
  const parsed: Widget[] = [];
  for (const item of widgets as unknown[]) {
    const widget = parseWidget(item);
    if (widget === null) return null;
    parsed.push(widget);
  }
  return {
    id,
    name,
    tooltip,
    kind,
    readOnly,
    required,
    value: fieldValue,
    defaultValue,
    widgets: parsed,
    sync: sync as FieldSync,
  };
}

/** Validates the answer of `get_form_fields`; `null` if it is not a form. A field id that repeats makes it one that is not. */
export function parseFormInfo(value: unknown): FormInfo | null {
  if (!isRecord(value)) return null;
  const { fields, hasScripts, xfa, needAppearances } = value;
  if (
    !Array.isArray(fields) ||
    fields.length > MAX_FORM_FIELDS ||
    typeof hasScripts !== 'boolean' ||
    !XFAS.has(xfa) ||
    typeof needAppearances !== 'boolean'
  )
    return null;
  const seen = new Set<number>();
  const parsed: FormField[] = [];
  let widgets = 0;
  for (const item of fields as unknown[]) {
    const field = parseFormField(item);
    widgets += field?.widgets.length ?? 0;
    if (field === null || seen.has(field.id) || widgets > MAX_FORM_WIDGETS) return null;
    seen.add(field.id);
    parsed.push(field);
  }
  return { fields: parsed, hasScripts, xfa: xfa as Xfa, needAppearances };
}

/** Validates the `fields` of a change set; `undefined` (a change set without any) is no field changed. `null` if it is not a list. */
export function parseFieldStates(value: unknown): FieldState[] | null {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > MAX_FORM_FIELDS) return null;
  const states: FieldState[] = [];
  for (const item of value as unknown[]) {
    if (!isRecord(item)) return null;
    const fieldValue = parseFieldValue(item.value);
    if (!isUint(item.id) || fieldValue === null || !SYNCS.has(item.sync)) return null;
    states.push({ id: item.id, value: fieldValue, sync: item.sync as FieldSync });
  }
  return states;
}

// --- Commands --------------------------------------------------------------------------------------------------------

/**
 * The form fields of a document. The first call makes the backend read them from the file; later calls answer from its model, with
 * the values of the session. A document without a form has no fields. Rejects with `unsupported_feature` (`xfa`) for a full XFA form
 * and `not_found` for a document that is not open.
 */
export async function getFormFields(docId: number): Promise<FormInfo> {
  const info = parseFormInfo(await call<unknown>('get_form_fields', { docId }));
  if (info === null) throw toAppError(null);
  return info;
}
