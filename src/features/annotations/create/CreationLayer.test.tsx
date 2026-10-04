// @vitest-environment jsdom
import { act, fireEvent, render, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { DocCommand } from '../../../api/annotations';
import { useAnnotations } from '../../../stores/annotations';
import { useTools } from '../../../stores/tools';
import { useUi } from '../../../stores/ui';
import { CreationLayer } from './CreationLayer';

vi.mock('../../textlayer/cache', () => ({
  loadLayer: vi.fn(),
  peekLayer: () => ({
    text: 'HELLO',
    boxes: [50, 100, 10, 12, 60, 100, 10, 12, 70, 100, 10, 12, 80, 100, 10, 12, 90, 100, 10, 12],
  }),
}));

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

  it('places a note with one command and stays on the Note tool', () => {
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
    expect(useUi.getState().activeTool).toBe('note');
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

describe('CreationLayer preview placement (F11)', () => {
  beforeEach(() => {
    useAnnotations.setState({ apply: vi.fn(() => Promise.resolve({ upserted: [], removed: [], rev: 1 })) } as never);
    vi.useRealTimers();
    useTools.getState().setShapes('line');
    useUi.setState({ activeTool: 'shapes', toolLocked: true });
  });
  afterEach(() => {
    useUi.setState({ activeTool: 'select', toolLocked: false });
    vi.unstubAllGlobals();
  });

  // The client position of a page-space point inside the preview svg, from its inline box: left/top/size, rotate, scale about the
  // centre. This is what the browser computes; the point drawn for the drag's start must be under the pointer.
  function clientOf(svg: SVGElement, layer: { left: number; top: number }, p: { x: number; y: number }) {
    const left = parseFloat(svg.style.left);
    const top = parseFloat(svg.style.top);
    const w = parseFloat(svg.getAttribute('width') ?? '0');
    const h = parseFloat(svg.getAttribute('height') ?? '0');
    const scale = /scale\(([-\d.]+)\)/.exec(svg.style.transform)?.[1] ?? '1';
    const turn = /rotate\(([-\d.]+)deg\)/.exec(svg.style.transform)?.[1] ?? '0';
    const z = Number(scale);
    const a = (Number(turn) * Math.PI) / 180;
    const vx = (p.x - w / 2) * z;
    const vy = (p.y - h / 2) * z;
    return {
      x: layer.left + left + w / 2 + vx * Math.cos(a) - vy * Math.sin(a),
      y: layer.top + top + h / 2 + vx * Math.sin(a) + vy * Math.cos(a),
    };
  }

  it.each([
    [1.04, 0],
    [1.04, 90],
    [2.5, 270],
    [0.5, 180],
  ])('keeps the preview under the pointer at zoom %s, rotation %s, DPR 2', async (pxPerPt, rotation) => {
    vi.stubGlobal('devicePixelRatio', 2);
    vi.stubGlobal('requestAnimationFrame', (cb: FrameRequestCallback) => {
      cb(0);
      return 1;
    });
    vi.stubGlobal('cancelAnimationFrame', () => undefined);
    const view = render(<CreationLayer {...props} transform={{ pxPerPt, rotation }} />);
    const surface = view.container.querySelector<HTMLElement>('[data-creation-layer]');
    if (surface === null) throw new Error('no layer');
    const swap = rotation % 180 !== 0;
    const w = (swap ? 800 : 600) * pxPerPt;
    const h = (swap ? 600 : 800) * pxPerPt;
    // The layer sits at (30, 40) in the client.
    const origin = { left: 30, top: 40 };
    surface.getBoundingClientRect = () =>
      ({ ...origin, width: w, height: h, right: 30 + w, bottom: 40 + h, x: 30, y: 40, toJSON: () => '' }) as DOMRect;
    const down = { x: 30 + w * 0.3, y: 40 + h * 0.4 };
    fireEvent.pointerDown(surface, { button: 0, clientX: down.x, clientY: down.y, pointerId: 1 });
    fireEvent.pointerMove(surface, { clientX: down.x + 40, clientY: down.y + 30, pointerId: 1 });
    await waitFor(() => expect(surface.querySelector('line'), surface.outerHTML).not.toBeNull());
    const line = surface.querySelector('line') as SVGLineElement;
    const svg = surface.querySelector('svg') as SVGElement;
    const start = clientOf(svg, origin, { x: Number(line.getAttribute('x1')), y: Number(line.getAttribute('y1')) });
    const end = clientOf(svg, origin, { x: Number(line.getAttribute('x2')), y: Number(line.getAttribute('y2')) });
    expect(start.x).toBeCloseTo(down.x, 3);
    expect(start.y).toBeCloseTo(down.y, 3);
    expect(end.x).toBeCloseTo(down.x + 40, 3);
    expect(end.y).toBeCloseTo(down.y + 30, 3);
  });
});

describe('CreationLayer text markup preview (F11)', () => {
  afterEach(() => {
    useUi.setState({ activeTool: 'select', toolLocked: false });
    vi.unstubAllGlobals();
  });

  it('snaps the highlight preview to the text quads and draws it where the text is on screen', async () => {
    vi.stubGlobal('requestAnimationFrame', (cb: FrameRequestCallback) => {
      cb(0);
      return 1;
    });
    vi.stubGlobal('cancelAnimationFrame', () => undefined);
    useAnnotations.setState({ apply: vi.fn(() => Promise.resolve({ upserted: [], removed: [], rev: 1 })) } as never);
    useTools.getState().setMarkup('highlight');
    useUi.setState({ activeTool: 'highlight', toolLocked: true });
    const view = render(<CreationLayer {...props} transform={{ pxPerPt: 2, rotation: 0 }} />);
    const surface = view.container.querySelector<HTMLElement>('[data-creation-layer]');
    if (surface === null) throw new Error('no layer');
    surface.getBoundingClientRect = () =>
      ({
        left: 30,
        top: 40,
        width: 1200,
        height: 1600,
        right: 1230,
        bottom: 1640,
        x: 30,
        y: 40,
        toJSON: () => '',
      }) as DOMRect;
    // Pointer at page (52, 106) to (73, 106) = client (30 + 104, 40 + 212) to (30 + 146, ...): inside chars 0 and 2.
    fireEvent.pointerDown(surface, { button: 0, clientX: 134, clientY: 252, pointerId: 1 });
    fireEvent.pointerMove(surface, { clientX: 176, clientY: 252, pointerId: 1 });
    await waitFor(() => expect(surface.querySelector('rect')).not.toBeNull());
    const rect = surface.querySelector('rect') as SVGRectElement;
    // Snapped to the characters (x 50..80, y 100..112), not to the pointer.
    expect(Number(rect.getAttribute('x'))).toBeCloseTo(50);
    expect(Number(rect.getAttribute('y'))).toBeCloseTo(100);
    expect(Number(rect.getAttribute('width'))).toBeCloseTo(30);
    expect(Number(rect.getAttribute('height'))).toBeCloseTo(12);
    // The svg is laid out so that page (50, 100) is at client (30 + 100, 40 + 200).
    const svg = surface.querySelector('svg') as SVGElement;
    const w = Number(svg.getAttribute('width'));
    const h = Number(svg.getAttribute('height'));
    expect(parseFloat(svg.style.left) + w / 2 + (50 - w / 2) * 2).toBeCloseTo(100);
    expect(parseFloat(svg.style.top) + h / 2 + (100 - h / 2) * 2).toBeCloseTo(200);
  });

  it('commits a highlight for the order of a real mouse: hover, down, moves, up, lostpointercapture, click', async () => {
    const apply = vi.fn(() => Promise.resolve({ upserted: [], removed: [], rev: 1 }));
    useAnnotations.setState({ apply } as never);
    useTools.getState().setMarkup('highlight');
    useUi.setState({ activeTool: 'highlight', toolLocked: true });
    const view = render(<CreationLayer {...props} transform={{ pxPerPt: 2, rotation: 0 }} />);
    const surface = view.container.querySelector<HTMLElement>('[data-creation-layer]');
    if (surface === null) throw new Error('no layer');
    surface.getBoundingClientRect = () =>
      ({
        left: 30,
        top: 40,
        width: 1200,
        height: 1600,
        right: 1230,
        bottom: 1640,
        x: 30,
        y: 40,
        toJSON: () => '',
      }) as DOMRect;
    const at = { pointerId: 1, pointerType: 'mouse', clientY: 252 };
    fireEvent.pointerMove(surface, { ...at, clientX: 120, buttons: 0 });
    fireEvent.pointerDown(surface, { ...at, clientX: 134, button: 0, buttons: 1 });
    for (const x of [140, 150, 160, 176]) fireEvent.pointerMove(surface, { ...at, clientX: x, buttons: 1 });
    // The release carries no buttons; the capture is lost after it, and a click follows.
    fireEvent.pointerUp(surface, { ...at, clientX: 176, button: 0, buttons: 0 });
    fireEvent.lostPointerCapture(surface, at);
    fireEvent.click(surface, { clientX: 176, clientY: 252 });
    await waitFor(() => expect(apply).toHaveBeenCalledTimes(1));
    expect(apply).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ type: 'createAnnotation', draft: expect.objectContaining({ kind: 'highlight' }) }),
    );
  });
});
