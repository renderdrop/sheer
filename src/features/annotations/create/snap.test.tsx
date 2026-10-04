// @vitest-environment jsdom
import { act, fireEvent, render } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { DocCommand } from '../../../api/annotations';
import { useAnnotations } from '../../../stores/annotations';
import { useTools } from '../../../stores/tools';
import { useUi } from '../../../stores/ui';
import { CreationLayer } from './CreationLayer';

vi.mock('../../textlayer/cache', () => ({
  loadLayer: vi.fn(),
  peekLayer: () => undefined,
}));

const props = { docId: 1, pageIndex: 0, pageBox: { width: 600, height: 800 }, transform: { pxPerPt: 1, rotation: 0 } };

describe('CreationLayer shape recognition (F15 B11)', () => {
  let apply: ReturnType<typeof vi.fn>;
  beforeEach(() => {
    vi.useFakeTimers();
    apply = vi.fn((_doc: number, command: DocCommand) =>
      Promise.resolve({
        upserted: command.type === 'createAnnotation' && command.draft.kind === 'ink' ? [{ id: 7 }] : [],
        removed: [],
        rev: 1,
      }),
    );
    useAnnotations.setState({ apply } as never);
    useUi.setState({ activeTool: 'draw', toolLocked: false });
    useTools.setState({ recogniseShapes: true });
  });
  afterEach(() => {
    vi.useRealTimers();
    useUi.setState({ activeTool: 'select', toolLocked: false });
    useTools.setState({ recogniseShapes: true });
  });

  function surfaceOf() {
    const view = render(<CreationLayer {...props} />);
    const surface = view.container.querySelector<HTMLElement>('[data-creation-layer]');
    if (surface === null) throw new Error('no layer');
    surface.getBoundingClientRect = () =>
      ({ left: 0, top: 0, width: 600, height: 800, right: 600, bottom: 800, x: 0, y: 0, toJSON: () => '' }) as DOMRect;
    return surface;
  }

  const wait = (ms: number) =>
    act(() => {
      vi.advanceTimersByTime(ms);
    });

  /** Presses at the first point, moves along the rest, and stays pressed. */
  function draw(surface: HTMLElement, points: readonly { x: number; y: number }[]) {
    const [first, ...rest] = points;
    if (first === undefined) return;
    fireEvent.pointerDown(surface, { button: 0, clientX: first.x, clientY: first.y, pointerId: 1 });
    for (const p of rest) fireEvent.pointerMove(surface, { clientX: p.x, clientY: p.y, pointerId: 1 });
  }

  const circle = Array.from({ length: 41 }, (_, i) => ({
    x: 300 + 60 * Math.cos((i / 40) * 2 * Math.PI),
    y: 300 + 60 * Math.sin((i / 40) * 2 * Math.PI),
  }));
  const line = Array.from({ length: 31 }, (_, i) => ({ x: 100 + i * 6, y: 400 + i }));
  const scribble = Array.from({ length: 41 }, (_, i) => ({ x: 100 + (i % 2) * 90, y: 100 + i * 2 }));

  it('snaps a circle held still for 500 ms: the stroke fades out and the ellipse shows', () => {
    const surface = surfaceOf();
    draw(surface, circle);
    wait(499);
    expect(surface.querySelector('[data-snap-in]')).toBeNull();
    wait(2);
    expect(surface.querySelector('[data-snap-in] ellipse')).not.toBeNull();
    expect(surface.querySelector('[data-snap-out]')).not.toBeNull();
    // Nothing is made until release.
    expect(apply).not.toHaveBeenCalled();
  });

  it('on release makes the stroke as ink and then one step that swaps it for the real shape, so one undo gives the ink back', async () => {
    const surface = surfaceOf();
    draw(surface, circle);
    wait(520);
    fireEvent.pointerUp(surface, { button: 0, clientX: 360, clientY: 300, pointerId: 1 });
    await vi.waitFor(() => expect(apply).toHaveBeenCalledTimes(2));
    const [first, second] = apply.mock.calls.map((call) => call[1] as DocCommand);
    expect(first).toMatchObject({ type: 'createAnnotation', draft: { kind: 'ink' } });
    expect(second).toMatchObject({
      type: 'batch',
      commands: [
        { type: 'deleteAnnotations', ids: [7] },
        { type: 'createAnnotation', draft: { kind: 'ellipse', fill: null } },
      ],
    });
    // The shape has a square box: a circle.
    const batch = second as unknown as { commands: [unknown, { draft: { box: { w: number; h: number } } }] };
    expect(batch.commands[1].draft.box.w).toBeCloseTo(batch.commands[1].draft.box.h, 0);
    // No second ink annotation comes later from the join timer.
    wait(2000);
    expect(apply).toHaveBeenCalledTimes(2);
  });

  it('makes a line for a straight stroke and an arrow for one with a hook, with the stroke colour and width', async () => {
    const surface = surfaceOf();
    draw(surface, line);
    wait(520);
    expect(surface.querySelector('[data-snap-in] line')).not.toBeNull();
    fireEvent.pointerUp(surface, { button: 0, clientX: 280, clientY: 429, pointerId: 1 });
    await vi.waitFor(() => expect(apply).toHaveBeenCalledTimes(2));
    expect(apply.mock.calls[1]?.[1]).toMatchObject({
      commands: [{}, { draft: { kind: 'line', head: 'none', tail: 'none', width: 2, color: [15, 15, 15] } }],
    });
    apply.mockClear();
    const shaft = Array.from({ length: 31 }, (_, i) => ({ x: 100 + i * 6, y: 500 }));
    const hook = [
      { x: 264, y: 484 },
      { x: 280, y: 500 },
      { x: 264, y: 516 },
    ];
    draw(surface, [...shaft, ...hook]);
    wait(520);
    fireEvent.pointerUp(surface, { button: 0, clientX: 270, clientY: 510, pointerId: 1 });
    await vi.waitFor(() => expect(apply).toHaveBeenCalledTimes(2));
    expect(apply.mock.calls[1]?.[1]).toMatchObject({
      commands: [{}, { draft: { kind: 'line', head: 'openArrow', tail: 'none' } }],
    });
  });

  it('moving after the snap, before release, resizes the shape by its end point', async () => {
    const surface = surfaceOf();
    draw(surface, line);
    wait(520);
    fireEvent.pointerMove(surface, { clientX: 330, clientY: 430, pointerId: 1 });
    wait(50);
    fireEvent.pointerUp(surface, { button: 0, clientX: 330, clientY: 430, pointerId: 1 });
    await vi.waitFor(() => expect(apply).toHaveBeenCalledTimes(2));
    const batch = apply.mock.calls[1]?.[1] as unknown as {
      commands: [unknown, { draft: { from: { x: number }; to: { x: number } } }];
    };
    expect(batch.commands[1].draft.from.x).toBeCloseTo(100, 0);
    expect(batch.commands[1].draft.to.x).toBeCloseTo(330, 0);
  });

  it('moving more than 4 px starts the hold again', () => {
    const surface = surfaceOf();
    draw(surface, circle);
    wait(400);
    fireEvent.pointerMove(surface, { clientX: 372, clientY: 300, pointerId: 1 });
    wait(400);
    expect(surface.querySelector('[data-snap-in]')).toBeNull();
    // A move of 3 px does not.
    fireEvent.pointerMove(surface, { clientX: 374, clientY: 301, pointerId: 1 });
    wait(150);
    expect(surface.querySelector('[data-snap-in]')).not.toBeNull();
  });

  it('leaves a stroke that is no shape as ink', () => {
    const surface = surfaceOf();
    draw(surface, scribble);
    wait(600);
    expect(surface.querySelector('[data-snap-in]')).toBeNull();
    fireEvent.pointerUp(surface, { button: 0, clientX: 190, clientY: 180, pointerId: 1 });
    wait(1100);
    expect(apply).toHaveBeenCalledTimes(1);
    expect(apply.mock.calls[0]?.[1]).toMatchObject({ draft: { kind: 'ink' } });
  });

  it('does nothing when the setting is off', () => {
    useTools.setState({ recogniseShapes: false });
    const surface = surfaceOf();
    draw(surface, circle);
    wait(1500);
    expect(surface.querySelector('[data-snap-in]')).toBeNull();
    fireEvent.pointerUp(surface, { button: 0, clientX: 360, clientY: 300, pointerId: 1 });
    wait(1100);
    expect(apply).toHaveBeenCalledTimes(1);
    expect(apply.mock.calls[0]?.[1]).toMatchObject({ draft: { kind: 'ink' } });
  });

  it('Esc after the snap takes it back: the stroke is committed as ink, and it does not snap again', () => {
    const surface = surfaceOf();
    draw(surface, circle);
    wait(520);
    expect(surface.querySelector('[data-snap-in]')).not.toBeNull();
    act(() => {
      fireEvent.keyDown(window, { key: 'Escape' });
    });
    wait(20);
    expect(surface.querySelector('[data-snap-in]')).toBeNull();
    wait(1000);
    fireEvent.pointerUp(surface, { button: 0, clientX: 360, clientY: 300, pointerId: 1 });
    wait(1100);
    expect(apply).toHaveBeenCalledTimes(1);
    expect(apply.mock.calls[0]?.[1]).toMatchObject({ draft: { kind: 'ink' } });
  });

  it('does not recognise anything outside Zeichnen', () => {
    useUi.setState({ activeTool: 'shapes', toolLocked: true });
    const surface = surfaceOf();
    draw(surface, circle);
    wait(1000);
    expect(surface.querySelector('[data-snap-in]')).toBeNull();
  });
});
