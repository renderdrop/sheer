// @vitest-environment jsdom
import { act, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import * as api from '../../../api/annotations';
import type { Annotation, ChangeSet } from '../../../api/annotations';
import { usePulseMessage } from '../../../components';
import { EMPTY_HISTORY, useAnnotations } from '../../../stores/annotations';
import { useUi } from '../../../stores/ui';
import { forgetFileRotations, setFileRotation } from '../../viewer/fileRotation';
import { AnnotationLayer, type AnnotationLayerProps } from './AnnotationLayer';

vi.mock('../../../api/annotations');
const mocked = vi.mocked(api);

const common = {
  pageId: 0,
  color: [200, 30, 30],
  opacity: 1,
  contents: '',
  author: 'Ada',
  modified: null,
  inReplyTo: null,
  locked: false,
} as const;

function box(
  id: number,
  x: number,
  y: number,
  sync: Annotation['sync'] = 'new',
  extra: Partial<Annotation> = {},
): Annotation {
  const b = { x, y, w: 40, h: 20 };
  return {
    ...common,
    id,
    rect: b,
    sync,
    kind: 'rect',
    box: b,
    width: 1,
    fill: null,
    dashed: false,
    ...extra,
  } as Annotation;
}

// 100 x 200 pt shown at 2 px per pt.
const props = (overrides: Partial<AnnotationLayerProps> = {}): AnnotationLayerProps => ({
  docId: 1,
  pageIndex: 0,
  boxWidth: 200,
  boxHeight: 400,
  widthPt: 100,
  heightPt: 200,
  rotation: 0,
  visible: true,
  ready: true,
  ...overrides,
});

const empty: ChangeSet = { rev: 1, upserted: [], removed: [], pages: null, history: EMPTY_HISTORY };

function seed(list: Annotation[]) {
  useAnnotations.setState({
    byDoc: {
      1: {
        rev: 0,
        byId: Object.fromEntries(list.map((a) => [a.id, a])),
        loaded: { 0: true },
        removed: {},
        history: EMPTY_HISTORY,
      },
    },
    selectedIds: {},
  });
}

const nextFrame = () => act(() => new Promise<void>((done) => requestAnimationFrame(() => done())));
const frame = (id: number) => document.querySelector<HTMLElement>(`[data-annot-frame="${id}"]`) as HTMLElement;
const selected = () => useAnnotations.getState().selectedIds[1] ?? [];

beforeEach(() => {
  vi.resetAllMocks();
  mocked.applyCommand.mockResolvedValue(empty);
  mocked.listAnnotations.mockResolvedValue([]);
  useUi.setState({ activeTool: 'select', toolLocked: false, toast: null, banner: null });
  setFileRotation(1, 0, 0);
  seed([box(1, 10, 10), box(2, 60, 10, 'clean'), box(3, 10, 100)]);
});

afterEach(() => {
  forgetFileRotations(1);
  vi.useRealTimers();
});

describe('rendering', () => {
  it('lists the annotations in reading order, each a button with a name', () => {
    render(<AnnotationLayer {...props()} />);
    const frames = screen.getAllByRole('button');
    expect(frames.map((f) => f.getAttribute('data-annot-frame'))).toEqual(['1', '2', '3']);
    expect(frames[0]?.getAttribute('aria-label')).toBe('Rectangle by Ada, page 1');
    expect(frames[0]?.getAttribute('aria-roledescription')).toBe('Rectangle');
    expect(frames[0]?.getAttribute('aria-pressed')).toBe('false');
  });

  it('draws what this session made or changed, and leaves a clean one to the bitmap', () => {
    const { container } = render(<AnnotationLayer {...props()} />);
    // Two visible rectangles (ids 1 and 3), and one transparent hit rectangle per annotation.
    expect(container.querySelectorAll('svg > g > rect')).toHaveLength(2);
    expect(container.querySelectorAll('[data-annot-hit]')).toHaveLength(3);
  });

  it('draws a changed highlight in its own layer that multiplies with the page, not in the shape layer', () => {
    const quad = [
      { x: 10, y: 10 },
      { x: 50, y: 10 },
      { x: 10, y: 20 },
      { x: 50, y: 20 },
    ];
    seed([
      box(1, 10, 10, 'new', { kind: 'highlight', quads: [quad] } as unknown as Partial<Annotation>),
      box(2, 60, 10, 'clean', { kind: 'highlight', quads: [quad] } as unknown as Partial<Annotation>),
      box(3, 10, 100),
    ]);
    const { container } = render(<AnnotationLayer {...props()} />);
    const blend = container.querySelector('[data-annot-blend]');
    expect(blend?.className).toContain('mix-blend-multiply');
    expect(blend?.querySelectorAll('rect')).toHaveLength(1);
    // The rectangle is still in the shape layer; the highlight is not.
    expect(container.querySelectorAll('[data-annot-layer] svg > g > rect:not([fill="transparent"])')).toHaveLength(1);
  });

  it('has no blend layer without a drawn highlight', () => {
    const { container } = render(<AnnotationLayer {...props()} />);
    expect(container.querySelector('[data-annot-blend]')).toBeNull();
  });

  it('draws a note as its colour with a speech bubble on it', () => {
    seed([box(1, 10, 10, 'new', { kind: 'note', at: { x: 10, y: 10 } } as unknown as Partial<Annotation>)]);
    const { container } = render(<AnnotationLayer {...props()} />);
    expect(container.querySelectorAll('[data-note-glyph]')).toHaveLength(1);
  });

  it('draws nothing for an opaque annotation but lets it be selected when its bounds are known', () => {
    const opaque = {
      ...common,
      id: 9,
      rect: { x: 0, y: 0, w: 10, h: 10 },
      sync: 'clean',
      kind: 'opaque',
      subtype: 'Stamp',
    } as Annotation;
    seed([opaque]);
    const { container } = render(<AnnotationLayer {...props()} />);
    expect(container.querySelectorAll('svg > g > rect')).toHaveLength(0);
    expect(frame(9)).not.toBeNull();
  });

  it('renders nothing until the page rotation is known', () => {
    const { container } = render(<AnnotationLayer {...props({ ready: false })} />);
    expect(container.firstChild).toBeNull();
  });

  it('is placed in page space by the shared transform', () => {
    const { container } = render(<AnnotationLayer {...props()} />);
    const group = container.querySelector<HTMLElement>('[role="group"]');
    expect(group?.style.transform).toBe('scale(2)');
    expect(group?.style.width).toBe('100px');
  });
});

describe('loading', () => {
  it('asks for the annotations of a visible page, once', () => {
    useAnnotations.setState({ byDoc: {} });
    const { rerender } = render(<AnnotationLayer {...props()} />);
    rerender(<AnnotationLayer {...props({ boxWidth: 300, boxHeight: 600 })} />);
    expect(mocked.listAnnotations).toHaveBeenCalledTimes(1);
    expect(mocked.listAnnotations).toHaveBeenCalledWith(1, 0);
  });

  it('does not ask for a page that is only near', () => {
    useAnnotations.setState({ byDoc: {} });
    render(<AnnotationLayer {...props({ visible: false })} />);
    expect(mocked.listAnnotations).not.toHaveBeenCalled();
  });
});

describe('selection', () => {
  it('focus selects, and the frame says so', () => {
    render(<AnnotationLayer {...props()} />);
    act(() => frame(3).focus());
    expect(selected()).toEqual([3]);
    expect(frame(3).getAttribute('aria-pressed')).toBe('true');
    expect(frame(3).getAttribute('data-state')).toBe('selected');
  });

  it('a press on the shape selects it; Shift adds and removes', () => {
    const { container } = render(<AnnotationLayer {...props()} />);
    const hit = (id: number) => container.querySelector(`[data-annot-hit="${id}"]`) as Element;
    fireEvent.pointerDown(hit(1), { button: 0 });
    fireEvent.pointerUp(window);
    expect(selected()).toEqual([1]);
    fireEvent.pointerDown(hit(3), { button: 0, shiftKey: true });
    fireEvent.pointerUp(window);
    expect(selected()).toEqual([1, 3]);
    fireEvent.pointerDown(hit(1), { button: 0, shiftKey: true });
    fireEvent.pointerUp(window);
    expect(selected()).toEqual([3]);
  });

  it('a double-click on a free text opens its editor; on a rectangle it does not; Esc commits the new text', async () => {
    const text = box(5, 10, 150, 'clean', { kind: 'freeText', lines: ['Hallo'], fontSize: 12 } as Partial<Annotation>);
    seed([box(1, 10, 10), text]);
    const { container } = render(<AnnotationLayer {...props()} />);
    const hit = (id: number) => container.querySelector(`[data-annot-hit="${id}"]`) as Element;
    fireEvent.doubleClick(hit(1));
    expect(screen.queryByRole('textbox')).toBeNull();
    fireEvent.doubleClick(hit(5));
    const field = screen.getByRole('textbox') as HTMLTextAreaElement;
    expect(field.value).toBe('Hallo');
    fireEvent.change(field, { target: { value: 'Hallo Welt' } });
    await act(async () => {
      fireEvent.keyDown(field, { key: 'Escape' });
    });
    // The box grew with the text (DESIGN 3.5 B4): it is part of the same patch.
    const grown: unknown = expect.objectContaining({ x: 10, y: 150 });
    expect(mocked.applyCommand).toHaveBeenCalledWith(
      1,
      expect.objectContaining({ type: 'updateAnnotation', id: 5, patch: { lines: ['Hallo Welt'], box: grown } }),
    );
    expect(screen.queryByRole('textbox')).toBeNull();
  });

  it('shows eight handles for the only selected box and none for two', () => {
    const { container } = render(<AnnotationLayer {...props()} />);
    act(() => useAnnotations.getState().select(1, [1]));
    expect(container.querySelectorAll('[data-annot-handle]')).toHaveLength(8);
    act(() => useAnnotations.getState().select(1, [1, 3]));
    expect(container.querySelectorAll('[data-annot-handle]')).toHaveLength(0);
  });

  it('shows no handles for a locked annotation', () => {
    seed([box(1, 10, 10, 'new', { locked: true })]);
    const { container } = render(<AnnotationLayer {...props()} />);
    act(() => useAnnotations.getState().select(1, [1]));
    expect(container.querySelectorAll('[data-annot-handle]')).toHaveLength(0);
  });

  it('Esc clears the selection', () => {
    render(<AnnotationLayer {...props()} />);
    act(() => frame(1).focus());
    fireEvent.keyDown(frame(1), { key: 'Escape' });
    expect(selected()).toEqual([]);
  });

  it('a press on the page outside any annotation clears it', () => {
    const { container } = render(
      <main data-action-scope="canvas">
        <AnnotationLayer {...props()} />
        <p data-testid="empty">page</p>
      </main>,
    );
    act(() => useAnnotations.getState().select(1, [1]));
    fireEvent.pointerDown(container.querySelector('[data-testid="empty"]') as Element);
    expect(selected()).toEqual([]);
  });

  it('takes no pointer while a creation tool is active', () => {
    useUi.setState({ activeTool: 'draw' });
    const { container } = render(<AnnotationLayer {...props()} />);
    expect(container.querySelectorAll('[data-annot-hit]')).toHaveLength(0);
  });
});

describe('moving', () => {
  it('a drag is one moveAnnotations on release, in page points, grouped for the whole selection', async () => {
    const { container } = render(<AnnotationLayer {...props()} />);
    act(() => useAnnotations.getState().select(1, [1, 3]));
    const hit = container.querySelector('[data-annot-hit="1"]') as Element;
    fireEvent.pointerDown(hit, { button: 0, clientX: 0, clientY: 0 });
    fireEvent.pointerMove(window, { clientX: 20, clientY: 10 });
    // The preview is a CSS offset on the frame, drawn on the next animation frame; no command and no render per pointer event.
    await nextFrame();
    expect(frame(1).style.translate).toBe('10px 5px');
    expect(frame(1).style.left).toBe('10px');
    expect(mocked.applyCommand).not.toHaveBeenCalled();
    fireEvent.pointerUp(window);
    await act(async () => undefined);
    // Released: the offset is gone (the store is a mock here, so the frame is back at its own place).
    expect(frame(1).style.translate).toBe('');
    expect(mocked.applyCommand).toHaveBeenCalledTimes(1);
    expect(mocked.applyCommand).toHaveBeenCalledWith(1, {
      type: 'moveAnnotations',
      ids: [1, 3],
      dx: 10,
      dy: 5,
    });
  });

  it('below the drag threshold it is a click, not a move', async () => {
    const { container } = render(<AnnotationLayer {...props()} />);
    const hit = container.querySelector('[data-annot-hit="1"]') as Element;
    fireEvent.pointerDown(hit, { button: 0, clientX: 0, clientY: 0 });
    fireEvent.pointerMove(window, { clientX: 2, clientY: 1 });
    fireEvent.pointerUp(window);
    await act(async () => undefined);
    expect(mocked.applyCommand).not.toHaveBeenCalled();
    expect(selected()).toEqual([1]);
  });

  it('stays on the page', async () => {
    const { container } = render(<AnnotationLayer {...props()} />);
    const hit = container.querySelector('[data-annot-hit="1"]') as Element;
    fireEvent.pointerDown(hit, { button: 0, clientX: 0, clientY: 0 });
    fireEvent.pointerMove(window, { clientX: -400, clientY: 0 });
    fireEvent.pointerUp(window);
    await act(async () => undefined);
    expect(mocked.applyCommand).toHaveBeenCalledWith(1, {
      type: 'moveAnnotations',
      ids: [1],
      dx: -10,
      dy: 0,
    });
  });

  it('Esc during a drag cancels it', async () => {
    const { container } = render(<AnnotationLayer {...props()} />);
    const hit = container.querySelector('[data-annot-hit="1"]') as Element;
    fireEvent.pointerDown(hit, { button: 0, clientX: 0, clientY: 0 });
    fireEvent.pointerMove(window, { clientX: 20, clientY: 0 });
    fireEvent.keyDown(window, { key: 'Escape' });
    fireEvent.pointerUp(window);
    await act(async () => undefined);
    expect(mocked.applyCommand).not.toHaveBeenCalled();
    expect(frame(1).style.left).toBe('10px');
  });

  it('a locked annotation does not move', async () => {
    seed([box(1, 10, 10, 'new', { locked: true })]);
    const { container } = render(<AnnotationLayer {...props()} />);
    const hit = container.querySelector('[data-annot-hit="1"]') as Element;
    fireEvent.pointerDown(hit, { button: 0, clientX: 0, clientY: 0 });
    fireEvent.pointerMove(window, { clientX: 20, clientY: 0 });
    fireEvent.pointerUp(window);
    await act(async () => undefined);
    expect(mocked.applyCommand).not.toHaveBeenCalled();
  });
});

describe('resizing', () => {
  it('dragging a handle is one updateAnnotation with the new box', async () => {
    const { container } = render(<AnnotationLayer {...props()} />);
    act(() => useAnnotations.getState().select(1, [1]));
    const handle = container.querySelector('[data-annot-handle="se"]') as Element;
    fireEvent.pointerDown(handle, { button: 0, clientX: 0, clientY: 0 });
    fireEvent.pointerMove(window, { clientX: 20, clientY: 20 });
    fireEvent.pointerUp(window);
    await act(async () => undefined);
    expect(mocked.applyCommand).toHaveBeenCalledWith(1, {
      type: 'updateAnnotation',
      id: 1,
      patch: { box: { x: 10, y: 10, w: 50, h: 30 } },
      coalesce: 'resize.1', // the backend accepts only [A-Za-z0-9._-] in a key
    });
  });
});

describe('keyboard', () => {
  beforeEach(() => vi.useFakeTimers());

  it('arrows nudge 1 pt, Shift 10, and the nudges of half a second are one step', async () => {
    render(<AnnotationLayer {...props()} />);
    act(() => frame(1).focus());
    fireEvent.keyDown(frame(1), { key: 'ArrowRight' });
    fireEvent.keyDown(frame(1), { key: 'ArrowRight' });
    fireEvent.keyDown(frame(1), { key: 'ArrowDown', shiftKey: true });
    expect(mocked.applyCommand).not.toHaveBeenCalled();
    expect(frame(1).style.left).toBe('12px');
    await act(async () => {
      await vi.advanceTimersByTimeAsync(500);
    });
    expect(mocked.applyCommand).toHaveBeenCalledTimes(1);
    expect(mocked.applyCommand).toHaveBeenCalledWith(1, { type: 'moveAnnotations', ids: [1], dx: 2, dy: 10 });
  });

  it('turns the arrows with the view rotation: a quarter turn makes right point up the page space', async () => {
    render(<AnnotationLayer {...props({ boxWidth: 400, boxHeight: 200, rotation: 90 })} />);
    act(() => frame(1).focus());
    fireEvent.keyDown(frame(1), { key: 'ArrowRight' });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(500);
    });
    expect(mocked.applyCommand).toHaveBeenCalledWith(1, { type: 'moveAnnotations', ids: [1], dx: 0, dy: -1 });
  });

  it('leaving the annotation sends the waiting nudge at once', async () => {
    render(<AnnotationLayer {...props()} />);
    act(() => frame(1).focus());
    fireEvent.keyDown(frame(1), { key: 'ArrowLeft' });
    fireEvent.blur(frame(1));
    await act(async () => undefined);
    expect(mocked.applyCommand).toHaveBeenCalledWith(1, { type: 'moveAnnotations', ids: [1], dx: -1, dy: 0 });
  });

  it('Alt with the arrows resizes the trailing and bottom edges', async () => {
    render(<AnnotationLayer {...props()} />);
    act(() => frame(1).focus());
    fireEvent.keyDown(frame(1), { key: 'ArrowRight', altKey: true });
    fireEvent.keyDown(frame(1), { key: 'ArrowDown', altKey: true });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(500);
    });
    expect(mocked.applyCommand).toHaveBeenCalledWith(1, {
      type: 'updateAnnotation',
      id: 1,
      patch: { box: { x: 10, y: 10, w: 41, h: 21 } },
      coalesce: 'resize.1', // the backend accepts only [A-Za-z0-9._-] in a key
    });
  });

  it('Esc takes back the nudges that wait: nothing is sent, the selection stays, a second Esc clears it', async () => {
    render(<AnnotationLayer {...props()} />);
    act(() => frame(1).focus());
    fireEvent.keyDown(frame(1), { key: 'ArrowRight' });
    expect(frame(1).style.left).toBe('11px');
    fireEvent.keyDown(frame(1), { key: 'Escape' });
    expect(frame(1).style.left).toBe('10px');
    expect(selected()).toEqual([1]);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1000);
    });
    expect(mocked.applyCommand).not.toHaveBeenCalled();
    fireEvent.keyDown(frame(1), { key: 'Escape' });
    expect(selected()).toEqual([]);
  });

  it('says so when Alt with the arrows has nothing to resize', () => {
    seed([box(1, 10, 10, 'new', { locked: true })]);
    function Probe() {
      return <span data-testid="said">{usePulseMessage()}</span>;
    }
    render(
      <>
        <AnnotationLayer {...props()} />
        <Probe />
      </>,
    );
    act(() => frame(1).focus());
    act(() => {
      fireEvent.keyDown(frame(1), { key: 'ArrowRight', altKey: true });
    });
    expect(screen.getByTestId('said').textContent).toContain('can’t be resized');
    expect(mocked.applyCommand).not.toHaveBeenCalled();
  });

  it('Delete removes the selection and offers Undo', async () => {
    mocked.applyCommand.mockResolvedValue({ ...empty, removed: [1] });
    render(<AnnotationLayer {...props()} />);
    act(() => frame(1).focus());
    fireEvent.keyDown(frame(1), { key: 'Delete' });
    await act(async () => undefined);
    expect(mocked.applyCommand).toHaveBeenCalledWith(1, { type: 'deleteAnnotations', ids: [1] });
    expect(useUi.getState().toast?.message).toBe('Rectangle deleted');
    expect(selected()).toEqual([]);
  });

  it('Shift+Space adds the focused annotation to the selection', () => {
    render(<AnnotationLayer {...props()} />);
    act(() => useAnnotations.getState().select(1, [1]));
    fireEvent.keyDown(frame(3), { key: ' ', shiftKey: true });
    expect(selected()).toEqual([1, 3]);
  });

  it('a failed command is reported in the banner, not thrown', async () => {
    mocked.applyCommand.mockRejectedValue({ code: 'read_only' });
    render(<AnnotationLayer {...props()} />);
    act(() => frame(1).focus());
    fireEvent.keyDown(frame(1), { key: 'Delete' });
    await act(async () => undefined);
    expect(useUi.getState().banner?.code).toBe('read_only');
  });
});

describe('moving in every tool and turning (ADR-105)', () => {
  /** The creation or placement surface of the page, 100 x 200 pt shown at 2 px per pt. */
  function withSurface(selector: string) {
    const view = render(<AnnotationLayer {...props()} />);
    const surface = view.container.querySelector<HTMLElement>(selector);
    if (surface === null) throw new Error(`no ${selector}`);
    surface.getBoundingClientRect = () =>
      ({ left: 0, top: 0, width: 200, height: 400, right: 200, bottom: 400, x: 0, y: 0, toJSON: () => '' }) as DOMRect;
    return { ...view, surface };
  }
  const filled = (id: number, x: number, y: number, extra: Partial<Annotation> = {}) =>
    box(id, x, y, 'new', { fill: [10, 20, 30], ...extra } as Partial<Annotation>);

  beforeEach(() => {
    seed([filled(1, 10, 10), filled(2, 60, 100)]);
  });

  it('a press on a movable annotation with the Note tool moves it: one command on release, nothing created', async () => {
    useUi.setState({ activeTool: 'note', toolLocked: false });
    const { surface } = withSurface('[data-creation-layer]');
    // (30, 30) px is (15, 15) pt: inside the rectangle at (10, 10).
    fireEvent.pointerDown(surface, { button: 0, clientX: 30, clientY: 30, pointerId: 1 });
    for (const x of [34, 40, 50, 60]) fireEvent.pointerMove(window, { clientX: x, clientY: 30 });
    await nextFrame();
    expect(frame(1).style.translate).toBe('15px 0px');
    expect(mocked.applyCommand).not.toHaveBeenCalled();
    fireEvent.pointerUp(window);
    await act(async () => undefined);
    // One command for the whole drag: a move, and no createAnnotation.
    expect(mocked.applyCommand).toHaveBeenCalledTimes(1);
    expect(mocked.applyCommand).toHaveBeenCalledWith(1, { type: 'moveAnnotations', ids: [1], dx: 15, dy: 0 });
    expect(selected()).toEqual([1]);
    expect(useUi.getState().activeTool).toBe('note');
  });

  it('a click without movement only selects it, and a press elsewhere still creates', async () => {
    useUi.setState({ activeTool: 'note', toolLocked: false });
    const { surface } = withSurface('[data-creation-layer]');
    fireEvent.pointerDown(surface, { button: 0, clientX: 30, clientY: 30, pointerId: 1 });
    fireEvent.pointerUp(window);
    await act(async () => undefined);
    expect(mocked.applyCommand).not.toHaveBeenCalled();
    expect(selected()).toEqual([1]);
    fireEvent.pointerDown(surface, { button: 0, clientX: 150, clientY: 300, pointerId: 1 });
    fireEvent.pointerUp(surface, { button: 0, clientX: 150, clientY: 300, pointerId: 1 });
    expect(mocked.applyCommand).toHaveBeenCalledWith(1, expect.objectContaining({ type: 'createAnnotation' }));
  });

  it('an outline-only shape leaves its inside to the tool, and text markup is never moved', async () => {
    seed([box(1, 10, 10), { ...filled(2, 60, 100), kind: 'highlight', quads: [] } as unknown as Annotation]);
    useUi.setState({ activeTool: 'note', toolLocked: false });
    const { surface } = withSurface('[data-creation-layer]');
    fireEvent.pointerDown(surface, { button: 0, clientX: 60, clientY: 40, pointerId: 1 });
    fireEvent.pointerUp(surface, { button: 0, clientX: 60, clientY: 40, pointerId: 1 });
    fireEvent.pointerDown(surface, { button: 0, clientX: 130, clientY: 210, pointerId: 1 });
    fireEvent.pointerUp(surface, { button: 0, clientX: 130, clientY: 210, pointerId: 1 });
    expect(mocked.applyCommand).toHaveBeenCalledTimes(2);
    expect(mocked.applyCommand).toHaveBeenCalledWith(1, expect.objectContaining({ type: 'createAnnotation' }));
  });

  it('a drag in the Select tool is also one rAF-coalesced preview and one command', async () => {
    const { container } = render(<AnnotationLayer {...props()} />);
    const hit = container.querySelector('[data-annot-hit="1"]') as Element;
    fireEvent.pointerDown(hit, { button: 0, clientX: 0, clientY: 0 });
    for (let x = 6; x <= 60; x += 6) fireEvent.pointerMove(window, { clientX: x, clientY: 0 });
    fireEvent.pointerUp(window);
    await act(async () => undefined);
    expect(mocked.applyCommand).toHaveBeenCalledTimes(1);
  });

  it('the rotate handle turns a signature to the pointer, Shift snaps to 15 degrees, one updateAnnotation on release', async () => {
    const signature = {
      ...common,
      id: 5,
      kind: 'signature',
      sync: 'new',
      role: 'signature',
      art: { type: 'file' },
      angle: 0,
      rect: { x: 10, y: 100, w: 80, h: 20 },
      box: { x: 10, y: 100, w: 80, h: 20 },
    } as unknown as Annotation;
    seed([signature]);
    const { container } = render(<AnnotationLayer {...props()} />);
    act(() => useAnnotations.getState().select(1, [5]));
    const handle = container.querySelector('[data-annot-handle="rotate"]') as Element;
    expect(handle).not.toBeNull();
    // The handle is at (50, 82) pt, 18 pt above the box; the centre is (50, 110). 56 pt right of it and 28 up: atan2 = 63.4 degrees.
    fireEvent.pointerDown(handle, { button: 0, clientX: 0, clientY: 0 });
    fireEvent.pointerMove(window, { clientX: 112, clientY: 0, shiftKey: true });
    fireEvent.pointerUp(window);
    await act(async () => undefined);
    expect(mocked.applyCommand).toHaveBeenCalledTimes(1);
    const sent = mocked.applyCommand.mock.calls[0]?.[1] as { type: string; id: number; patch: { angle: number } };
    expect(sent.type).toBe('updateAnnotation');
    expect(sent.id).toBe(5);
    expect(sent.patch.angle % 15).toBe(0);
    expect(sent.patch.angle).toBeGreaterThan(0);
  });
});

describe('text comment (DESIGN 3.5 B4)', () => {
  function click(container: HTMLElement) {
    const surface = container.querySelector<HTMLElement>('[data-creation-layer]');
    if (surface === null) throw new Error('no creation layer');
    surface.getBoundingClientRect = () =>
      ({ left: 0, top: 0, width: 200, height: 400, right: 200, bottom: 400, x: 0, y: 0, toJSON: () => '' }) as DOMRect;
    fireEvent.pointerDown(surface, { button: 0, clientX: 160, clientY: 300, pointerId: 1 });
    fireEvent.pointerUp(surface, { button: 0, clientX: 160, clientY: 300, pointerId: 1 });
  }

  it('one click makes the box and puts the caret in it, with no double-click; typing grows the box', async () => {
    useUi.setState({ activeTool: 'text' });
    const made = box(9, 10, 20, 'new', {
      kind: 'freeText',
      box: { x: 10, y: 20, w: 24, h: 22.4 },
      rect: { x: 10, y: 20, w: 24, h: 22.4 },
      lines: [],
      fontSize: 12,
      fill: null,
      borderWidth: 0,
      align: 'left',
      borderColor: null,
    } as Partial<Annotation>);
    mocked.applyCommand.mockResolvedValue({ ...empty, upserted: [made] });
    const { container } = render(<AnnotationLayer {...props()} />);
    click(container);
    await act(async () => undefined);
    expect(mocked.applyCommand).toHaveBeenCalledWith(
      1,
      expect.objectContaining({
        type: 'createAnnotation',
        draft: expect.objectContaining({
          kind: 'freeText',
          lines: [],
          box: expect.objectContaining({ x: 0, y: 150, w: 24 }),
        }),
      }),
    );
    const field = (await screen.findByRole('textbox')) as HTMLTextAreaElement;
    expect(document.activeElement).toBe(field);
    expect(field.placeholder).toBe('Type…');
    // Short text: the box hugs it (to the right); a long one stops at the page's limit and grows downward.
    const narrow = Number.parseFloat(field.style.width);
    fireEvent.change(field, { target: { value: 'Hi there' } });
    const wider = Number.parseFloat(field.style.width);
    expect(wider).toBeGreaterThan(narrow);
    fireEvent.change(field, { target: { value: 'Hi there '.repeat(30) } });
    const wrapped = Number.parseFloat(field.style.height);
    expect(Number.parseFloat(field.style.width)).toBeLessThanOrEqual(96);
    expect(wrapped).toBeGreaterThan(40);
  });
});

describe('spell 7: undo and redo fade the item', () => {
  const history = { ...EMPTY_HISTORY };
  const fading = (mode: string) => document.querySelectorAll(`[data-undo-fade="${mode}"]`);

  it('an item that an undo removes stays one fade as a ghost, fading out, then goes', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    render(<AnnotationLayer {...props()} />);
    mocked.undo.mockResolvedValue({ ...empty, rev: 2, removed: [1], history });
    await act(async () => {
      await useAnnotations.getState().undo(1);
    });
    expect(frame(1)).toBeNull();
    expect(fading('out')).toHaveLength(1);
    expect(fading('out')[0]?.querySelector('rect')).not.toBeNull();
    // It settles into its end state (opacity 0, scale 0.98 by the stylesheet) after its first frame.
    expect(fading('out')[0]?.hasAttribute('data-settled')).toBe(true);
    act(() => void vi.advanceTimersByTime(130));
    expect(fading('out')).toHaveLength(0);
  });

  it('a plain delete (not an undo) makes no ghost', async () => {
    render(<AnnotationLayer {...props()} />);
    await act(async () => {
      useAnnotations.getState().applyChanges(1, { ...empty, rev: 2, removed: [1], history });
    });
    expect(fading('out')).toHaveLength(0);
  });

  it('an item that a redo brings back fades in from its start state, then is plain', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    render(<AnnotationLayer {...props()} />);
    mocked.redo.mockResolvedValue({ ...empty, rev: 2, upserted: [box(4, 40, 150)], history });
    await act(async () => {
      await useAnnotations.getState().redo(1);
    });
    expect(fading('in')).toHaveLength(1);
    expect(fading('in')[0]?.querySelector('rect')).not.toBeNull();
    act(() => void vi.advanceTimersByTime(130));
    expect(fading('in')).toHaveLength(0);
    expect(frame(4)).not.toBeNull();
  });
});
