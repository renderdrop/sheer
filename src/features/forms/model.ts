import type { FieldId, FieldValue, FormField, Rgb, Widget } from '../../api/forms';

/**
 * Pure helpers of the form UI (DESIGN 3.32): what a field is called, whether it is empty, the order Tab goes through the
 * fields in, and the font a control gets. Nothing here reads a store, so the tests need none.
 */

/** The kinds of field the overlay fills in; signatures, buttons and the unsupported are not shown as controls. */
export function isFillable(field: FormField): boolean {
  const { type } = field.kind;
  return type === 'text' || type === 'checkbox' || type === 'radio' || type === 'choice';
}

/** What a screen reader calls the field: its tooltip (`/TU`) when it has one, else its name. */
export function fieldLabel(field: Pick<FormField, 'tooltip' | 'name'>): string {
  const tip = field.tooltip?.trim() ?? '';
  return tip === '' ? field.name : tip;
}

/** Whether the field has nothing in it yet (Form jumps to the first one). */
export function isEmptyValue(value: FieldValue): boolean {
  switch (value.type) {
    case 'text':
      return value.text === '';
    case 'checked':
      return !value.on;
    case 'radio':
      return value.selected === null;
    case 'choice':
      return value.selected.length === 0 && (value.custom ?? '') === '';
  }
}

/** One widget of a field, with where it is among the field's widgets. */
export interface PlacedWidget {
  field: FormField;
  widget: Widget;
  index: number;
  /** Stable among the widgets of a document: the field and the widget's place in it. */
  key: string;
}

export const widgetKey = (field: FieldId, index: number): string => `${field}:${index}`;

/** The widgets of the fillable fields on a page, in the page's tab order. */
export function widgetsOn(fields: readonly FormField[], pageId: number): PlacedWidget[] {
  const placed: PlacedWidget[] = [];
  for (const field of fields) {
    if (!isFillable(field)) continue;
    field.widgets.forEach((widget, index) => {
      if (widget.pageId === pageId) placed.push({ field, widget, index, key: widgetKey(field.id, index) });
    });
  }
  return placed.sort((a, b) => a.widget.tabOrder - b.widget.tabOrder || a.index - b.index || a.field.id - b.field.id);
}

/** A place Tab stops at: one per field (a radio group is one stop, at its selected button). */
export interface Stop {
  field: FormField;
  key: string;
  pageId: number;
  /** The page's place in the document now. */
  position: number;
}

/**
 * The tab stops of a form in order: pages in document order, on a page by the widgets' tab order. A field with widgets on
 * several pages stops at its first widget. Read-only fields are not stops. `positionOf` is where a page sits (`null`: gone).
 */
export function tabStops(fields: readonly FormField[], positionOf: (pageId: number) => number | null): Stop[] {
  const stops: (Stop & { order: number; index: number })[] = [];
  for (const field of fields) {
    if (!isFillable(field) || field.readOnly || field.widgets.length === 0) continue;
    let chosen = 0;
    if (field.value.type === 'radio' && field.value.selected !== null) {
      const { selected } = field.value;
      chosen = Math.max(
        0,
        field.widgets.findIndex((widget) => widget.state === selected),
      );
    }
    const widget = field.widgets[chosen];
    if (widget === undefined) continue;
    const position = positionOf(widget.pageId);
    if (position === null) continue;
    stops.push({
      field,
      key: widgetKey(field.id, chosen),
      pageId: widget.pageId,
      position,
      order: widget.tabOrder,
      index: field.id,
    });
  }
  return stops
    .sort((a, b) => a.position - b.position || a.order - b.order || a.index - b.index)
    .map(({ field, key, pageId, position }) => ({ field, key, pageId, position }));
}

/** The stop after (or, with -1, before) the field's; `null` at the ends (Tab then leaves the canvas). */
export function neighbourStop(stops: readonly Stop[], field: FieldId, direction: 1 | -1): Stop | null {
  const at = stops.findIndex((stop) => stop.field.id === field);
  if (at < 0) return null;
  return stops[at + direction] ?? null;
}

/** The first stop whose field is empty; `null` when every field is filled in. */
export function firstEmptyStop(stops: readonly Stop[]): Stop | null {
  return stops.find((stop) => isEmptyValue(stop.field.value)) ?? null;
}

/** A colour of the file as CSS (the colour is the document's own, not a UI colour; `color()` takes 0 to 1 per channel). */
export function cssRgb(colour: Rgb): string {
  return `color(srgb ${colour[0] / 255} ${colour[1] / 255} ${colour[2] / 255})`;
}

/** The font size of a control in points: the field's own, or (automatic) one that fits the height; 12 for a multi-line field. */
export function fontSizePt(fontSize: number, height: number, multiline: boolean): number {
  if (fontSize > 0) return fontSize;
  if (multiline) return 12;
  return Math.min(24, Math.max(4, height * 0.72));
}

/** Rows of a list box are as high as its text with a little air. */
export const ROW_LEADING = 1.25;
/** Below this many px a list row is too small to hit: the list is a menu then (DESIGN 3.32). */
export const MIN_LIST_ROW_PX = 24;

/** Whether a list box shows inline: its rows reach `MIN_LIST_ROW_PX` at the current zoom. */
export function listIsInline(fontPt: number, pxPerPt: number): boolean {
  return fontPt * ROW_LEADING * pxPerPt >= MIN_LIST_ROW_PX;
}

/** The text a choice field shows closed: its selected labels, or what was typed. */
export function choiceText(
  options: readonly { export: string; label: string }[],
  value: Extract<FieldValue, { type: 'choice' }>,
): string {
  if (value.custom !== null && value.custom !== '') return value.custom;
  return value.selected.map((chosen) => options.find((option) => option.export === chosen)?.label ?? chosen).join(', ');
}
