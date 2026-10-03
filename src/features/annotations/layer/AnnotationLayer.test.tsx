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
    // The preview follows the pointer.
    expect(frame(1).style.left).toBe('20px');
    fireEvent.pointerUp(window);
    await act(async () => undefined);
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
      coalesce: 'resize:1',
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
      coalesce: 'resize:1',
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
