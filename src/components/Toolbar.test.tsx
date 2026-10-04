// @vitest-environment jsdom
import { act, waitFor, within } from '@testing-library/react';
import {
  Highlighter,
  LayoutGrid,
  MessageSquare,
  MousePointer2,
  PanelLeft,
  PanelRight,
  PenLine,
  ZoomIn,
  ZoomOut,
} from 'lucide-react';
import { useSyncExternalStore } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { setup } from '../test/render';
import { Toolbar, type ToolbarEntry } from './Toolbar';

interface Handlers {
  onActivate: (id: string) => void;
  onLock: (id: string) => void;
}

/** The layout of DESIGN 3.3, reduced to what the tests need. */
function layout(
  { onActivate, onLock }: Handlers,
  overrides: { draw?: { locked?: boolean }; pagesPressed?: boolean } = {},
): ToolbarEntry[] {
  return [
    {
      id: 'sidebar',
      label: 'Panels',
      items: [
        {
          id: 'left',
          label: 'Left panel',
          icon: PanelLeft,
          kind: 'toggle',
          pressed: true,
          onActivate: () => onActivate('left'),
        },
      ],
    },
    {
      id: 'select',
      label: 'Select',
      items: [
        {
          id: 'select',
          label: 'Select',
          icon: MousePointer2,
          kind: 'tool',
          pressed: true,
          shortcut: 'V',
          keyShortcuts: 'V',
          onActivate: () => onActivate('select'),
        },
      ],
    },
    {
      id: 'markup',
      label: 'Markup',
      items: [
        {
          id: 'highlight',
          label: 'Highlight',
          icon: Highlighter,
          kind: 'tool',
          pressed: false,
          onActivate: () => onActivate('highlight'),
          onLock: () => onLock('highlight'),
        },
        {
          id: 'comment',
          label: 'Comment',
          icon: MessageSquare,
          kind: 'tool',
          pressed: false,
          disabled: true,
          onActivate: () => onActivate('comment'),
        },
        {
          id: 'draw',
          label: 'Draw',
          icon: PenLine,
          kind: 'tool',
          pressed: true,
          locked: overrides.draw?.locked,
          onActivate: () => onActivate('draw'),
          onLock: () => onLock('draw'),
        },
      ],
    },
    {
      id: 'pages',
      label: 'Pages',
      items: [
        {
          id: 'pages',
          label: 'Pages',
          icon: LayoutGrid,
          kind: 'tool',
          pressed: overrides.pagesPressed ?? false,
          collapse: 1,
          onActivate: () => onActivate('pages'),
        },
      ],
    },
    { type: 'more', id: 'more' },
    { type: 'spacer', id: 'spacer' },
    {
      id: 'zoom',
      label: 'Zoom',
      items: [
        { id: 'zoom-out', label: 'Zoom out', icon: ZoomOut, collapse: 2, onActivate: () => onActivate('zoom-out') },
        {
          id: 'readout',
          label: 'Zoom level',
          text: '125 %',
          menu: [
            { id: 'fit', label: 'Fit width', onSelect: () => onActivate('fit') },
            { id: 'actual', label: 'Actual size', onSelect: () => onActivate('actual') },
          ],
        },
        { id: 'zoom-in', label: 'Zoom in', icon: ZoomIn, collapse: 3, onActivate: () => onActivate('zoom-in') },
      ],
    },
    {
      id: 'inspector',
      label: 'Inspector',
      items: [
        {
          id: 'right',
          label: 'Right panel',
          icon: PanelRight,
          kind: 'toggle',
          pressed: false,
          onActivate: () => onActivate('right'),
        },
      ],
    },
  ];
}

function Demo({ entries }: { entries: ToolbarEntry[] }) {
  return (
    <>
      <button type="button">before</button>
      <Toolbar label="Tools" entries={entries} />
      <button type="button">after</button>
    </>
  );
}

const handlers = (): Handlers => ({ onActivate: vi.fn(), onLock: vi.fn() });
const focused = () => document.activeElement?.getAttribute('aria-label') ?? document.activeElement?.textContent;

describe('Toolbar structure', () => {
  it('is a labelled toolbar with labelled groups and a divider between visible clusters', () => {
    const { getByRole, getAllByRole } = setup(<Demo entries={layout(handlers())} />);
    const toolbar = getByRole('toolbar', { name: 'Tools' });
    expect(toolbar.getAttribute('aria-orientation')).toBe('horizontal');
    expect(
      within(toolbar)
        .getAllByRole('group')
        .map((group) => group.getAttribute('aria-label')),
    ).toEqual(['Panels', 'Select', 'Markup', 'Pages', 'Zoom', 'Inspector']);
    // Panels | Select | Markup | Pages, then the spacer, then Zoom | Inspector: five clusters, but no divider across the spacer.
    // (More is absent while everything fits.)
    expect(getAllByRole('separator')).toHaveLength(4);
  });

  it('has exactly one tab stop: the first item until focus moves', () => {
    const { getByRole } = setup(<Demo entries={layout(handlers())} />);
    const items = within(getByRole('toolbar')).getAllByRole('button');
    expect(items.filter((item) => item.tabIndex === 0)).toHaveLength(1);
    expect(items[0]?.tabIndex).toBe(0);
  });

  it('shows toggle and tool state as aria-pressed and plain actions without it', () => {
    const { getByRole } = setup(<Demo entries={layout(handlers())} />);
    expect(getByRole('button', { name: 'Left panel' }).getAttribute('aria-pressed')).toBe('true');
    expect(getByRole('button', { name: 'Right panel' }).getAttribute('aria-pressed')).toBe('false');
    expect(getByRole('button', { name: 'Select' }).getAttribute('aria-pressed')).toBe('true');
    expect(getByRole('button', { name: 'Select' }).getAttribute('aria-keyshortcuts')).toBe('V');
    expect(getByRole('button', { name: 'Zoom in' }).hasAttribute('aria-pressed')).toBe(false);
  });

  it('marks a locked tool with a badge and aria-description', () => {
    const { getByRole } = setup(<Demo entries={layout(handlers(), { draw: { locked: true } })} />);
    const draw = getByRole('button', { name: 'Draw' });
    expect(draw.getAttribute('aria-description')).toBe('Locked');
    expect(draw.querySelectorAll('svg')).toHaveLength(2);
    expect(getByRole('button', { name: 'Highlight' }).hasAttribute('aria-description')).toBe(false);
  });
});

describe('Toolbar keyboard', () => {
  it('moves with Left and Right and stops at the ends', async () => {
    const { user, getByRole } = setup(<Demo entries={layout(handlers())} />);
    await user.tab();
    await user.tab();
    expect(document.activeElement).toBe(getByRole('button', { name: 'Left panel' }));
    await user.keyboard('{ArrowLeft}');
    expect(document.activeElement).toBe(getByRole('button', { name: 'Left panel' }));
    await user.keyboard('{ArrowRight}');
    expect(focused()).toBe('Select');
    await user.keyboard('{ArrowRight}');
    expect(focused()).toBe('Highlight');
    await user.keyboard('{End}');
    expect(focused()).toBe('Right panel');
    await user.keyboard('{ArrowRight}');
    expect(focused()).toBe('Right panel');
    await user.keyboard('{Home}');
    expect(focused()).toBe('Left panel');
  });

  it('keeps one tab stop that follows focus, and Shift+Tab returns to it', async () => {
    const { user, getByRole } = setup(<Demo entries={layout(handlers())} />);
    await user.tab();
    await user.tab();
    await user.keyboard('{ArrowRight}{ArrowRight}');
    expect(focused()).toBe('Highlight');
    const items = within(getByRole('toolbar')).getAllByRole('button');
    expect(items.filter((item) => item.tabIndex === 0).map((item) => item.getAttribute('aria-label'))).toEqual([
      'Highlight',
    ]);

    await user.tab();
    expect(document.activeElement).toBe(getByRole('button', { name: 'after' }));
    await user.tab({ shift: true });
    expect(focused()).toBe('Highlight');
  });

  it('activates with Enter and Space', async () => {
    const h = handlers();
    const { user } = setup(<Demo entries={layout(h)} />);
    await user.tab();
    await user.tab();
    await user.keyboard('{ArrowRight}{ArrowRight}');
    await user.keyboard('{Enter}');
    await user.keyboard(' ');
    expect(h.onActivate).toHaveBeenCalledTimes(2);
    expect(h.onActivate).toHaveBeenCalledWith('highlight');
  });

  it('locks a tool with Shift+Enter instead of activating it', async () => {
    const h = handlers();
    const { user } = setup(<Demo entries={layout(h)} />);
    await user.tab();
    await user.tab();
    await user.keyboard('{ArrowRight}{ArrowRight}');
    await user.keyboard('{Shift>}{Enter}{/Shift}');
    expect(h.onLock).toHaveBeenCalledExactlyOnceWith('highlight');
    expect(h.onActivate).not.toHaveBeenCalled();
  });

  it('keeps a disabled item focusable but inert', async () => {
    const h = handlers();
    const { user, getByRole } = setup(<Demo entries={layout(h)} />);
    await user.tab();
    await user.tab();
    await user.keyboard('{ArrowRight}{ArrowRight}{ArrowRight}');
    const comment = getByRole('button', { name: 'Comment' });
    expect(document.activeElement).toBe(comment);
    expect(comment.getAttribute('aria-disabled')).toBe('true');
    await user.keyboard('{Enter}');
    await user.click(comment);
    expect(h.onActivate).not.toHaveBeenCalled();
  });

  it('opens an item menu with ArrowDown, and Esc closes it with focus back on the item', async () => {
    const h = handlers();
    const { user, getByRole, queryByRole } = setup(<Demo entries={layout(h)} />);
    const readout = getByRole('button', { name: 'Zoom level' });
    expect(readout.textContent).toBe('125 %');
    expect(readout.getAttribute('aria-haspopup')).toBe('menu');
    readout.focus();
    await user.keyboard('{ArrowDown}');
    expect(document.activeElement).toBe(getByRole('menuitem', { name: 'Fit width' }));
    await user.keyboard('{ArrowDown}{Enter}');
    expect(h.onActivate).toHaveBeenCalledExactlyOnceWith('actual');
    await waitFor(() => expect(queryByRole('menu')).toBeNull());
    expect(document.activeElement).toBe(readout);
  });
});

describe('Toolbar pointer', () => {
  it('activates on click and passes a double click to onLock only', async () => {
    const h = handlers();
    const { user, getByRole } = setup(<Demo entries={layout(h)} />);
    await user.click(getByRole('button', { name: 'Highlight' }));
    expect(h.onActivate).toHaveBeenCalledTimes(1);
    expect(h.onLock).not.toHaveBeenCalled();

    vi.mocked(h.onActivate).mockClear();
    await user.dblClick(getByRole('button', { name: 'Highlight' }));
    expect(h.onLock).toHaveBeenCalledTimes(1);
    expect(h.onActivate).toHaveBeenCalledTimes(1); // the first click of the double click
  });

  it('lets a plain action repeat on every click', async () => {
    const h = handlers();
    const { user, getByRole } = setup(<Demo entries={layout(h)} />);
    await user.dblClick(getByRole('button', { name: 'Zoom in' }));
    expect(h.onActivate).toHaveBeenCalledTimes(2);
  });
});

describe('Toolbar overflow', () => {
  const observers: Array<() => void> = [];
  const original = {
    scrollWidth: Object.getOwnPropertyDescriptor(Element.prototype, 'scrollWidth'),
    clientWidth: Object.getOwnPropertyDescriptor(Element.prototype, 'clientWidth'),
    observer: globalThis.ResizeObserver,
  };

  /** 40 px per item; the toolbar is `width` wide. Returns a setter that changes the width and notifies observers. */
  function fakeLayout(initial: number): (width: number) => void {
    let width = initial;
    Object.defineProperty(Element.prototype, 'scrollWidth', {
      configurable: true,
      get(this: Element) {
        return this.getAttribute('role') === 'toolbar' ? this.querySelectorAll('[data-toolbar-item]').length * 40 : 0;
      },
    });
    Object.defineProperty(Element.prototype, 'clientWidth', {
      configurable: true,
      get(this: Element) {
        return this.getAttribute('role') === 'toolbar' ? width : 0;
      },
    });
    globalThis.ResizeObserver = class {
      constructor(callback: ResizeObserverCallback) {
        observers.push(() => callback([], this));
      }
      observe(): void {}
      unobserve(): void {}
      disconnect(): void {}
    };
    return (next) => {
      width = next;
      act(() => observers.forEach((notify) => notify()));
    };
  }

  afterEach(() => {
    observers.length = 0;
    for (const key of ['scrollWidth', 'clientWidth'] as const) {
      const descriptor = original[key];
      if (descriptor !== undefined) Object.defineProperty(Element.prototype, key, descriptor);
    }
    globalThis.ResizeObserver = original.observer;
  });

  it('shows everything when it fits and has no More button', () => {
    fakeLayout(400);
    const { queryByRole } = setup(<Demo entries={layout(handlers())} />);
    expect(queryByRole('button', { name: 'More' })).toBeNull();
    expect(queryByRole('button', { name: 'Pages' })).not.toBeNull();
  });

  it('moves items into More in the order of their collapse value, and keeps the rest', async () => {
    fakeLayout(360);
    const { user, getByRole, queryByRole } = setup(<Demo entries={layout(handlers())} />);
    expect(queryByRole('button', { name: 'Pages' })).toBeNull();
    expect(queryByRole('button', { name: 'Zoom out' })).toBeNull();
    expect(queryByRole('button', { name: 'Zoom in' })).not.toBeNull();
    for (const name of ['Left panel', 'Select', 'Highlight', 'Draw', 'Zoom level', 'Right panel']) {
      expect(queryByRole('button', { name })).not.toBeNull();
    }

    await user.click(getByRole('button', { name: 'More' }));
    const menu = getByRole('menu', { name: 'More' });
    expect(
      Array.from(menu.querySelectorAll('[role^="menuitem"]')).map((item) => item.getAttribute('data-label')),
    ).toEqual(['Pages', 'Zoom out']);
  });

  it('collapses further when narrower and brings everything back when wider', async () => {
    const resize = fakeLayout(360);
    const { queryByRole } = setup(<Demo entries={layout(handlers())} />);
    resize(280);
    expect(queryByRole('button', { name: 'Zoom in' })).toBeNull();
    resize(500);
    await waitFor(() => expect(queryByRole('button', { name: 'More' })).toBeNull());
    expect(queryByRole('button', { name: 'Pages' })).not.toBeNull();
    expect(queryByRole('button', { name: 'Zoom in' })).not.toBeNull();
  });

  it('lists a collapsed active tool as checked and the others as unchecked', async () => {
    fakeLayout(360);
    const { user, getByRole } = setup(<Demo entries={layout(handlers(), { pagesPressed: true })} />);
    await user.click(getByRole('button', { name: 'More' }));
    expect(getByRole('menuitemcheckbox', { name: 'Pages' }).getAttribute('aria-checked')).toBe('true');
    expect(getByRole('menuitem', { name: 'Zoom out' })).not.toBeNull();
  });

  it('runs a collapsed item from the More menu', async () => {
    fakeLayout(360);
    const h = handlers();
    const { user, getByRole } = setup(<Demo entries={layout(h)} />);
    await user.click(getByRole('button', { name: 'More' }));
    await user.click(getByRole('menuitem', { name: 'Zoom out' }));
    expect(h.onActivate).toHaveBeenCalledExactlyOnceWith('zoom-out');
  });

  it('drops the divider of a cluster that moved out completely', () => {
    fakeLayout(360);
    const { getAllByRole, getByRole } = setup(<Demo entries={layout(handlers())} />);
    const groups = within(getByRole('toolbar'))
      .getAllByRole('group')
      .map((group) => group.getAttribute('aria-label'));
    expect(groups).not.toContain('Pages');
    // Panels | Select | Markup | More  ...spacer...  Zoom | Inspector
    expect(getAllByRole('separator')).toHaveLength(4);
  });

  const tabStops = () => Array.from(document.querySelectorAll<HTMLElement>('[data-toolbar-item][tabindex="0"]'));

  it('puts More in the arrow-key order and keeps a single tab stop around it', async () => {
    fakeLayout(360);
    const { user, getByRole } = setup(<Demo entries={layout(handlers())} />);
    expect(tabStops()).toHaveLength(1);
    await user.tab();
    await user.tab();
    expect(focused()).toBe('Left panel');
    for (let presses = 0; presses < 12 && focused() !== 'More'; presses += 1) await user.keyboard('{ArrowRight}');
    expect(document.activeElement).toBe(getByRole('button', { name: 'More' }));
    // The item before More and the item after it are its neighbours; nothing is skipped.
    await user.keyboard('{ArrowLeft}');
    expect(focused()).toBe('Draw');
    await user.keyboard('{ArrowRight}{ArrowRight}');
    expect(focused()).toBe('Zoom level');
    expect(tabStops()).toHaveLength(1);
    expect(tabStops()[0]).toBe(document.activeElement);
    await user.keyboard('{End}');
    expect(focused()).toBe('Right panel');
    await user.keyboard('{Home}');
    expect(focused()).toBe('Left panel');
  });

  it('opens More with the keyboard, runs a collapsed item with Enter and returns focus to More', async () => {
    fakeLayout(360);
    const h = handlers();
    const { user, getByRole, queryByRole } = setup(<Demo entries={layout(h)} />);
    const more = getByRole('button', { name: 'More' });
    more.focus();
    await user.keyboard('{Enter}');
    expect(document.activeElement).toBe(getByRole('menuitemcheckbox', { name: 'Pages' }));
    await user.keyboard('{ArrowDown}');
    expect(document.activeElement).toBe(getByRole('menuitem', { name: 'Zoom out' }));
    await user.keyboard('{Enter}');
    expect(h.onActivate).toHaveBeenCalledExactlyOnceWith('zoom-out');
    await waitFor(() => expect(queryByRole('menu')).toBeNull());
    expect(document.activeElement).toBe(more);
  });

  it('opens More with ArrowDown or Space, and Esc closes it with focus back on More', async () => {
    fakeLayout(360);
    const { user, getByRole, queryByRole } = setup(<Demo entries={layout(handlers())} />);
    const more = getByRole('button', { name: 'More' });
    more.focus();
    await user.keyboard('{ArrowDown}');
    expect(getByRole('menu', { name: 'More' })).not.toBeNull();
    await user.keyboard('{Escape}');
    await waitFor(() => expect(queryByRole('menu')).toBeNull());
    expect(document.activeElement).toBe(more);
    await user.keyboard(' ');
    expect(getByRole('menu', { name: 'More' })).not.toBeNull();
  });

  it('reaches every item by keyboard at every width: on the toolbar, or in More', async () => {
    const everything = [
      'Left panel',
      'Select',
      'Highlight',
      'Comment',
      'Draw',
      'Pages',
      'Zoom out',
      'Zoom level',
    ].concat(['Zoom in', 'Right panel']);
    for (const width of [440, 360, 280, 200]) {
      observers.length = 0;
      fakeLayout(width);
      const { user, getByRole, queryByRole, unmount } = setup(<Demo entries={layout(handlers())} />);
      const reached = new Set<string>();
      await user.tab();
      await user.tab();
      for (let presses = 0; presses < 20; presses += 1) {
        reached.add(focused() ?? '');
        await user.keyboard('{ArrowRight}');
      }
      if (queryByRole('button', { name: 'More' }) !== null) {
        await user.click(getByRole('button', { name: 'More' }));
        for (const item of getByRole('menu').querySelectorAll('[role^="menuitem"]')) {
          reached.add(item.getAttribute('data-label') ?? '');
        }
      }
      for (const name of everything) expect(reached, `${name} at ${width} px`).toContain(name);
      unmount();
    }
  }, 30_000); // walks every width × item; slow under the full parallel suite

  it('keeps exactly one tab stop when the item that had it moves into More', async () => {
    const resize = fakeLayout(400);
    const { user, getByRole, queryByRole } = setup(<Demo entries={layout(handlers())} />);
    act(() => getByRole('button', { name: 'Pages' }).focus());
    expect(tabStops()).toEqual([getByRole('button', { name: 'Pages' })]);
    resize(360);
    expect(queryByRole('button', { name: 'Pages' })).toBeNull();
    expect(tabStops()).toEqual([getByRole('button', { name: 'Left panel' })]);
    // Tab from the button before the toolbar still lands inside it.
    getByRole('button', { name: 'before' }).focus();
    await user.tab();
    expect(focused()).toBe('Left panel');
  });

  it('lists a disabled collapsed item as aria-disabled and does not run it', async () => {
    fakeLayout(360);
    const h = handlers();
    const entries = layout(h).map((entry) =>
      entry.type === undefined && entry.id === 'pages'
        ? { ...entry, items: entry.items.map((item) => ({ ...item, disabled: true })) }
        : entry,
    );
    const { user, getByRole, queryByRole } = setup(<Demo entries={entries} />);
    await user.click(getByRole('button', { name: 'More' }));
    const pages = getByRole('menuitemcheckbox', { name: 'Pages' });
    expect(pages.getAttribute('aria-disabled')).toBe('true');
    pages.focus();
    await user.keyboard('{Enter}');
    await user.click(pages);
    expect(h.onActivate).not.toHaveBeenCalled();
    expect(queryByRole('menu')).not.toBeNull();
  });
});

describe('Toolbar disabled items', () => {
  const entries = (h: Handlers & { onOpen: (id: string) => void }): ToolbarEntry[] => [
    {
      id: 'markup',
      label: 'Markup',
      items: [
        {
          id: 'draw',
          label: 'Draw',
          icon: PenLine,
          kind: 'tool',
          pressed: false,
          disabled: true,
          onActivate: () => h.onActivate('draw'),
          onLock: () => h.onLock('draw'),
        },
        {
          id: 'readout',
          label: 'Zoom level',
          text: '125 %',
          disabled: true,
          menu: [{ id: 'fit', label: 'Fit width', onSelect: () => h.onOpen('fit') }],
        },
      ],
    },
  ];
  const setupDisabled = () => {
    const h = { ...handlers(), onOpen: vi.fn() };
    return { h, ...setup(<Demo entries={entries(h)} />) };
  };

  it('does not lock a disabled tool with Shift+Enter', async () => {
    const { h, user, getByRole } = setupDisabled();
    getByRole('button', { name: 'Draw' }).focus();
    await user.keyboard('{Shift>}{Enter}{/Shift}');
    expect(h.onLock).not.toHaveBeenCalled();
    expect(h.onActivate).not.toHaveBeenCalled();
  });

  it('does not lock a disabled tool with a double click', async () => {
    const { h, user, getByRole } = setupDisabled();
    await user.dblClick(getByRole('button', { name: 'Draw' }));
    expect(h.onLock).not.toHaveBeenCalled();
    expect(h.onActivate).not.toHaveBeenCalled();
  });

  it('does not open the menu of a disabled item with a click', async () => {
    const { user, getByRole, queryByRole } = setupDisabled();
    const readout = getByRole('button', { name: 'Zoom level' });
    expect(readout.getAttribute('aria-disabled')).toBe('true');
    await user.click(readout);
    expect(queryByRole('menu')).toBeNull();
    expect(readout.getAttribute('aria-expanded')).toBe('false');
  });

  it.each([['ArrowDown'], ['ArrowUp'], ['Enter'], ['Space']])(
    'does not open the menu of a disabled item with %s',
    async (key) => {
      const { user, getByRole, queryByRole } = setupDisabled();
      const readout = getByRole('button', { name: 'Zoom level' });
      readout.focus();
      await user.keyboard(key === 'Space' ? ' ' : `{${key}}`);
      expect(queryByRole('menu')).toBeNull();
      expect(readout.getAttribute('aria-expanded')).toBe('false');
    },
  );
});

describe('Toolbar items that follow state by themselves', () => {
  it('shows an element as the readout text and a function as the menu, which the toolbar does not have to re-render for', async () => {
    // Spies, because a render must not write to variables outside of it.
    const onToolbar = vi.fn();
    const onReadout = vi.fn();
    const store = { value: '125 %', listeners: new Set<() => void>() };
    const subscribe = (listener: () => void) => {
      store.listeners.add(listener);
      return () => store.listeners.delete(listener);
    };
    function Readout() {
      onReadout();
      return <>{useSyncExternalStore(subscribe, () => store.value)}</>;
    }
    const useMenu = () => {
      const value = useSyncExternalStore(subscribe, () => store.value);
      return [{ id: 'now', label: value, checked: true, onSelect: () => undefined }];
    };
    const entries: ToolbarEntry[] = [
      { id: 'zoom', label: 'Zoom', items: [{ id: 'readout', label: 'Zoom level', text: <Readout />, menu: useMenu }] },
    ];
    // The parent that makes the toolbar is the one a render count would reach; the entries never change.
    function Host() {
      onToolbar();
      return <Toolbar label="Tools" entries={entries} />;
    }
    const { user, getByRole } = setup(<Host />);
    const readout = getByRole('button', { name: 'Zoom level' });
    expect(readout.textContent).toBe('125 %');
    expect(readout.className).toContain('w-field');

    const before = { toolbar: onToolbar.mock.calls.length, readout: onReadout.mock.calls.length };
    act(() => {
      store.value = '150 %';
      store.listeners.forEach((listener) => listener());
    });
    expect(readout.textContent).toBe('150 %');
    expect(onToolbar).toHaveBeenCalledTimes(before.toolbar);
    expect(onReadout.mock.calls.length).toBeGreaterThan(before.readout);

    await user.click(readout);
    expect(within(getByRole('menu')).getByRole('menuitemcheckbox', { name: '150 %' })).not.toBeNull();
  });
});
