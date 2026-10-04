import { ChevronDown } from 'lucide-react';
import { useEffect, useRef, useState, type CSSProperties, type KeyboardEvent } from 'react';

import type { ChoiceOption, FieldValue, FormField, Widget } from '../../api/forms';
import { Menu, type MenuEntry } from '../../components';
import { useT } from '../../i18n';
import { controlOf } from './focus';
import { choiceText, fontSizePt, listIsInline, type PlacedWidget } from './model';
import { useForms } from './store';

/**
 * The controls of the form overlay (DESIGN 3.32): one per widget, exactly over its rectangle, in page space (the layer is scaled
 * by the page's zoom, so a size in points is a size in px here). A control holds what the user typed until it commits; a toggle or a
 * choice commits at once. Every commit is one command (`useForms.commit`), one undo step per field.
 */

type TextKind = Extract<FormField['kind'], { type: 'text' }>;
type ChoiceKind = Extract<FormField['kind'], { type: 'choice' }>;

interface BaseProps {
  docId: number;
  field: FormField;
  widget: Widget;
  /** The accessible name: the field's tooltip, else its name. */
  label: string;
  /** The widget is the field's tab stop (a radio group has one). */
  stop: boolean;
}

const commit = (docId: number, field: FormField, value: FieldValue, coalesce: boolean) =>
  void useForms.getState().commit(docId, field.id, value, coalesce);

// --- Read-only -------------------------------------------------------------------------------------------------------------

const MARK_PATH = 'M4 12.5l5 5L20 6.5';
const BULLET = '•';

function CheckMark() {
  return (
    <svg viewBox="0 0 24 24" width="100%" height="100%" aria-hidden="true" focusable="false">
      <path
        d={MARK_PATH}
        fill="none"
        stroke="currentColor"
        strokeWidth="3"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

function Dot() {
  return <span aria-hidden="true" data-form-dot="" className="absolute rounded-full bg-current" />;
}

/** A read-only field: the value as text with `aria-readonly`; it takes no focus and no input. */
export function ReadOnlyView({ field, widget, label }: Pick<BaseProps, 'field' | 'widget' | 'label'>) {
  const { kind, value } = field;
  const height = widget.rect.h;
  if (kind.type === 'checkbox' || kind.type === 'radio') {
    const on = value.type === 'checked' ? value.on : value.type === 'radio' && value.selected === widget.state;
    return (
      <div
        data-form-control=""
        role={kind.type}
        aria-label={label}
        aria-checked={on}
        aria-readonly="true"
        className="relative"
        data-form-round={kind.type === 'radio' ? '' : undefined}
      >
        {on && (kind.type === 'checkbox' ? <CheckMark /> : <Dot />)}
      </div>
    );
  }
  let text = '';
  if (value.type === 'text')
    text = kind.type === 'text' && kind.password ? BULLET.repeat(value.text.length) : value.text;
  else if (value.type === 'choice' && kind.type === 'choice') text = choiceText(kind.options, value);
  const multiline = kind.type === 'text' && kind.multiline;
  return (
    <div
      data-form-control=""
      role="textbox"
      aria-label={label}
      aria-readonly="true"
      aria-multiline={multiline || undefined}
      className={multiline ? 'whitespace-pre-wrap break-words' : 'flex items-center whitespace-nowrap'}
      style={{
        fontSize: fontSizePt(kind.type === 'text' ? kind.fontSize : 0, height, multiline),
        textAlign: kind.type === 'text' ? kind.align : undefined,
      }}
    >
      {text}
    </div>
  );
}

// --- Text ------------------------------------------------------------------------------------------------------------------

export function TextControl({ docId, field, widget, label, kind }: BaseProps & { kind: TextKind }) {
  const t = useT();
  const model = field.value.type === 'text' ? field.value.text : '';
  const [draft, setDraft] = useState<string | null>(null);
  const shown = draft ?? model;
  const latest = useRef({ draft, model });
  useEffect(() => {
    latest.current = { draft, model };
  });
  // A page that scrolls away while a field is being edited does not lose the text.
  useEffect(
    () => () => {
      const { draft: pending, model: saved } = latest.current;
      if (pending !== null && pending !== saved) commit(docId, field, { type: 'text', text: pending }, true);
    },
    [docId, field],
  );

  const save = () => {
    if (draft === null) return;
    setDraft(null);
    if (draft !== model) commit(docId, field, { type: 'text', text: draft }, true);
  };
  const onKeyDown = (event: KeyboardEvent<HTMLInputElement | HTMLTextAreaElement>) => {
    if (event.key === 'Enter' && !kind.multiline) {
      save();
    } else if (event.key === 'Escape' && draft !== null) {
      // Back to the stored value; the Escape is this field's, not the canvas's.
      event.stopPropagation();
      setDraft(null);
    }
  };

  const size = fontSizePt(kind.fontSize, widget.rect.h, kind.multiline);
  const maxLength = kind.maxLen !== null && kind.maxLen > 0 ? kind.maxLen : undefined;
  const comb = kind.comb && maxLength !== undefined && !kind.multiline;
  const style: CSSProperties = {
    fontSize: size,
    textAlign: comb ? 'left' : kind.align,
    ...(comb ? { fontFamily: 'monospace', letterSpacing: `calc(${widget.rect.w / (maxLength ?? 1)}px - 0.6em)` } : {}),
    ...(kind.multiline ? { lineHeight: 1.2, paddingTop: 1 } : {}),
  };
  const shared = {
    'data-form-control': '',
    'aria-label': label,
    'aria-required': field.required || undefined,
    'aria-description': maxLength === undefined ? undefined : t('form.maxLength', { n: maxLength }),
    title: field.required ? t('form.required') : undefined,
    maxLength,
    value: shown,
    tabIndex: 0,
    autoComplete: 'off',
    spellCheck: false,
    style,
    onChange: (event: { target: { value: string } }) => setDraft(event.target.value),
    onBlur: save,
    onKeyDown,
  };
  return kind.multiline ? (
    <textarea {...shared} aria-multiline="true" />
  ) : (
    <input {...shared} type={kind.password ? 'password' : 'text'} />
  );
}

// --- Checkbox and radio ----------------------------------------------------------------------------------------------------

export function CheckboxControl({ docId, field, label }: BaseProps) {
  const t = useT();
  const on = field.value.type === 'checked' && field.value.on;
  return (
    <button
      type="button"
      role="checkbox"
      data-form-control=""
      aria-checked={on}
      aria-label={label}
      aria-required={field.required || undefined}
      title={field.required ? t('form.required') : undefined}
      className="relative"
      onClick={() => commit(docId, field, { type: 'checked', on: !on }, false)}
    >
      {on && <CheckMark />}
    </button>
  );
}

/** -1, 1 or 0 for the arrow keys of a radio group (right and down go on). */
function arrowStep(key: string): -1 | 0 | 1 {
  if (key === 'ArrowDown' || key === 'ArrowRight') return 1;
  if (key === 'ArrowUp' || key === 'ArrowLeft') return -1;
  return 0;
}

export function RadioControl({
  docId,
  field,
  widget,
  label,
  stop,
  group,
}: BaseProps & { group: readonly PlacedWidget[] }) {
  const t = useT();
  const selected = field.value.type === 'radio' ? field.value.selected : null;
  const on = widget.state !== null && selected === widget.state;
  const noToggleOff = field.kind.type === 'radio' && field.kind.noToggleOff;
  const choose = (target: Widget) => {
    if (target.state === null) return;
    const next = selected === target.state && !noToggleOff ? null : target.state;
    commit(docId, field, { type: 'radio', selected: next }, false);
  };
  const onKeyDown = (event: KeyboardEvent<HTMLButtonElement>) => {
    const step = arrowStep(event.key);
    if (step === 0) return;
    event.preventDefault();
    const here = group.findIndex((placed) => placed.widget === widget);
    const next = group[(here + step + group.length) % group.length];
    if (next === undefined || next.widget.state === null) return;
    commit(docId, field, { type: 'radio', selected: next.widget.state }, false);
    controlOf(next.key)?.focus();
  };
  return (
    <button
      type="button"
      role="radio"
      data-form-control=""
      aria-checked={on}
      aria-label={label}
      aria-required={field.required || undefined}
      title={field.required ? t('form.required') : undefined}
      tabIndex={stop ? 0 : -1}
      className="relative"
      data-form-round=""
      onClick={() => choose(widget)}
      onKeyDown={onKeyDown}
    >
      {on && <Dot />}
    </button>
  );
}

// --- Choice ----------------------------------------------------------------------------------------------------------------

interface ChoiceProps extends BaseProps {
  kind: ChoiceKind;
  pxPerPt: number;
}

function choose(
  docId: number,
  field: FormField,
  kind: ChoiceKind,
  current: readonly string[],
  option: ChoiceOption,
): void {
  const has = current.includes(option.export);
  let selected: string[] = [option.export];
  if (kind.multiSelect)
    selected = has ? current.filter((value) => value !== option.export) : [...current, option.export];
  commit(docId, field, { type: 'choice', selected, custom: null }, false);
}

function listFont(height: number): number {
  return fontSizePt(0, height, true);
}

function InlineList({ docId, field, label, kind, widget }: ChoiceProps) {
  const t = useT();
  const selected = field.value.type === 'choice' ? field.value.selected : [];
  const [cursor, setCursor] = useState(() =>
    Math.max(
      0,
      kind.options.findIndex((o) => o.export === selected[0]),
    ),
  );
  const options = kind.options;
  const idOf = (index: number) => `form-${field.id}-${widget.tabOrder}-opt-${index}`;
  const move = (to: number) => {
    const next = Math.min(options.length - 1, Math.max(0, to));
    setCursor(next);
    const option = options[next];
    if (!kind.multiSelect && option !== undefined) choose(docId, field, kind, selected, option);
    document.getElementById(idOf(next))?.scrollIntoView({ block: 'nearest' });
  };
  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    switch (event.key) {
      case 'ArrowDown':
        event.preventDefault();
        move(cursor + 1);
        break;
      case 'ArrowUp':
        event.preventDefault();
        move(cursor - 1);
        break;
      case 'Home':
        event.preventDefault();
        move(0);
        break;
      case 'End':
        event.preventDefault();
        move(options.length - 1);
        break;
      case ' ':
      case 'Enter': {
        const option = options[cursor];
        if (option !== undefined && (kind.multiSelect || event.key === ' ')) {
          event.preventDefault();
          choose(docId, field, kind, selected, option);
        }
        break;
      }
    }
  };
  return (
    <div
      role="listbox"
      data-form-control=""
      data-form-list=""
      aria-label={label}
      aria-multiselectable={kind.multiSelect || undefined}
      aria-required={field.required || undefined}
      aria-description={field.required ? t('form.required') : undefined}
      aria-activedescendant={idOf(cursor)}
      tabIndex={0}
      style={{ fontSize: listFont(widget.rect.h), lineHeight: 1.25 }}
      onKeyDown={onKeyDown}
    >
      {options.map((option, index) => (
        <div
          key={`${option.export}-${index}`}
          id={idOf(index)}
          role="option"
          data-form-option=""
          aria-selected={selected.includes(option.export)}
          onClick={() => {
            setCursor(index);
            choose(docId, field, kind, selected, option);
          }}
        >
          {option.label}
        </div>
      ))}
    </div>
  );
}

function ChoiceMenu({ docId, field, label, kind, widget }: ChoiceProps) {
  const t = useT();
  const value = field.value.type === 'choice' ? field.value : { type: 'choice' as const, selected: [], custom: null };
  const text = choiceText(kind.options, value);
  const entries: MenuEntry[] = kind.options.map((option, index) => ({
    id: `${index}`,
    label: option.label,
    checked: value.selected.includes(option.export),
    onSelect: () => choose(docId, field, kind, value.selected, option),
  }));
  const size = fontSizePt(0, widget.rect.h, false);
  const [typed, setTyped] = useState<string | null>(null);
  const save = () => {
    if (typed === null) return;
    setTyped(null);
    const match = kind.options.find((option) => option.label === typed);
    const next: FieldValue =
      match !== undefined
        ? { type: 'choice', selected: [match.export], custom: null }
        : { type: 'choice', selected: [], custom: typed };
    commit(docId, field, next, true);
  };
  const chevron = <ChevronDown aria-hidden="true" width="1em" height="1em" className="shrink-0" strokeWidth={2} />;
  return (
    <div className="flex h-full w-full" style={{ fontSize: size }}>
      {kind.editable && (
        <input
          type="text"
          data-form-control=""
          aria-label={label}
          aria-required={field.required || undefined}
          value={typed ?? text}
          tabIndex={0}
          autoComplete="off"
          spellCheck={false}
          style={{ fontSize: size, width: 'auto', flex: '1 1 auto', minWidth: 0 }}
          onChange={(event) => setTyped(event.target.value)}
          onBlur={save}
          onKeyDown={(event) => {
            if (event.key === 'Enter') save();
            else if (event.key === 'Escape' && typed !== null) {
              event.stopPropagation();
              setTyped(null);
            }
          }}
        />
      )}
      <Menu
        label={t('form.choices', { name: label })}
        side="bottom"
        align="start"
        entries={entries}
        trigger={(trigger) =>
          kind.editable ? (
            <button
              {...trigger}
              type="button"
              data-form-control=""
              aria-label={t('form.choices', { name: label })}
              tabIndex={-1}
              className="flex shrink-0 items-center justify-center"
              data-form-chevron=""
            >
              {chevron}
            </button>
          ) : (
            <button
              {...trigger}
              type="button"
              role="combobox"
              data-form-control=""
              aria-label={label}
              aria-required={field.required || undefined}
              aria-description={text === '' ? undefined : text}
              tabIndex={0}
              className="flex items-center justify-between gap-2 text-start"
              style={{ fontSize: size }}
            >
              <span className="min-w-0 flex-auto truncate">{text}</span>
              {chevron}
            </button>
          )
        }
      />
    </div>
  );
}

export function ChoiceControl(props: ChoiceProps) {
  const { kind, widget, pxPerPt } = props;
  const inline = !kind.combo && listIsInline(listFont(widget.rect.h), pxPerPt);
  return inline ? <InlineList {...props} /> : <ChoiceMenu {...props} />;
}
