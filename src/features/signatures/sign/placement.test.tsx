// @vitest-environment jsdom
import { act, fireEvent, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it } from 'vitest';

import { setup } from '../../../test/render';
import { CertPlacementLayer } from './CertPlacementLayer';
import { useCertSign } from './store';

const PAGE = { width: 612, height: 792 };

function place() {
  act(() => {
    useCertSign.getState().activate(null);
    useCertSign.getState().setBox({ docId: 1, pageIndex: 0, rect: { x: 100, y: 100, w: 200, h: 80 } });
  });
}
const rectNow = () => useCertSign.getState().box?.rect;
const press = (key: string, init: KeyboardEventInit = {}) =>
  act(() => {
    fireEvent.keyDown(window, { key, ...init });
  });

beforeEach(() => useCertSign.getState().reset());

describe('the seal placeholder (DESIGN 3.8 L6, AC 32)', () => {
  it('is a labelled group with 8 handles, each 8 px to see and 24 px to grab', () => {
    setup(<CertPlacementLayer docId={1} pageIndex={0} pageBox={PAGE} transform={{ pxPerPt: 2, rotation: 0 }} />);
    place();
    expect(screen.getByRole('group', { name: /Seal position/ })).not.toBeNull();
    const handles = document.querySelectorAll('[data-seal-handle]');
    expect(handles).toHaveLength(8);
    const [visual, hit] = Array.from(handles[0]?.querySelectorAll('rect') ?? []);
    expect(Number(visual?.getAttribute('width'))).toBe(4); // 8 px at 2 px per point
    expect(Number(hit?.getAttribute('width'))).toBe(12); // 24 px
  });

  it('Alt+arrows resize by 1 pt, Alt+Shift+arrows by 10 pt, never below the minimum', () => {
    setup(<CertPlacementLayer docId={1} pageIndex={0} pageBox={PAGE} transform={{ pxPerPt: 1, rotation: 0 }} />);
    place();
    press('ArrowRight', { altKey: true });
    expect(rectNow()).toEqual({ x: 100, y: 100, w: 201, h: 80 });
    press('ArrowDown', { altKey: true, shiftKey: true });
    expect(rectNow()).toEqual({ x: 100, y: 100, w: 201, h: 90 });
    for (let i = 0; i < 30; i += 1) press('ArrowLeft', { altKey: true, shiftKey: true });
    press('ArrowUp', { altKey: true, shiftKey: true });
    press('ArrowUp', { altKey: true, shiftKey: true });
    press('ArrowUp', { altKey: true, shiftKey: true });
    press('ArrowUp', { altKey: true, shiftKey: true });
    press('ArrowUp', { altKey: true, shiftKey: true });
    expect(rectNow()).toEqual({ x: 100, y: 100, w: 120, h: 40 });
  });

  it('plain arrows still move the box', () => {
    setup(<CertPlacementLayer docId={1} pageIndex={0} pageBox={PAGE} transform={{ pxPerPt: 1, rotation: 0 }} />);
    place();
    press('ArrowRight', { shiftKey: true });
    expect(rectNow()).toEqual({ x: 110, y: 100, w: 200, h: 80 });
  });
});
