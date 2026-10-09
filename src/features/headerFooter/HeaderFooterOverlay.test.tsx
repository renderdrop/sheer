// @vitest-environment jsdom
import { act, render } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { ChangeSet } from '../../api/annotations';
import type { HeaderFooterInfo, HfSpec, ResolvedPage } from '../../api/headerFooter';
import { useAnnotations } from '../../stores/annotations';
import { HeaderFooterOverlay } from './HeaderFooterOverlay';
import { forgetHeaderFooter } from './overlayStore';

const api = vi.hoisted(() => ({ getHeaderFooter: vi.fn(), resolveHeaderFooter: vi.fn() }));
vi.mock('../../api/headerFooter', async (original) => ({
  ...(await original<typeof import('../../api/headerFooter')>()),
  getHeaderFooter: api.getHeaderFooter,
  resolveHeaderFooter: api.resolveHeaderFooter,
}));

const spec = { color: [10, 20, 30] } as unknown as HfSpec;
const info = (pending: boolean): HeaderFooterInfo => ({
  spec,
  defaults: spec,
  pending,
  fileLayers: 0,
  refusal: null,
});
const page = (pageId: number, underFileLayer = false): ResolvedPage => ({
  pageId,
  underFileLayer,
  runs: [{ text: 'Page 1 of 3', origin: { x: 20, y: 30 }, angle: 0, size: 10, width: 50 }],
});
const change = (rev: number, dirty: boolean, doc: ChangeSet['doc'] = ['headerFooter']): ChangeSet => ({
  rev,
  upserted: [],
  removed: [],
  pages: null,
  doc,
  history: { canUndo: dirty, canRedo: false, undoLabel: null, redoLabel: null, dirty },
});

const props = (pageIndex: number) => ({
  docId: 7,
  pageIndex,
  boxWidth: 100,
  boxHeight: 200,
  widthPt: 100,
  heightPt: 200,
  rotation: 0,
  ready: true,
});
const settle = () => act(async () => void (await new Promise((resolve) => setTimeout(resolve, 0))));

beforeEach(() => {
  api.getHeaderFooter.mockReset();
  api.resolveHeaderFooter.mockReset();
});
afterEach(() => forgetHeaderFooter(7));

describe('HeaderFooterOverlay', () => {
  it('draws the pending runs, non-interactive and hidden from assistive technology', async () => {
    api.getHeaderFooter.mockResolvedValue(info(true));
    api.resolveHeaderFooter.mockResolvedValue([page(0)]);
    const { container } = render(<HeaderFooterOverlay {...props(0)} />);
    await settle();
    const layer = container.querySelector('[data-hf-overlay]');
    expect(layer?.getAttribute('aria-hidden')).toBe('true');
    expect(layer?.className).toContain('pointer-events-none');
    expect(layer?.textContent).toBe('Page 1 of 3');
    expect(api.resolveHeaderFooter).toHaveBeenCalledWith(7, null, [0]);
  });

  it('covers what is under each run with the background box in the page colour only when the spec asks', async () => {
    api.getHeaderFooter.mockResolvedValue(info(true));
    api.resolveHeaderFooter.mockResolvedValue([page(0)]);
    const plain = render(<HeaderFooterOverlay {...props(0)} />);
    await settle();
    expect(plain.container.querySelector('[data-hf-background]')).toBeNull();
    plain.unmount();
    forgetHeaderFooter(7);

    api.getHeaderFooter.mockResolvedValue({ ...info(true), spec: { ...spec, background: true } });
    const { container } = render(<HeaderFooterOverlay {...props(0)} />);
    await settle();
    const box = container.querySelector<HTMLElement>('[data-hf-background]');
    expect(box?.className).toContain('bg-page');
    // size 10 at the baseline y 30: full glyph box (0.931 em up, 0.225 em down) plus 3 pt, from x 17 over 50 + 6 pt
    expect(parseFloat(box?.style.left ?? '')).toBeCloseTo(17);
    expect(parseFloat(box?.style.top ?? '')).toBeCloseTo(30 - 9.31 - 3);
    expect(parseFloat(box?.style.width ?? '')).toBeCloseTo(56);
    expect(parseFloat(box?.style.height ?? '')).toBeCloseTo(9.31 + 2.25 + 6);
    // behind the text: drawn first
    expect(container.querySelector('[data-hf-overlay]')?.firstElementChild).toBe(box);
  });

  it('skips a page whose engine copy still shows a layer of the file', async () => {
    api.getHeaderFooter.mockResolvedValue(info(true));
    api.resolveHeaderFooter.mockResolvedValue([page(1, true)]);
    const { container } = render(<HeaderFooterOverlay {...props(1)} />);
    await settle();
    expect(container.querySelector('[data-hf-overlay]')).toBeNull();
  });

  it('clears after the save and draws again after an undo of the change', async () => {
    api.getHeaderFooter.mockResolvedValue(info(true));
    api.resolveHeaderFooter.mockResolvedValue([page(2)]);
    const { container } = render(<HeaderFooterOverlay {...props(2)} />);
    await settle();
    expect(container.querySelector('[data-hf-overlay]')).not.toBeNull();

    // The save: the file has the layer, nothing is pending, the document is clean.
    api.getHeaderFooter.mockResolvedValue(info(false));
    act(() => useAnnotations.getState().applyChanges(7, change(1, false, undefined)));
    await settle();
    expect(container.querySelector('[data-hf-overlay]')).toBeNull();

    // Undo/redo brings a pending change back.
    api.getHeaderFooter.mockResolvedValue(info(true));
    act(() => useAnnotations.getState().applyChanges(7, change(2, true)));
    await settle();
    expect(container.querySelector('[data-hf-overlay]')).not.toBeNull();
  });
});
