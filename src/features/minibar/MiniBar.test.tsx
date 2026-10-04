// @vitest-environment jsdom
import { fireEvent, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import * as api from '../../api/annotations';
import type { Annotation, ChangeSet } from '../../api/annotations';
import { EMPTY_HISTORY, useAnnotations } from '../../stores/annotations';
import { useDocuments } from '../../stores/documents';
import { useTools } from '../../stores/tools';
import { setup } from '../../test/render';
import { DEFAULT_STYLES, useStyleStore } from '../inspector/style';
import { useMiniBarDock } from './dock';
import { MiniBarDock } from './MiniBarDock';
import { MiniBarSlot } from './MiniBarSlot';

vi.mock('../../api/annotations', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../api/annotations')>()),
  applyCommand: vi.fn(),
}));
const applyMock = vi.mocked(api.applyCommand);

const annotationsInitial = useAnnotations.getState();
const documentsInitial = useDocuments.getState();
const toolsInitial = useTools.getState();

function make(id: number, kind: string, extra: Record<string, unknown> = {}): Annotation {
  return {
    id,
    pageId: 0,
    rect: { x: 0, y: 0, w: 10, h: 10 },
    color: [15, 15, 15],
    opacity: 1,
    contents: '',
    author: null,
    modified: null,
    inReplyTo: null,
    locked: false,
    sync: 'new',
    kind,
    ...extra,
  } as unknown as Annotation;
}
const ink = (id: number) => make(id, 'ink', { strokes: [], width: 2 });

function load(annotations: Annotation[], selected: number[]) {
  useDocuments.setState({
    ...documentsInitial,
    byId: { 1: { id: 1, pageCount: 1, displayName: 'a.pdf' } },
    order: [1],
    activeId: 1,
  });
  useAnnotations.setState({
    byDoc: {
      1: {
        rev: 1,
        byId: Object.fromEntries(annotations.map((a) => [a.id, a])),
        loaded: { 0: true },
        removed: {},
        history: EMPTY_HISTORY,
      },
    },
    selectedIds: { 1: selected },
  });
}

const changes = (upserted: Annotation[] = []): ChangeSet => ({
  rev: 2,
  upserted,
  removed: [],
  pages: null,
  history: { ...EMPTY_HISTORY, canUndo: true, undoLabel: 'annotation.update', dirty: true },
});

interface Rect {
  left: number;
  top: number;
  width: number;
  height: number;
}
const rectOf = ({ left, top, width, height }: Rect): DOMRect =>
  ({
    left,
    top,
    width,
    height,
    right: left + width,
    bottom: top + height,
    x: left,
    y: top,
    toJSON: () => ({}),
  }) as DOMRect;

/** The canvas (100 to 700 high) and the frames of the selected annotations, as the layers draw them. */
function canvas(frames: Record<number, Rect>) {
  const scope = document.createElement('div');
  scope.dataset.actionScope = 'canvas';
  const region = document.createElement('div');
  region.setAttribute('role', 'region');
  scope.append(region);
  document.body.append(scope);
  const elements: Record<string, Rect> = {};
  for (const [id, rect] of Object.entries(frames)) {
    const frame = document.createElement('div');
    frame.setAttribute('role', 'button');
    frame.tabIndex = 0;
    frame.dataset.annotFrame = id;
    scope.append(frame);
    elements[id] = rect;
  }
  const spy = vi.spyOn(Element.prototype, 'getBoundingClientRect').mockImplementation(function (this: Element) {
    if (this === region) return rectOf({ left: 0, top: 100, width: 1000, height: 600 });
    if (this.matches('[data-minibar]')) return rectOf({ left: 0, top: 0, width: 300, height: 40 });
    const id = (this as HTMLElement).dataset.annotFrame;
    const rect = id === undefined ? undefined : elements[id];
    return rect === undefined ? rectOf({ left: 0, top: 0, width: 0, height: 0 }) : rectOf(rect);
  });
  const frame = (id: number): HTMLElement => {
    const found = scope.querySelector<HTMLElement>(`[data-annot-frame="${id}"]`);
    if (found === null) throw new Error(`no frame ${id}`);
    return found;
  };
  return { scope, spy, frame };
}

let scene: ReturnType<typeof canvas> | null = null;
const OVER = { left: 400, top: 300, width: 200, height: 100 };

beforeEach(() => {
  useAnnotations.setState({ ...annotationsInitial }, true);
  useDocuments.setState({ ...documentsInitial }, true);
  useTools.setState({ ...toolsInitial, defaults: {} }, true);
  useStyleStore.getState().reset();
  useMiniBarDock.setState({ docked: false });
  applyMock.mockReset();
  applyMock.mockResolvedValue(changes());
});
afterEach(() => {
  scene?.spy.mockRestore();
  scene?.scope.remove();
  scene = null;
});

const bar = () => screen.queryByRole('toolbar');
const motionOf = () => document.querySelector('[data-minibar-motion]');

describe('visibility', () => {
  it('shows nothing without a selection', () => {
    load([ink(1)], []);
    scene = canvas({ 1: OVER });
    setup(<MiniBarSlot />);
    expect(bar()).toBeNull();
  });

  it('shows for a selected canvas object, named by its type', () => {
    load([ink(1)], [1]);
    scene = canvas({ 1: OVER });
    setup(<MiniBarSlot />);
    expect(screen.getByRole('toolbar', { name: 'Properties: Drawing' })).not.toBeNull();
    expect(motionOf()?.hasAttribute('inert')).toBe(false);
  });

  it('names several objects by their number', () => {
    load([ink(1), ink(2)], [1, 2]);
    scene = canvas({ 1: OVER, 2: OVER });
    setup(<MiniBarSlot />);
    expect(screen.getByRole('toolbar', { name: 'Properties: 2 items' })).not.toBeNull();
  });

  it('is not there for an annotation the app does not edit', () => {
    load([make(1, 'opaque', { subtype: 'Widget' })], [1]);
    scene = canvas({ 1: OVER });
    setup(<MiniBarSlot />);
    expect(bar()).toBeNull();
  });

  it('is hidden while the pointer is down on the canvas and back 120 ms after release', async () => {
    load([ink(1)], [1]);
    scene = canvas({ 1: OVER });
    setup(<MiniBarSlot />);
    fireEvent.pointerDown(scene.frame(1));
    await waitFor(() => expect(motionOf()?.hasAttribute('inert')).toBe(true));
    fireEvent.pointerUp(scene.frame(1));
    expect(motionOf()?.hasAttribute('inert')).toBe(true);
    await waitFor(() => expect(motionOf()?.hasAttribute('inert')).toBe(false), { timeout: 1000 });
  });
});

describe('placement', () => {
  const left = (): number => Number.parseFloat((motionOf() as HTMLElement).style.left);
  const top = (): number => Number.parseFloat((motionOf() as HTMLElement).style.top);

  it('floats centred above the selection', () => {
    load([ink(1)], [1]);
    scene = canvas({ 1: OVER });
    setup(<MiniBarSlot />);
    expect([left(), top()]).toEqual([350, 252]);
  });

  it('goes below when the selection is at the top of the canvas', () => {
    load([ink(1)], [1]);
    scene = canvas({ 1: { left: 400, top: 120, width: 200, height: 100 } });
    setup(<MiniBarSlot />);
    expect(top()).toBe(228);
  });

  it('docks in the banner slot second row when neither side has room', () => {
    load([ink(1)], [1]);
    scene = canvas({ 1: { left: 400, top: 120, width: 200, height: 570 } });
    setup(
      <>
        <MiniBarDock />
        <MiniBarSlot />
      </>,
    );
    expect(useMiniBarDock.getState().docked).toBe(true);
    const dock = document.querySelector('[data-minibar-dock]');
    expect(dock?.contains(screen.getByRole('toolbar'))).toBe(true);
  });
});

describe('controls', () => {
  it('has swatches, line width, opacity and Löschen last for a drawing', () => {
    load([ink(1)], [1]);
    scene = canvas({ 1: OVER });
    setup(<MiniBarSlot />);
    expect(screen.getAllByRole('radio', { name: /^(Ink|Mint|Sky|Rose|Lavender)$/ })).toHaveLength(5);
    expect(screen.getByRole('button', { name: 'Line width' })).not.toBeNull();
    expect(screen.getByRole('button', { name: 'Opacity' })).not.toBeNull();
    expect(screen.queryByRole('button', { name: 'Fill' })).toBeNull();
    const buttons = screen.getAllByRole('button').filter((b) => b.closest('[data-minibar]') !== null);
    expect(buttons[buttons.length - 1]?.getAttribute('aria-label')).toBe('Delete');
  });

  it('has a markup kind control and a comment button for a highlight', () => {
    load([make(1, 'highlight', { quads: [], color: [255, 248, 77] })], [1]);
    scene = canvas({ 1: OVER });
    setup(<MiniBarSlot />);
    expect(screen.getByRole('radiogroup', { name: 'Markup kind' })).not.toBeNull();
    expect(screen.getByRole('radio', { name: 'Solar' }).getAttribute('aria-checked')).toBe('true');
    expect(screen.getByRole('button', { name: 'Comment' })).not.toBeNull();
  });

  it('has only Delete for a signature', () => {
    load([make(1, 'signature', { box: {}, role: 'signature', art: { type: 'file' } })], [1]);
    scene = canvas({ 1: OVER });
    setup(<MiniBarSlot />);
    const inside = screen.getAllByRole('button').filter((b) => b.closest('[data-minibar]') !== null);
    expect(inside.map((b) => b.getAttribute('aria-label'))).toEqual(['Delete']);
  });

  it('shows a dash for mixed values', () => {
    load([ink(1), make(2, 'ink', { strokes: [], width: 4 })], [1, 2]);
    scene = canvas({ 1: OVER, 2: OVER });
    setup(<MiniBarSlot />);
    expect(screen.getByRole('button', { name: 'Line width' }).textContent).toBe('–');
  });

  it('is a toolbar with arrow keys that move between controls and one tab stop', async () => {
    load([ink(1)], [1]);
    scene = canvas({ 1: OVER });
    const { user } = setup(<MiniBarSlot />);
    const items = Array.from(document.querySelectorAll<HTMLElement>('[data-mb-item]'));
    expect(items.filter((i) => i.tabIndex === 0)).toHaveLength(1);
    items[0]?.focus();
    await user.keyboard('{ArrowRight}');
    expect(document.activeElement).toBe(items[1]);
    await user.keyboard('{End}');
    expect(document.activeElement).toBe(items[items.length - 1]);
    await user.keyboard('{Home}');
    expect(document.activeElement).toBe(items[0]);
  });
});

describe('changes', () => {
  it('apply as one command and become the default of the kind', async () => {
    load([ink(1)], [1]);
    scene = canvas({ 1: OVER });
    const { user } = setup(<MiniBarSlot />);
    await user.click(screen.getByRole('radio', { name: 'Rose' }));
    expect(applyMock).toHaveBeenCalledTimes(1);
    expect(applyMock).toHaveBeenCalledWith(1, { type: 'updateAnnotation', id: 1, patch: { color: [225, 92, 134] } });
    await waitFor(() => expect(useTools.getState().defaults.ink?.color).toEqual([225, 92, 134]));
    expect(useStyleStore.getState().overrides.ink?.color).toEqual([225, 92, 134]);
  });

  it('are one undo step for several objects (one batch)', async () => {
    load([ink(1), ink(2)], [1, 2]);
    scene = canvas({ 1: OVER, 2: OVER });
    const { user } = setup(<MiniBarSlot />);
    await user.click(screen.getByRole('radio', { name: 'Sky' }));
    expect(applyMock).toHaveBeenCalledTimes(1);
    expect(applyMock.mock.calls[0]?.[1]).toMatchObject({ type: 'batch', commands: [{ id: 1 }, { id: 2 }] });
  });

  it('set the width through the dropdown', async () => {
    load([ink(1)], [1]);
    scene = canvas({ 1: OVER });
    const { user } = setup(<MiniBarSlot />);
    await user.click(screen.getByRole('button', { name: 'Line width' }));
    await user.click(await screen.findByRole('menuitemcheckbox', { name: '4 pt' }));
    expect(applyMock).toHaveBeenCalledWith(1, { type: 'updateAnnotation', id: 1, patch: { width: 4 } });
    await waitFor(() => expect(useTools.getState().defaults.ink?.width).toBe(4));
  });

  it('turn a highlight into an underline in one batch', async () => {
    load([make(1, 'highlight', { quads: [], color: [255, 248, 77] })], [1]);
    scene = canvas({ 1: OVER });
    const { user } = setup(<MiniBarSlot />);
    await user.click(screen.getByRole('radio', { name: 'Underline' }));
    expect(applyMock.mock.calls[0]?.[1]).toMatchObject({
      type: 'batch',
      commands: [{ type: 'deleteAnnotations', ids: [1] }, { type: 'createAnnotation' }],
    });
  });

  it('delete the selection as one command', async () => {
    load([ink(1), ink(2)], [1, 2]);
    scene = canvas({ 1: OVER, 2: OVER });
    const { user } = setup(<MiniBarSlot />);
    await user.click(screen.getByRole('button', { name: 'Delete' }));
    expect(applyMock).toHaveBeenCalledWith(1, { type: 'deleteAnnotations', ids: [1, 2] });
  });
});

describe('defaults for the next annotation', () => {
  it('start with a Solar highlight, Ink 2 pt strokes and 12 pt text', () => {
    expect(useAnnotationDefaults()).toBe(true);
  });
});

function useAnnotationDefaults(): boolean {
  return (
    DEFAULT_STYLES.highlight.color.join() === '255,248,77' &&
    DEFAULT_STYLES.ink.color.join() === '15,15,15' &&
    DEFAULT_STYLES.ink.width === 2 &&
    DEFAULT_STYLES.freeText.fontSize === 12
  );
}

describe('keyboard', () => {
  it('F6 from the selection focuses the first control, Shift+F6 and Esc go back', async () => {
    load([ink(1)], [1]);
    scene = canvas({ 1: OVER });
    const { user } = setup(<MiniBarSlot />);
    const frame = scene.frame(1);
    frame.focus();
    fireEvent.keyDown(frame, { key: 'F6' });
    const first = document.querySelector('[data-mb-item]');
    expect(document.activeElement).toBe(first);
    fireEvent.keyDown(first as Element, { key: 'F6', shiftKey: true });
    expect(document.activeElement).toBe(frame);
    fireEvent.keyDown(frame, { key: 'F6' });
    expect(document.activeElement).toBe(first);
    await user.keyboard('{Escape}');
    expect(document.activeElement).toBe(frame);
  });

  it('the selection mentions F6 in its description', () => {
    load([ink(1)], [1]);
    scene = canvas({ 1: OVER });
    setup(<MiniBarSlot />);
    const ids = (scene.frame(1).getAttribute('aria-describedby') ?? '').split(' ');
    const hint = ids.map((id) => document.getElementById(id)?.textContent ?? '').join(' ');
    expect(hint).toContain('F6');
  });
});

describe('text comment (DESIGN 3.5 B4, B5)', () => {
  const text = (extra: Record<string, unknown> = {}) =>
    make(1, 'freeText', {
      box: { x: 0, y: 0, w: 100, h: 30 },
      lines: ['a'],
      fontSize: 12,
      fill: null,
      borderWidth: 0,
      align: 'left',
      borderColor: null,
      ...extra,
    });
  const patchSent = () => (applyMock.mock.calls.at(-1)?.[1] as { patch: Record<string, unknown> }).patch;

  async function mount(extra: Record<string, unknown> = {}) {
    load([text(extra)], [1]);
    scene = canvas({ 1: OVER });
    return setup(<MiniBarSlot />);
  }

  it('align sets /Q and becomes the default of the next text comment', async () => {
    const { user } = await mount();
    await user.click(screen.getByRole('radio', { name: 'Centre' }));
    expect(patchSent()).toEqual({ align: 'center' });
    await waitFor(() => expect(useTools.getState().defaults.freeText?.align).toBe('center'));
  });

  it('the border toggle switches it on at 1 pt in Ink, and off again', async () => {
    const { user } = await mount();
    await user.click(screen.getByRole('button', { name: 'Border' }));
    expect(patchSent()).toEqual({ borderWidth: 1, borderColor: [15, 15, 15] });
    await waitFor(() => expect(useTools.getState().defaults.freeText).toMatchObject({ border: true, borderWidth: 1 }));
  });

  it('the border menu sets the width and the colour', async () => {
    const { user } = await mount({ borderWidth: 1 });
    await user.click(screen.getByRole('button', { name: 'Border options' }));
    await user.click(await screen.findByRole('radio', { name: '2 pt' }));
    expect(patchSent()).toEqual({ borderWidth: 2 });
  });

  it('the fill toggle sets an opaque Solar fill and clears it', async () => {
    const { user } = await mount();
    await user.click(screen.getByRole('button', { name: 'Fill' }));
    expect(patchSent()).toEqual({ fill: [255, 248, 77] });
    await waitFor(() => expect(useTools.getState().defaults.freeText).toMatchObject({ fillOn: true }));
  });

  it('a typed font size from 6 to 144 applies on Enter and is cut to the range', async () => {
    const { user } = await mount();
    const field = screen.getByRole('textbox', { name: 'Font size' });
    await user.clear(field);
    await user.type(field, '200{Enter}');
    expect(patchSent()).toEqual({ fontSize: 144 });
  });

  it('shows a custom colour of the recent list beside the palette and More colours', async () => {
    const { useRecentColours } = await import('../../stores/recentColours');
    useRecentColours.setState({ colours: [[1, 2, 3]] });
    await mount();
    expect(screen.getByRole('radio', { name: '#010203' })).not.toBeNull();
    expect(screen.getByRole('button', { name: 'More colours' })).not.toBeNull();
  });
});
