import { memo, useEffect, useMemo, useRef, type CSSProperties, type KeyboardEvent } from 'react';

import type { FormField, Widget } from '../../api/forms';
import { useT } from '../../i18n';
import { selectActiveId, useDocuments } from '../../stores/documents';
import { useUi } from '../../stores/ui';
import { fileRotationOf } from '../viewer/fileRotation';
import { normalizeRotation, overlayBox, swapsSides, totalRotation, unrotatedSize } from '../viewer/transform';
import { CheckboxControl, ChoiceControl, RadioControl, ReadOnlyView, TextControl } from './controls';
import { FOCUS_REQUEST_TTL_MS, tabFrom } from './focus';
import { cssRgb, fieldLabel, widgetsOn, type PlacedWidget } from './model';
import { useForms } from './store';

export interface FormLayerProps {
  docId: number;
  /** The page's id (ADR-036). */
  pageIndex: number;
  /** The page's box as it is shown, in px (the view rotation applied). */
  boxWidth: number;
  boxHeight: number;
  /** The page as it is drawn, in points (the file's `/Rotate` applied, the view rotation not). */
  widthPt: number;
  heightPt: number;
  rotation: number;
  /** The page's own rotation is known; before that the layer would be misplaced by it. */
  ready: boolean;
}

const NONE: readonly FormField[] = [];
const NO_GROUP: readonly PlacedWidget[] = [];

interface WidgetProps {
  docId: number;
  placed: PlacedWidget;
  group: readonly PlacedWidget[];
  stop: boolean;
  readOnly: boolean;
  highlight: boolean;
  pxPerPt: number;
}

/** The colours of the file's own widget: its fill, its border and its text. */
function widgetStyle(widget: Widget): CSSProperties {
  const style: Record<string, string> = { '--form-text': cssRgb(widget.textColor) };
  if (widget.fill !== null) style['--form-fill'] = cssRgb(widget.fill);
  if (widget.border !== null)
    style['--form-border'] = `calc(var(--hairline) / var(--page-scale, 1)) solid ${cssRgb(widget.border)}`;
  return {
    left: widget.rect.x,
    top: widget.rect.y,
    width: widget.rect.w,
    height: widget.rect.h,
    ...style,
  } as CSSProperties;
}

/** One widget: its box over the page, and its control. It takes the focus when a Tab or the Form tool asked for it before it was mounted. */
const FormWidget = memo(function FormWidget({ docId, placed, group, stop, readOnly, highlight, pxPerPt }: WidgetProps) {
  const { field, widget, key } = placed;
  const ref = useRef<HTMLDivElement | null>(null);
  const requested = useForms((state) => state.focusRequest?.docId === docId && state.focusRequest.key === key);
  useEffect(() => {
    if (!requested) return;
    const request = useForms.getState().focusRequest;
    useForms.getState().clearFocus();
    if (request === null || Date.now() - request.at > FOCUS_REQUEST_TTL_MS) return;
    ref.current?.querySelector<HTMLElement>('[data-form-control]')?.focus();
  }, [requested]);

  const label = fieldLabel(field);
  const base = { docId, field, widget, label, stop };
  const { kind } = field;
  let control = null;
  if (readOnly) control = <ReadOnlyView field={field} widget={widget} label={label} />;
  else if (kind.type === 'text') control = <TextControl {...base} kind={kind} />;
  else if (kind.type === 'checkbox') control = <CheckboxControl {...base} />;
  else if (kind.type === 'radio') control = <RadioControl {...base} group={group} />;
  else if (kind.type === 'choice') control = <ChoiceControl {...base} kind={kind} pxPerPt={pxPerPt} />;
  return (
    <div
      ref={ref}
      data-form-widget={key}
      data-field={field.id}
      data-highlight={highlight && !readOnly ? 'on' : 'off'}
      data-required={field.required ? 'true' : undefined}
      data-readonly={readOnly ? 'true' : undefined}
      style={widgetStyle(widget)}
    >
      {control}
    </div>
  );
});

/**
 * The form overlay of one page (canvas layer 3, DESIGN 3.32): one control per widget of the page, in page space through the same
 * transform as the annotation layer, mounted after it so a field is above an annotation. Under Select and Form the controls take
 * input; under the other tools the layer is inert (the tool owns the pointer and the keys). Tab and Shift+Tab go through the form's
 * tab order, across pages (`tabFrom`); past the last field Tab leaves the canvas.
 */
export const FormLayer = memo(function FormLayer({
  docId,
  pageIndex,
  boxWidth,
  boxHeight,
  widthPt,
  heightPt,
  rotation: rotationProp,
  ready,
}: FormLayerProps) {
  const t = useT();
  const fields = useForms((state) => state.byDoc[docId]?.fields) ?? NONE;
  const highlight = useForms((state) => state.highlight);
  const tool = useUi((state) => state.activeTool);
  const documentReadOnly = useDocuments((state) => state.byId[docId]?.kind === 'welcome');
  const placed = useMemo(() => widgetsOn(fields, pageIndex), [fields, pageIndex]);
  const activeDocument = useDocuments(selectActiveId) === docId;

  const rotation = normalizeRotation(rotationProp);
  const file = fileRotationOf(docId, pageIndex);
  const page = useMemo(() => unrotatedSize([widthPt, heightPt], file), [widthPt, heightPt, file]);
  const total = totalRotation(file, rotation);
  const shownWidthPt = swapsSides(rotation) ? heightPt : widthPt;
  const pxPerPt = shownWidthPt > 0 ? boxWidth / shownWidthPt : 1;

  const groups = useMemo(() => {
    const byField = new Map<number, PlacedWidget[]>();
    for (const item of placed) byField.set(item.field.id, [...(byField.get(item.field.id) ?? []), item]);
    return byField;
  }, [placed]);

  if (!ready || placed.length === 0 || !activeDocument) return null;
  const active = tool === 'select' || tool === 'form' || tool === 'signature';
  const box = overlayBox(boxWidth, boxHeight, page, pxPerPt, total);
  const style = { ...box, transformOrigin: 'center', '--page-scale': pxPerPt } as CSSProperties;

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key !== 'Tab' || event.defaultPrevented || event.ctrlKey || event.altKey || event.metaKey) return;
    const target = event.target instanceof Element ? event.target.closest('[data-form-widget]') : null;
    const fieldId = Number(target?.getAttribute('data-field'));
    if (target === null || !Number.isInteger(fieldId)) return;
    if (tabFrom(docId, fieldId, event.shiftKey ? -1 : 1)) event.preventDefault();
  };

  // A radio group is one group of its field's widgets on this page; its tab stop is the selected button, else the first.
  const stopKeyOf = (field: FormField, items: readonly PlacedWidget[]): string | undefined => {
    if (field.kind.type !== 'radio') return undefined;
    const selected = field.value.type === 'radio' ? field.value.selected : null;
    return (items.find((item) => selected !== null && item.widget.state === selected) ?? items[0])?.key;
  };

  const radios = [...groups.values()].filter((items) => items[0]?.field.kind.type === 'radio');
  const nonRadio = placed.filter((item) => item.field.kind.type !== 'radio');
  const render = (item: PlacedWidget, group: readonly PlacedWidget[]) => (
    <FormWidget
      key={item.key}
      docId={docId}
      placed={item}
      group={group}
      stop={item.field.kind.type !== 'radio' || stopKeyOf(item.field, group) === item.key}
      readOnly={item.field.readOnly || documentReadOnly}
      highlight={highlight}
      pxPerPt={pxPerPt}
    />
  );

  return (
    <div
      data-form-layer=""
      data-inert={active ? undefined : ''}
      inert={active ? undefined : true}
      className="pointer-events-none absolute inset-0 z-canvas-annotations"
      onKeyDown={onKeyDown}
    >
      <div role="group" aria-label={t('form.layer', { n: pageIndex + 1 })} className="absolute" style={style}>
        {nonRadio.map((item) => render(item, NO_GROUP))}
        {radios.map((items) => {
          const [first] = items;
          if (first === undefined) return null;
          return (
            <div
              key={`radio-${first.field.id}`}
              role="radiogroup"
              aria-label={fieldLabel(first.field)}
              className="contents"
            >
              {items.map((item) => render(item, items))}
            </div>
          );
        })}
      </div>
    </div>
  );
});
