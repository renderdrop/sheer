// @vitest-environment jsdom
import { act, fireEvent, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { RenderCache } from '../../engine/renderCache';
import { RenderScheduler, type RenderBackend } from '../../engine/renderScheduler';
import { useUi } from '../../stores/ui';
import { setup } from '../../test/render';
import { deletePages, dropPages, insertBlank, insertFromFile, moveByKeys, rotatePages } from './commands';
import { OrganizeGrid } from './OrganizeGrid';
import { useOrganize } from './store';

type Slot = import('./source').Slot;
type Command = import('./source').PageCommand;

const model = vi.hoisted(() => ({
  slots: [] as unknown[],
  listeners: new Set<() => void>(),
  sent: [] as unknown[],
  undone: 0,
  picks: [] as unknown[],
  next: 100,
}));

const slotsOf = (): Slot[] => model.slots as Slot[];

vi.mock('./source', async () => {
  const { useSyncExternalStore } = await import('react');
  const emit = () => model.listeners.forEach((listener) => listener());
  const make = (id: number, origin: Slot['origin'], width = 612, height = 792): Slot => ({
    id,
    width,
    height,
    rotation: 0,
    rev: 0,
    label: null,
    origin,
  });
  const apply = (command: Command): Slot[] => {
    const list = model.slots as Slot[];
    switch (command.type) {
      case 'deletePages':
        return list.filter((slot) => !command.pages.includes(slot.id));
      case 'movePages': {
        const moved = list.filter((slot) => command.pages.includes(slot.id));
        const rest = list.filter((slot) => !command.pages.includes(slot.id));
        rest.splice(command.toIndex, 0, ...moved);
        return rest;
      }
      case 'rotatePages':
        return list.map((slot) => (command.pages.includes(slot.id) ? { ...slot, rotation: 90 as const } : slot));
      case 'insertBlankPage': {
        const copy = [...list];
        copy.splice(command.at, 0, make(model.next++, 'blank', command.width, command.height));
        return copy;
      }
      case 'insertPages': {
        const copy = [...list];
        copy.splice(command.at, 0, ...command.pages.map(() => make(model.next++, 'imported')));
        return copy;
      }
    }
  };
  return {
    readSlots: () => model.slots,
    useSlots: () =>
      useSyncExternalStore(
        (listener) => {
          model.listeners.add(listener);
          return () => model.listeners.delete(listener);
        },
        () => model.slots,
      ),
    applyPageCommand: async (_docId: number, command: Command) => {
      model.sent.push(command);
      model.slots = apply(command);
      emit();
      return model.slots;
    },
    undoPageStep: async () => {
      model.undone += 1;
    },
    pickPdfSources: async () => model.picks,
    releaseSource: async () => undefined,
  };
});

const DOC = 1;
const slot = (id: number): Slot => ({ id, width: 612, height: 792, rotation: 0, rev: 0, label: null, origin: 'file' });

function load(count: number): void {
  model.slots = Array.from({ length: count }, (_, id) => slot(id));
  model.sent = [];
  model.undone = 0;
  model.picks = [];
}

class FakeResizeObserver {
  constructor(readonly callback: ResizeObserverCallback) {}
  observe(): void {
    this.callback([], this as unknown as ResizeObserver);
  }
  unobserve(): void {}
  disconnect(): void {}
}

beforeEach(() => {
  vi.stubGlobal('ResizeObserver', FakeResizeObserver);
  Object.defineProperty(HTMLElement.prototype, 'clientWidth', { configurable: true, get: () => 800 });
  Object.defineProperty(HTMLElement.prototype, 'clientHeight', { configurable: true, get: () => 600 });
  useOrganize.setState({ byDoc: {}, thumb: 160, pulse: { nonce: 0, ids: [] } });
  useUi.setState({ toast: null, banner: null, activeTool: 'pages' });
  load(6);
});

afterEach(() => {
  vi.unstubAllGlobals();
  Reflect.deleteProperty(HTMLElement.prototype, 'clientWidth');
  Reflect.deleteProperty(HTMLElement.prototype, 'clientHeight');
});

const backend = {
  render: () => new Promise(() => undefined),
  setViewport: async () => undefined,
} as unknown as RenderBackend;
const scheduler = new RenderScheduler(new RenderCache(), backend);

function renderGrid() {
  return setup(<OrganizeGrid docId={DOC} scheduler={scheduler} />);
}

const options = () => screen.getAllByRole('option');
const selectedIds = () => useOrganize.getState().byDoc[DOC]?.selected ?? [];

describe('commands', () => {
  it('acts on the selection, else on the focused page', async () => {
    useOrganize.getState().setSelection(DOC, { selected: [], focus: 2 });
    await rotatePages(DOC, 1);
    expect(model.sent[0]).toEqual({ type: 'rotatePages', pages: [2], quarterTurns: 1 });
    useOrganize.getState().setSelection(DOC, { selected: [4, 1], focus: 2 });
    await rotatePages(DOC, -1);
    expect(model.sent[1]).toEqual({ type: 'rotatePages', pages: [1, 4], quarterTurns: -1 });
  });

  it('does nothing without a target', async () => {
    expect(await rotatePages(DOC, 1)).toBe(false);
    expect(model.sent).toEqual([]);
  });

  it('deletes without asking, offers Undo, and never deletes the last page', async () => {
    useOrganize.getState().setSelection(DOC, { selected: [1, 2], focus: 1 });
    expect(await deletePages(DOC)).toBe(true);
    expect(slotsOf().map((s) => s.id)).toEqual([0, 3, 4, 5]);
    const toast = useUi.getState().toast;
    expect(toast?.message).toBe('2 pages deleted');
    toast?.action?.run();
    await Promise.resolve();
    expect(model.undone).toBe(1);
    expect(useOrganize.getState().byDoc[DOC]?.focus).toBe(3);

    useOrganize.getState().setSelection(DOC, { selected: slotsOf().map((s) => s.id) });
    model.sent = [];
    expect(await deletePages(DOC)).toBe(false);
    expect(model.sent).toEqual([]);
  });

  it('moves with the destination counted without the moved pages', async () => {
    await dropPages(DOC, [0, 1], 5);
    expect(model.sent[0]).toEqual({ type: 'movePages', pages: [0, 1], toIndex: 3 });
    expect(slotsOf().map((s) => s.id)).toEqual([2, 3, 4, 0, 1, 5]);
    model.sent = [];
    expect(await dropPages(DOC, [4], 2)).toBe(false);
    expect(model.sent).toEqual([]);
  });

  it('moves the selection by keys', async () => {
    useOrganize.getState().setSelection(DOC, { selected: [2], focus: 2 });
    expect(await moveByKeys(DOC, -1)).toBe(true);
    expect(model.sent[0]).toEqual({ type: 'movePages', pages: [2], toIndex: 1 });
    useOrganize.getState().setSelection(DOC, { selected: [0], focus: 0 });
    expect(await moveByKeys(DOC, -1)).toBe(false);
  });

  it('inserts a blank page after the focused page, sized like it, and selects and pulses it', async () => {
    model.slots = slotsOf().map((s) => (s.id === 1 ? { ...s, width: 300, height: 400 } : s));
    useOrganize.getState().setSelection(DOC, { selected: [], focus: 1 });
    await insertBlank(DOC);
    expect(model.sent[0]).toEqual({ type: 'insertBlankPage', at: 2, width: 300, height: 400 });
    const state = useOrganize.getState();
    expect(state.byDoc[DOC]?.selected).toEqual([100]);
    expect(state.pulse.ids).toEqual([100]);
  });

  it('inserts at the end without a focus, and inserts the pages of a picked file', async () => {
    useOrganize.getState().setSelection(DOC, { selected: [], focus: null });
    model.picks = [{ type: 'ready', sourceId: 7, displayName: 'b.pdf', pageCount: 2 }];
    await insertFromFile(DOC);
    expect(model.sent[0]).toEqual({ type: 'insertPages', source: 7, pages: [0, 1], at: 6 });
    expect(selectedIds()).toHaveLength(2);
  });

  it('shows a failed source in the banner, and a cancelled dialog does nothing', async () => {
    model.picks = [{ type: 'failed', code: 'not_a_pdf', key: 'error.not_a_pdf' }];
    await insertFromFile(DOC);
    expect(useUi.getState().banner?.code).toBe('not_a_pdf');
    model.picks = [];
    expect(await insertFromFile(DOC)).toBe(false);
    expect(model.sent).toEqual([]);
  });
});

describe('OrganizeGrid', () => {
  it('is a multi-selectable listbox with one option per page and one tab stop', () => {
    renderGrid();
    expect(screen.getByRole('listbox').getAttribute('aria-multiselectable')).toBe('true');
    expect(options()).toHaveLength(6);
    expect(options()[2]?.getAttribute('aria-label')).toBe('Page 3 (3 of 6)');
    expect(options().filter((o) => o.tabIndex === 0)).toHaveLength(1);
  });

  it('lays pages out in columns that fit the width', () => {
    renderGrid();
    // 800 px: padding 24 each side, cells 168 wide + 24 gap: four columns fit, so six pages make two rows.
    const x = (o: HTMLElement) => /translate\(([\d.]+)px/.exec(o.style.transform)?.[1];
    const y = (o: HTMLElement) => /, ([\d.]+)px\)/.exec(o.style.transform)?.[1];
    expect(new Set(options().map(x)).size).toBe(4);
    expect(new Set(options().map(y)).size).toBe(2);
  });

  it('selects by click, toggles with primary and ranges with Shift', async () => {
    const { user } = renderGrid();
    await user.click(options()[1] as HTMLElement);
    expect(selectedIds()).toEqual([1]);
    await user.keyboard('{Control>}');
    await user.click(options()[3] as HTMLElement);
    await user.keyboard('{/Control}');
    expect(selectedIds()).toEqual([1, 3]);
    await user.keyboard('{Shift>}');
    await user.click(options()[5] as HTMLElement);
    await user.keyboard('{/Shift}');
    expect(selectedIds()).toEqual([3, 4, 5]);
    expect(options()[4]?.getAttribute('aria-selected')).toBe('true');
  });

  it('moves the focus with the arrows, extends with Shift, toggles with Space, selects all with primary+A', async () => {
    const { user } = renderGrid();
    options()[0]?.focus();
    await user.keyboard('{ArrowRight}{ArrowRight}');
    expect(document.activeElement).toBe(options()[2]);
    await user.keyboard('{ArrowDown}');
    expect(document.activeElement).toBe(options()[5]);
    await user.keyboard('{ArrowLeft}{Shift>}{ArrowLeft}{/Shift}');
    expect(selectedIds()).toEqual([3, 4]);
    await user.keyboard(' ');
    expect(selectedIds()).toEqual([4]);
    await user.keyboard('{Control>}a{/Control}');
    expect(selectedIds()).toHaveLength(6);
  });

  it('moves the selection with Alt+arrows and deletes with Delete', async () => {
    const { user } = renderGrid();
    await user.click(options()[2] as HTMLElement);
    await user.keyboard('{Alt>}{ArrowLeft}{/Alt}');
    expect(model.sent[0]).toEqual({ type: 'movePages', pages: [2], toIndex: 1 });
    await user.keyboard('{Delete}');
    expect(model.sent[1]).toMatchObject({ type: 'deletePages', pages: [2] });
  });

  it('lifts a card and a marker on a drag, and a drop where the page already is sends nothing', async () => {
    renderGrid();
    const first = options()[0] as HTMLElement;
    fireEvent.pointerDown(first, { button: 0, clientX: 50, clientY: 50, pointerId: 1 });
    // Under the threshold nothing lifts.
    fireEvent.pointerMove(first, { clientX: 52, clientY: 50, pointerId: 1 });
    expect(document.querySelector('[data-drag-card]')).toBeNull();
    fireEvent.pointerMove(first, { clientX: 300, clientY: 50, pointerId: 1 });
    expect(document.querySelector('[data-drag-card]')).not.toBeNull();
    expect(document.querySelector('[data-insert-marker]')).not.toBeNull();
    expect(first.className).toContain('opacity-40');
    // x 300 is nearest to the gap after the dragged page itself: the order would not change.
    await act(async () => {
      fireEvent.pointerUp(first, { clientX: 300, clientY: 50, pointerId: 1 });
    });
    expect(model.sent).toHaveLength(0);
    expect(document.querySelector('[data-drag-card]')).toBeNull();
  });

  it('drops after another page', async () => {
    renderGrid();
    const first = options()[0] as HTMLElement;
    fireEvent.pointerDown(first, { button: 0, clientX: 50, clientY: 50, pointerId: 1 });
    fireEvent.pointerMove(first, { clientX: 560, clientY: 50, pointerId: 1 });
    await act(async () => {
      fireEvent.pointerUp(first, { clientX: 560, clientY: 50, pointerId: 1 });
    });
    expect(model.sent[0]).toEqual({ type: 'movePages', pages: [0], toIndex: 2 });
  });

  it('cancels a drag with Escape before the shell sees the key', () => {
    renderGrid();
    const first = options()[0] as HTMLElement;
    fireEvent.pointerDown(first, { button: 0, clientX: 50, clientY: 50, pointerId: 1 });
    fireEvent.pointerMove(first, { clientX: 560, clientY: 50, pointerId: 1 });
    expect(document.querySelector('[data-drag-card]')).not.toBeNull();
    const event = new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true });
    act(() => {
      window.dispatchEvent(event);
    });
    expect(event.defaultPrevented).toBe(true);
    expect(document.querySelector('[data-drag-card]')).toBeNull();
    fireEvent.pointerUp(first, { clientX: 560, clientY: 50, pointerId: 1 });
    expect(model.sent).toEqual([]);
  });

  it('draws a marquee on empty space and selects what it touches', () => {
    renderGrid();
    const scroller = screen.getByRole('listbox').parentElement as HTMLElement;
    fireEvent.pointerDown(scroller, { button: 0, clientX: 2, clientY: 2, pointerId: 1 });
    fireEvent.pointerMove(scroller, { clientX: 240, clientY: 60, pointerId: 1 });
    expect(document.querySelector('[data-marquee]')).not.toBeNull();
    expect(selectedIds()).toEqual([0, 1]);
    fireEvent.pointerUp(scroller, { clientX: 240, clientY: 60, pointerId: 1 });
    expect(document.querySelector('[data-marquee]')).toBeNull();
  });
});
