import { Fragment, useLayoutEffect, useRef, type KeyboardEvent, type ReactNode, type Ref } from 'react';

import { useT } from '../../i18n';
import { isOwnEvent, itemsOf, rovingTarget } from '../../components/roving';
import { applyChange, changeKind, deleteSelection, openComment } from './actions';
import {
  ColourControl,
  CommentControl,
  DeleteControl,
  Divider,
  FillControl,
  FontSizeControl,
  KindControl,
  MARK_KINDS,
  MARKUP_KINDS,
  OpacityControl,
  StrokeControl,
} from './Controls';
import { controlsOf, valuesOf, type MiniObject } from './model';

const ITEMS = '[data-mb-item]';

/** The name of the selection's type for the toolbar label: one object's type, or the number of objects. */
export function useSelectionType(objects: readonly MiniObject[]): string {
  const t = useT();
  const [first] = objects;
  if (first === undefined) return '';
  if (objects.length > 1) return t('minibar.type.several', { n: objects.length });
  if (first.kind === 'textBox' || first.kind === 'image' || first.kind === 'redactMark') {
    return t(`minibar.type.${first.kind}`);
  }
  return t(first.kind === 'line' && first.head !== 'none' ? 'annot.type.arrow' : `annot.type.${first.kind}`);
}

export interface MiniBarProps {
  docId: number;
  objects: readonly MiniObject[];
  ref?: Ref<HTMLDivElement>;
  /** Esc: focus goes back to the selection. */
  onReturn: () => void;
}

/**
 * The properties mini bar (DESIGN v2 3.3): White, border, radius md, floating shadow, padding 4, height 40, gap 4. The controls the
 * whole selection has in common, then Löschen. A `toolbar` with one tab stop: Left, Right, Home and End move between controls;
 * Enter, Space and Down open a dropdown; Esc returns to the selection.
 */
export function MiniBar({ docId, objects, ref, onReturn }: MiniBarProps) {
  const t = useT();
  const type = useSelectionType(objects);
  const own = useRef<HTMLDivElement | null>(null);
  const stop = useRef<HTMLElement | null>(null);
  const controls = controlsOf(objects);
  const values = valuesOf(objects);
  const locked = objects.some((object) => object.locked);
  const [only] = objects;
  const change = (patch: Parameters<typeof applyChange>[2]) => void applyChange(docId, objects, patch);

  // One tab stop: the control focus was last on, else the first.
  useLayoutEffect(() => {
    const root = own.current;
    if (root === null) return;
    const items = itemsOf(root, ITEMS);
    const active = stop.current !== null && items.includes(stop.current) ? stop.current : items[0];
    for (const item of items) item.tabIndex = item === active ? 0 : -1;
  });

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    const root = event.currentTarget;
    // Events of a dropdown's menu bubble through the React tree: they are the menu's.
    if (!isOwnEvent(root, event) || event.defaultPrevented) return;
    if (event.key === 'Escape') {
      event.preventDefault();
      event.stopPropagation();
      onReturn();
      return;
    }
    if (event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return;
    const items = itemsOf(root, ITEMS);
    const current = items.findIndex((item) => item.contains(event.target as Node));
    const target = rovingTarget(event.key, current, items.length, { orientation: 'horizontal', wrap: false });
    if (target === null) return;
    event.preventDefault();
    items[target]?.focus();
  };

  const nodes: ReactNode[] = [];
  const add = (key: string, node: ReactNode) => nodes.push(<Fragment key={key}>{node}</Fragment>);
  for (const control of controls) {
    switch (control) {
      case 'colourHighlight':
      case 'colourStroke':
        add(
          control,
          <ColourControl
            palette={control === 'colourHighlight' ? 'highlight' : 'stroke'}
            value={values.color}
            disabled={locked}
            onChange={(color) => change({ color })}
          />,
        );
        break;
      case 'kindMarkup':
      case 'kindMark':
        add(
          control,
          <KindControl
            label={t(control === 'kindMarkup' ? 'minibar.kindMarkup' : 'minibar.kindMark')}
            options={control === 'kindMarkup' ? MARKUP_KINDS : MARK_KINDS}
            value={values.kind}
            disabled={locked}
            onChange={(kind) => void changeKind(docId, objects, kind)}
          />,
        );
        break;
      case 'strokeWidth':
        add(control, <StrokeControl value={values.width} disabled={locked} onChange={(width) => change({ width })} />);
        break;
      case 'opacity':
        add(
          control,
          <OpacityControl value={values.opacity} disabled={locked} onChange={(opacity) => change({ opacity })} />,
        );
        break;
      case 'fill':
        add(control, <FillControl value={values.fill} disabled={locked} onChange={(fill) => change({ fill })} />);
        break;
      case 'fontSize':
        add(
          control,
          <FontSizeControl value={values.fontSize} disabled={locked} onChange={(fontSize) => change({ fontSize })} />,
        );
        break;
      case 'comment':
        add(
          control,
          <CommentControl
            label={t(only?.kind === 'note' ? 'minibar.openComment' : 'minibar.comment')}
            onOpen={() => {
              if (only !== undefined) openComment(docId, only);
            }}
          />,
        );
        break;
    }
  }

  return (
    <div
      ref={(node) => {
        own.current = node;
        if (typeof ref === 'function') ref(node);
        else if (ref !== undefined && ref !== null) ref.current = node;
      }}
      role="toolbar"
      aria-orientation="horizontal"
      aria-label={t('minibar.label', { type })}
      data-minibar=""
      onKeyDown={onKeyDown}
      onFocus={(event) => {
        const item = event.target instanceof Element ? event.target.closest<HTMLElement>(ITEMS) : null;
        if (item !== null) stop.current = item;
      }}
      className="pointer-events-auto flex h-control-lg items-center gap-1 rounded-md border border-border-subtle bg-surface-solid p-1 shadow-floating"
    >
      {nodes.flatMap((node, index) => (index === 0 ? [node] : [<Divider key={`d${index}`} />, node]))}
      {nodes.length > 0 && <Divider />}
      <DeleteControl
        label={t('minibar.delete')}
        disabled={locked}
        onDelete={() => void deleteSelection(docId, objects)}
      />
    </div>
  );
}
