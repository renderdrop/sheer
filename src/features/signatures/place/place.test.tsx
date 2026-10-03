// @vitest-environment jsdom
import { act, fireEvent, render } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { Annotation, DocCommand } from '../../../api/annotations';
import { useAnnotations } from '../../../stores/annotations';
import { useUi } from '../../../stores/ui';
import { forgetAssets } from './assets';
import { centredBox, dateText, itemSize, markDraft, signatureDraft, textDraft } from './drafts';
import { markGeometry } from './marks';
import { placeItem } from './place';
import { PlacementLayer } from './PlacementLayer';
import { usePlacement, type PlaceItem } from './store';

const useSignature = vi.hoisted(() => vi.fn());
vi.mock('../../../api/signatures', async (original) => ({
  ...(await original<typeof import('../../../api/signatures')>()),
  useSignature,
}));

const PAGE = [600, 800] as const;
const SIGNATURE: PlaceItem = {
  type: 'signature',
  role: 'signature',
  ref: { type: 'library', id: 'a'.repeat(32) },
  aspect: 3,
};

describe('sizes and drafts', () => {
  it('uses the default sizes of DESIGN 3.34', () => {
    expect(itemSize(SIGNATURE, PAGE)).toEqual({ w: 108, h: 36 });
    expect(itemSize({ ...SIGNATURE, role: 'initials', aspect: 1 } as PlaceItem, PAGE)).toEqual({ w: 24, h: 24 });
    expect(itemSize({ type: 'mark', glyph: 'dot' }, PAGE)).toEqual({ w: 12, h: 12 });
    expect(itemSize({ type: 'text' }, PAGE).w).toBe(160);
  });

  it('shrinks a very wide signature to the page and keeps its aspect', () => {
    const size = itemSize({ ...SIGNATURE, aspect: 50 } as PlaceItem, PAGE);
    expect(size.w).toBeLessThanOrEqual(600);
    expect(size.w / size.h).toBeCloseTo(50);
  });

  it('centres on the pointer and stays inside the page', () => {
    expect(centredBox({ x: 100, y: 100 }, { w: 40, h: 20 }, PAGE)).toEqual({ x: 80, y: 90, w: 40, h: 20 });
    expect(centredBox({ x: 0, y: 800 }, { w: 40, h: 20 }, PAGE)).toEqual({ x: 0, y: 780, w: 40, h: 20 });
  });

  it('formats the date with the system locale as fixed text', () => {
    const text = dateText(new Date(2026, 9, 3));
    expect(text).toBe(new Intl.DateTimeFormat(undefined, { dateStyle: 'medium' }).format(new Date(2026, 9, 3)));
    expect(text).toContain('2026');
  });

  it('makes drafts of the right kind', () => {
    const box = { x: 1, y: 2, w: 3, h: 4 };
    expect(markDraft(0, box, 'check')).toMatchObject({ kind: 'mark', glyph: 'check' });
    expect(textDraft(0, box, ['x'])).toMatchObject({ kind: 'freeText', fontSize: 12, lines: ['x'] });
    expect(signatureDraft(0, box, 'initials', { assetId: 4, aspect: 2 }, 'blue')).toMatchObject({
      kind: 'signature',
      role: 'initials',
      art: { type: 'asset', assetId: 4, aspect: 2 },
      color: [0, 114, 178],
    });
  });

  it('draws marks inside their box', () => {
    const box = { x: 10, y: 10, w: 12, h: 12 };
    expect(markGeometry('dot', box)).toMatchObject({ type: 'dot', cx: 16, cy: 16 });
    const cross = markGeometry('cross', box);
    expect(cross.type === 'lines' && cross.lines).toHaveLength(2);
  });
});

describe('placeItem', () => {
  let apply: ReturnType<typeof vi.fn>;
  beforeEach(() => {
    forgetAssets();
    useSignature.mockReset();
    useSignature.mockResolvedValue({ assetId: 7, aspect: 3, art: { type: 'vector', w: 3000, h: 1000, paths: [] } });
    apply = vi.fn((_doc: number, command: DocCommand) =>
      Promise.resolve({
        upserted: command.type === 'createAnnotation' ? [{ id: 9, kind: command.draft.kind } as Annotation] : [],
        removed: [],
        rev: 1,
      }),
    );
    useAnnotations.setState({ apply } as never);
  });

  it('places a signature with one create command, copying the art once', async () => {
    const created = await placeItem(1, 0, SIGNATURE, { x: 300, y: 400 }, PAGE);
    await placeItem(1, 0, SIGNATURE, { x: 300, y: 400 }, PAGE);
    expect(created?.id).toBe(9);
    expect(useSignature).toHaveBeenCalledTimes(1);
    expect(apply).toHaveBeenCalledTimes(2);
    expect(apply.mock.calls[0]?.[1]).toMatchObject({
      type: 'createAnnotation',
      draft: { kind: 'signature', pageId: 0, box: { x: 246, y: 382, w: 108, h: 36 }, art: { assetId: 7 } },
    });
  });

  it('places a date as fixed text and a mark as a mark', async () => {
    await placeItem(1, 2, { type: 'date' }, { x: 100, y: 100 }, PAGE, new Date(2026, 0, 2));
    await placeItem(1, 2, { type: 'mark', glyph: 'cross' }, { x: 100, y: 100 }, PAGE);
    expect(apply.mock.calls[0]?.[1]).toMatchObject({ draft: { kind: 'freeText', pageId: 2 } });
    expect((apply.mock.calls[0]?.[1] as { draft: { lines: string[] } }).draft.lines[0]).toContain('2026');
    expect(apply.mock.calls[1]?.[1]).toMatchObject({ draft: { kind: 'mark', glyph: 'cross' } });
  });

  it('reports a refusal and creates nothing', async () => {
    useSignature.mockRejectedValue({ code: 'not_found', message: 'x' });
    expect(await placeItem(1, 0, SIGNATURE, { x: 1, y: 1 }, PAGE)).toBeNull();
    expect(apply).not.toHaveBeenCalled();
    expect(useUi.getState().banner).not.toBeNull();
    useUi.getState().dismissBanner();
  });
});

describe('PlacementLayer', () => {
  const props = {
    docId: 1,
    pageIndex: 0,
    pageBox: { width: 600, height: 800 },
    transform: { pxPerPt: 1, rotation: 0 },
  };
  let apply: ReturnType<typeof vi.fn>;

  function mount() {
    const view = render(<PlacementLayer {...props} />);
    const surface = view.container.querySelector<HTMLElement>('[data-placement-layer]');
    if (surface !== null) {
      surface.getBoundingClientRect = () =>
        ({
          left: 0,
          top: 0,
          width: 600,
          height: 800,
          right: 600,
          bottom: 800,
          x: 0,
          y: 0,
          toJSON: () => '',
        }) as DOMRect;
    }
    return { ...view, surface };
  }

  beforeEach(() => {
    apply = vi.fn(() => Promise.resolve({ upserted: [], removed: [], rev: 1 }));
    useAnnotations.setState({ apply } as never);
    useUi.setState({ activeTool: 'signature', toolLocked: false });
    usePlacement.getState().disarm();
  });
  afterEach(() => {
    useUi.setState({ activeTool: 'select', toolLocked: false });
  });

  it('takes no pointer without an armed item or the tool', () => {
    expect(mount().surface).toBeNull();
    usePlacement.getState().arm({ type: 'text' });
    useUi.setState({ activeTool: 'select' });
    expect(mount().surface).toBeNull();
  });

  it('shows a ghost and places on click, then leaves the tool', async () => {
    usePlacement.getState().arm({ type: 'mark', glyph: 'check' });
    const { surface, container } = mount();
    if (surface === null) throw new Error('no layer');
    fireEvent.pointerMove(surface, { clientX: 100, clientY: 100 });
    expect(container.querySelector('svg polyline')).not.toBeNull();
    await act(async () => {
      fireEvent.pointerDown(surface, { button: 0, clientX: 100, clientY: 100, pointerId: 1 });
    });
    expect(apply).toHaveBeenCalledTimes(1);
    expect(apply.mock.calls[0]?.[1]).toMatchObject({
      draft: { kind: 'mark', box: { x: 94, y: 94, w: 12, h: 12 } },
    });
    expect(useUi.getState().activeTool).toBe('select');
    expect(usePlacement.getState().item).toBeNull();
  });

  it('keeps the item armed when the tool is locked, and Esc disarms', async () => {
    useUi.setState({ toolLocked: true });
    usePlacement.getState().arm({ type: 'mark', glyph: 'dot' });
    const { surface } = mount();
    if (surface === null) throw new Error('no layer');
    await act(async () => {
      fireEvent.pointerDown(surface, { button: 0, clientX: 10, clientY: 10, pointerId: 1 });
    });
    expect(usePlacement.getState().item).not.toBeNull();
    fireEvent.keyDown(window, { key: 'Escape' });
    expect(usePlacement.getState().item).toBeNull();
    expect(useUi.getState().activeTool).toBe('select');
  });

  it.each([
    { name: 'a scrolled page', region: [0, 0, 200, 200], surface: [0, -300, 600, 800], box: { x: 94, y: 394 } },
    {
      name: 'an offset scroller and page',
      region: [100, 50, 300, 200],
      surface: [50, 20, 600, 800],
      box: { x: 194, y: 124 },
    },
  ])(
    'places on Enter at the centre of the visible scroller ($name), with the item armed at that time',
    async ({ region: r, surface: p, box }) => {
      usePlacement.getState().arm({ type: 'mark', glyph: 'check' });
      const rect = (left: number, top: number, width: number, height: number) =>
        ({
          left,
          top,
          width,
          height,
          right: left + width,
          bottom: top + height,
          x: left,
          y: top,
          toJSON: () => '',
        }) as DOMRect;
      const region = document.createElement('div');
      region.setAttribute('role', 'region');
      region.getBoundingClientRect = () => rect(r[0] ?? 0, r[1] ?? 0, r[2] ?? 0, r[3] ?? 0);
      document.body.append(region);
      const view = render(<PlacementLayer {...props} />, {
        container: region.appendChild(document.createElement('div')),
      });
      const surface = view.container.querySelector<HTMLElement>('[data-placement-layer]');
      if (surface === null) throw new Error('no layer');
      surface.getBoundingClientRect = () => rect(p[0] ?? 0, p[1] ?? 0, p[2] ?? 0, p[3] ?? 0);
      // The window centre (jsdom 1024x768 -> 512, 384) is on the page too, but the visible rect of the scroller wins: its own centre, mapped into the page (see the box of each case).
      await act(async () => {
        fireEvent.keyDown(window, { key: 'Enter' });
      });
      expect(apply).toHaveBeenCalledTimes(1);
      expect(apply.mock.calls[0]?.[1]).toMatchObject({ draft: { kind: 'mark', box } });
      region.remove();
    },
  );

  it('drops the item when another tool is chosen', () => {
    usePlacement.getState().arm({ type: 'text' });
    act(() => useUi.setState({ activeTool: 'draw' }));
    expect(usePlacement.getState().item).toBeNull();
  });
});
