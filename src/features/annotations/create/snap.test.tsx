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

describe('CreationLayer Draw and Shapes (F19.26)', () => {
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
    useTools.setState({ draw: 'free' });
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

  it('Draw never straightens: a circle held still stays ink, nothing snaps (F19.26)', async () => {
    const surface = surfaceOf();
    draw(surface, circle);
    wait(900);
    expect(surface.querySelector('[data-snap-in]')).toBeNull();
    fireEvent.pointerUp(surface, { button: 0, clientX: 360, clientY: 300, pointerId: 1 });
    wait(1100);
    await vi.waitFor(() => expect(apply).toHaveBeenCalledTimes(1));
    expect(apply.mock.calls[0]?.[1]).toMatchObject({ type: 'createAnnotation', draft: { kind: 'ink' } });
  });

  it('Draw keeps a straight stroke as ink', async () => {
    const surface = surfaceOf();
    draw(surface, line);
    wait(600);
    fireEvent.pointerUp(surface, { button: 0, clientX: 280, clientY: 429, pointerId: 1 });
    wait(1100);
    await vi.waitFor(() => expect(apply).toHaveBeenCalledTimes(1));
    expect(apply.mock.calls[0]?.[1]).toMatchObject({ type: 'createAnnotation', draft: { kind: 'ink' } });
  });

  it('the free arrow is one ink annotation with the stroke and two arrowhead strokes', async () => {
    useTools.setState({ draw: 'arrow' });
    const surface = surfaceOf();
    draw(surface, line);
    fireEvent.pointerUp(surface, { button: 0, clientX: 280, clientY: 429, pointerId: 1 });
    wait(1100);
    await vi.waitFor(() => expect(apply).toHaveBeenCalledTimes(1));
    const command = apply.mock.calls[0]?.[1] as { draft: { kind: string; strokes: unknown[] } };
    expect(command.draft.kind).toBe('ink');
    expect(command.draft.strokes).toHaveLength(3);
  });

  it('Shapes still makes a rigid rectangle by drag', async () => {
    useUi.setState({ activeTool: 'shapes', toolLocked: false });
    useTools.setState({ shapes: 'rect' });
    const surface = surfaceOf();
    fireEvent.pointerDown(surface, { button: 0, clientX: 100, clientY: 100, pointerId: 1 });
    fireEvent.pointerMove(surface, { clientX: 220, clientY: 180, pointerId: 1 });
    fireEvent.pointerUp(surface, { button: 0, clientX: 220, clientY: 180, pointerId: 1 });
    await vi.waitFor(() => expect(apply).toHaveBeenCalledTimes(1));
    expect(apply.mock.calls[0]?.[1]).toMatchObject({ type: 'createAnnotation', draft: { kind: 'rect' } });
  });
});
