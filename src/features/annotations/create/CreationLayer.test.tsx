// @vitest-environment jsdom
import { act, fireEvent, render } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { DocCommand } from '../../../api/annotations';
import { useAnnotations } from '../../../stores/annotations';
import { useUi } from '../../../stores/ui';
import { CreationLayer } from './CreationLayer';

const props = { docId: 1, pageIndex: 0, pageBox: { width: 600, height: 800 }, transform: { pxPerPt: 1, rotation: 0 } };

function mount(rotation = 0) {
  const view = render(<CreationLayer {...props} transform={{ pxPerPt: 1, rotation }} />);
  const surface = view.container.querySelector<HTMLElement>('[data-creation-layer]');
  if (surface === null) return { ...view, surface: null };
  const w = rotation % 180 === 0 ? 600 : 800;
  const h = rotation % 180 === 0 ? 800 : 600;
  surface.getBoundingClientRect = () => ({
    left: 0,
    top: 0,
    width: w,
    height: h,
    right: w,
    bottom: h,
    x: 0,
    y: 0,
    toJSON: () => '',
  });
  return { ...view, surface };
}

describe('CreationLayer', () => {
  let apply: ReturnType<typeof vi.fn>;
  beforeEach(() => {
    apply = vi.fn((...args: [number, DocCommand]) =>
      args.length > 5 ? Promise.reject(new Error()) : Promise.resolve({ upserted: [], removed: [], rev: 1 }),
    );
    useAnnotations.setState({ apply } as never);
    useUi.setState({ activeTool: 'select', toolLocked: false });
  });
  afterEach(() => {
    useUi.setState({ activeTool: 'select', toolLocked: false });
  });

  it('takes no pointer with the Select tool', () => {
    expect(mount().surface).toBeNull();
  });

  it('places a note with one command and returns to Select', () => {
    useUi.setState({ activeTool: 'note' });
    const { surface } = mount();
    if (surface === null) throw new Error('no layer');
    fireEvent.pointerDown(surface, { button: 0, clientX: 100, clientY: 200, pointerId: 1 });
    fireEvent.pointerUp(surface, { button: 0, clientX: 100, clientY: 200, pointerId: 1 });
    expect(apply).toHaveBeenCalledTimes(1);
    expect(apply.mock.calls[0]?.[1]).toMatchObject({
      type: 'createAnnotation',
      draft: { kind: 'note', pageId: 0, at: { x: 100, y: 200 } },
    });
    expect(useUi.getState().activeTool).toBe('select');
  });

  it('draws a shape by dragging and maps the rotated page back to page space', () => {
    useUi.setState({ activeTool: 'shapes', toolLocked: true });
    const { surface } = mount(90);
    if (surface === null) throw new Error('no layer');
    fireEvent.pointerDown(surface, { button: 0, clientX: 0, clientY: 0, pointerId: 1 });
    fireEvent.pointerMove(surface, { clientX: 100, clientY: 50, pointerId: 1 });
    fireEvent.pointerUp(surface, { button: 0, clientX: 100, clientY: 50, pointerId: 1 });
    expect(apply).toHaveBeenCalledTimes(1);
    // Rotated 90 degrees: view (x, y) is page (y, h - x).
    expect(apply.mock.calls[0]?.[1]).toMatchObject({
      draft: { kind: 'rect', box: { x: 0, y: 700, w: 50, h: 100 } },
    });
    expect(useUi.getState().activeTool).toBe('shapes');
  });

  it('cancels a drag with Esc', () => {
    useUi.setState({ activeTool: 'shapes', toolLocked: true });
    const { surface } = mount();
    if (surface === null) throw new Error('no layer');
    fireEvent.pointerDown(surface, { button: 0, clientX: 10, clientY: 10, pointerId: 1 });
    fireEvent.pointerMove(surface, { clientX: 100, clientY: 100, pointerId: 1 });
    act(() => {
      fireEvent.keyDown(window, { key: 'Escape' });
    });
    fireEvent.pointerUp(surface, { button: 0, clientX: 100, clientY: 100, pointerId: 1 });
    expect(apply).not.toHaveBeenCalled();
  });

  it('joins ink strokes into one annotation', () => {
    vi.useFakeTimers();
    try {
      useUi.setState({ activeTool: 'draw' });
      const { surface } = mount();
      if (surface === null) throw new Error('no layer');
      for (const y of [10, 60]) {
        fireEvent.pointerDown(surface, { button: 0, clientX: 10, clientY: y, pointerId: 1 });
        fireEvent.pointerMove(surface, { clientX: 50, clientY: y + 5, pointerId: 1 });
        fireEvent.pointerUp(surface, { button: 0, clientX: 90, clientY: y, pointerId: 1 });
        act(() => {
          vi.advanceTimersByTime(300);
        });
      }
      expect(apply).not.toHaveBeenCalled();
      act(() => {
        vi.advanceTimersByTime(1000);
      });
      expect(apply).toHaveBeenCalledTimes(1);
      const draft = (apply.mock.calls[0]?.[1] as { draft: { kind: string; strokes: unknown[] } }).draft;
      expect(draft.kind).toBe('ink');
      expect(draft.strokes).toHaveLength(2);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('CreationLayer ink grouping and cancel', () => {
  let apply: ReturnType<typeof vi.fn>;
  beforeEach(() => {
    vi.useFakeTimers();
    apply = vi.fn(() => Promise.resolve({ upserted: [], removed: [], rev: 1 }));
    useAnnotations.setState({ apply } as never);
    useUi.setState({ activeTool: 'draw', toolLocked: false });
  });
  afterEach(() => {
    vi.useRealTimers();
    useUi.setState({ activeTool: 'select', toolLocked: false });
  });

  function surfaceOf() {
    const view = render(<CreationLayer {...props} />);
    const surface = view.container.querySelector<HTMLElement>('[data-creation-layer]');
    if (surface === null) throw new Error('no layer');
    surface.getBoundingClientRect = () =>
      ({ left: 0, top: 0, width: 600, height: 800, right: 600, bottom: 800, x: 0, y: 0, toJSON: () => '' }) as DOMRect;
    return surface;
  }

  it('commits a waiting group after a cancelled pointer, with the stroke so far in it', () => {
    const surface = surfaceOf();
    fireEvent.pointerDown(surface, { button: 0, clientX: 10, clientY: 10, pointerId: 1 });
    fireEvent.pointerMove(surface, { clientX: 60, clientY: 40, pointerId: 1 });
    fireEvent.pointerCancel(surface, { pointerId: 1 });
    expect(apply).not.toHaveBeenCalled();
    act(() => {
      vi.advanceTimersByTime(1100);
    });
    expect(apply).toHaveBeenCalledTimes(1);
  });

  it('drops a cancelled stroke with nothing waiting, and commits nothing', () => {
    const surface = surfaceOf();
    fireEvent.pointerDown(surface, { button: 0, clientX: 10, clientY: 10, pointerId: 1 });
    fireEvent.pointerCancel(surface, { pointerId: 1 });
    act(() => {
      vi.advanceTimersByTime(2000);
    });
    expect(apply).not.toHaveBeenCalled();
  });

  it('builds the preview once per frame, however many moves arrive', () => {
    const surface = surfaceOf();
    const frames = vi.spyOn(globalThis, 'requestAnimationFrame');
    fireEvent.pointerDown(surface, { button: 0, clientX: 10, clientY: 10, pointerId: 1 });
    act(() => {
      vi.advanceTimersByTime(50);
    });
    frames.mockClear();
    for (let i = 1; i <= 50; i += 1)
      fireEvent.pointerMove(surface, { clientX: 10 + i * 2, clientY: 10 + i, pointerId: 1 });
    expect(frames).toHaveBeenCalledTimes(1);
    act(() => {
      vi.advanceTimersByTime(50);
    });
    expect(surface.querySelectorAll('polygon').length).toBe(1);
    fireEvent.pointerUp(surface, { button: 0, clientX: 110, clientY: 60, pointerId: 1 });
  });
});
