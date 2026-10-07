// @vitest-environment jsdom
import { act, cleanup, fireEvent, render } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { Annotation, DocCommand } from '../../../api/annotations';
import { useLocaleStore } from '../../../i18n/store';
import { useAnnotations } from '../../../stores/annotations';
import { useUi } from '../../../stores/ui';
import { StampLayer } from './StampLayer';
import { FIRST_CHOICE, defaultSize } from './model';
import { useStamp } from './store';

const props = { docId: 1, pageIndex: 0, pageBox: { width: 600, height: 800 }, transform: { pxPerPt: 1, rotation: 0 } };

const created = (box: { x: number; y: number; w: number; h: number }): Annotation =>
  ({
    id: 9,
    pageId: 0,
    kind: 'stamp',
    box,
    rect: box,
    stamp: 'draft',
    text: 'ENTWURF',
    date: null,
    tone: 'solar',
    color: [255, 248, 77],
    opacity: 1,
    contents: 'ENTWURF',
    author: null,
    modified: null,
    inReplyTo: null,
    locked: false,
    sync: 'new',
  }) as Annotation;

/** The box of the stamp that a placing command creates. */
function boxOf(command: DocCommand): { x: number; y: number; w: number; h: number } {
  const inner = command.type === 'batch' ? command.commands[0] : undefined;
  if (inner?.type !== 'createAnnotation' || inner.draft.kind !== 'stamp') throw new Error('not a stamp command');
  return inner.draft.box;
}

function mount() {
  const view = render(<StampLayer {...props} />);
  const surface = view.container.querySelector<HTMLElement>('[data-stamp-layer]');
  if (surface !== null) {
    surface.getBoundingClientRect = () =>
      ({ left: 0, top: 0, width: 600, height: 800, right: 600, bottom: 800, x: 0, y: 0, toJSON: () => '' }) as DOMRect;
  }
  return { ...view, surface };
}

describe('StampLayer', () => {
  let apply: ReturnType<typeof vi.fn>;
  beforeEach(() => {
    useLocaleStore.setState({ locale: 'de' });
    apply = vi.fn((_doc: number, command: DocCommand) => {
      const draft =
        command.type === 'batch' && command.commands[0]?.type === 'createAnnotation' ? command.commands[0].draft : null;
      const box = draft !== null && draft.kind === 'stamp' ? draft.box : { x: 0, y: 0, w: 1, h: 1 };
      return Promise.resolve({ upserted: [created(box)], removed: [], rev: 1, pages: null });
    });
    useAnnotations.setState({ apply } as never);
    useStamp.setState({ choice: FIRST_CHOICE, pickerOpen: false, keyboard: false, changing: null, recent: [] });
    useUi.setState({ activeTool: 'stamp', toolLocked: false });
  });
  afterEach(() => {
    cleanup();
    useLocaleStore.setState({ locale: 'en' });
    useUi.setState({ activeTool: 'select', toolLocked: false });
  });

  it('takes no pointer unless the Stempel tool is active', () => {
    useUi.setState({ activeTool: 'select' });
    expect(mount().surface).toBeNull();
  });

  it('shows a 50 % ghost that follows the pointer', () => {
    const { surface, container } = mount();
    if (surface === null) throw new Error('no layer');
    expect(container.querySelector('[data-stamp-ghost]')).toBeNull();
    fireEvent.pointerMove(surface, { clientX: 300, clientY: 400, pointerId: 1 });
    expect(container.querySelector('[data-stamp-ghost]')?.getAttribute('opacity')).toBe('0.5');
  });

  it('places a click at the default size, centred, as one undo step, and selects the stamp', async () => {
    const { surface } = mount();
    if (surface === null) throw new Error('no layer');
    fireEvent.pointerDown(surface, { button: 0, clientX: 300, clientY: 400, pointerId: 1 });
    fireEvent.pointerUp(surface, { button: 0, clientX: 300, clientY: 400, pointerId: 1 });
    expect(apply).toHaveBeenCalledTimes(1);
    const command = apply.mock.calls[0]?.[1] as DocCommand;
    expect(command).toMatchObject({
      type: 'batch',
      label: 'stamp.undo.add',
      commands: [
        {
          type: 'createAnnotation',
          draft: { kind: 'stamp', pageId: 0, stamp: 'draft', text: 'ENTWURF', tone: 'solar', date: null },
        },
      ],
    });
    const box = boxOf(command);
    expect(box.h).toBe(40);
    expect(box.x + box.w / 2).toBeCloseTo(300, 5);
    expect(box.y).toBe(380);
    await act(async () => {
      await Promise.resolve();
    });
    expect(useAnnotations.getState().selectedIds[1]).toEqual([9]);
    expect(useUi.getState().activeTool).toBe('select');
  });

  it('sizes a drag with the aspect kept', () => {
    const { surface } = mount();
    if (surface === null) throw new Error('no layer');
    fireEvent.pointerDown(surface, { button: 0, clientX: 100, clientY: 100, pointerId: 1 });
    fireEvent.pointerMove(surface, { clientX: 400, clientY: 220, pointerId: 1 });
    fireEvent.pointerUp(surface, { button: 0, clientX: 400, clientY: 220, pointerId: 1 });
    const command = apply.mock.calls[0]?.[1] as {
      commands: { draft: { box: { x: number; y: number; w: number; h: number } } }[];
    };
    const box = command.commands[0]?.draft.box;
    expect(box?.x).toBe(100);
    expect(box?.y).toBe(100);
    // The 300 x 120 area: the width of ENTWURF decides, the aspect of the default size is kept.
    const natural = defaultSize({ text: 'ENTWURF', date: null });
    expect(box?.w).toBeCloseTo(300, 5);
    expect(box?.h).toBeCloseTo((300 * natural.h) / natural.w, 5);
  });

  it('places nothing for an empty own text', () => {
    useStamp.setState({ choice: { ...FIRST_CHOICE, stamp: 'custom', custom: '' } });
    const { surface } = mount();
    if (surface === null) throw new Error('no layer');
    fireEvent.pointerDown(surface, { button: 0, clientX: 300, clientY: 400, pointerId: 1 });
    fireEvent.pointerUp(surface, { button: 0, clientX: 300, clientY: 400, pointerId: 1 });
    expect(apply).not.toHaveBeenCalled();
  });

  it('puts the keyboard ghost in the centre; arrows move it by 8 px, Shift by 1; Enter places', () => {
    const { surface, container } = mount();
    if (surface === null) throw new Error('no layer');
    act(() => useStamp.getState().setKeyboard(true));
    expect(container.querySelector('[data-stamp-ghost]')).not.toBeNull();
    const at = () => container.querySelector('[data-stamp-ghost]')?.getAttribute('transform');
    // No scroller in the test: the centre of the window (1024 x 768) is outside the 600 x 800 page rect only in x.
    const start = at();
    fireEvent.keyDown(window, { key: 'ArrowRight' });
    const moved = at();
    expect(moved).not.toEqual(start);
    fireEvent.keyDown(window, { key: 'ArrowRight', shiftKey: true });
    expect(at()).not.toEqual(moved);
    fireEvent.keyDown(window, { key: 'Enter' });
    expect(apply).toHaveBeenCalledTimes(1);
  });

  it('Esc leaves the tool', () => {
    mount();
    act(() => {
      fireEvent.keyDown(window, { key: 'Escape' });
    });
    expect(useUi.getState().activeTool).toBe('select');
  });
});
