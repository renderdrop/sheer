// @vitest-environment jsdom
import { act, fireEvent, render, waitFor } from '@testing-library/react';
import type { ReactElement } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { setup } from '../test/render';
import { Menu, type MenuEntry } from './Menu';

afterEach(() => {
  vi.restoreAllMocks();
});

const noop = () => undefined;

/** A menu with a submenu (which has a submenu of its own), a disabled submenu and plain items around them. */
const entries = (onSelect: (id: string) => void): MenuEntry[] => [
  { id: 'open', label: 'Open', onSelect: () => onSelect('open') },
  {
    id: 'export',
    label: 'Export as',
    onSelect: () => onSelect('export'),
    submenu: [
      { id: 'png', label: 'PNG', onSelect: () => onSelect('png') },
      { id: 'jpeg', label: 'JPEG', onSelect: () => onSelect('jpeg') },
      {
        id: 'more',
        label: 'More formats',
        onSelect: noop,
        submenu: [
          { id: 'tiff', label: 'TIFF', onSelect: () => onSelect('tiff') },
          { id: 'bmp', label: 'BMP', onSelect: () => onSelect('bmp') },
        ],
      },
    ],
  },
  { id: 'props', label: 'Properties', onSelect: () => onSelect('props') },
  {
    id: 'share',
    label: 'Share',
    disabled: true,
    onSelect: noop,
    submenu: [{ id: 'mail', label: 'Mail', onSelect: () => onSelect('mail') }],
  },
];

function Demo({ onSelect = vi.fn() }: { onSelect?: (id: string) => void }) {
  return (
    <>
      <Menu label="Actions" entries={entries(onSelect)} trigger={(trigger) => <button {...trigger}>Menu</button>} />
      <button type="button">next</button>
    </>
  );
}

const focused = () => document.activeElement;

/** Opens the menu with the keyboard and moves to the item that opens the submenu. */
async function toExport(user: ReturnType<typeof setup>['user'], getByRole: ReturnType<typeof setup>['getByRole']) {
  getByRole('button', { name: 'Menu' }).focus();
  await user.keyboard('{ArrowDown}');
  await user.keyboard('{ArrowDown}');
  expect(focused()).toBe(getByRole('menuitem', { name: 'Export as' }));
}

describe('Menu submenus (DESIGN 3.5): keyboard', () => {
  it('marks an item with a submenu with aria-haspopup and aria-expanded, and shows no submenu yet', async () => {
    const { user, getByRole, queryByRole } = setup(<Demo />);
    getByRole('button', { name: 'Menu' }).focus();
    await user.keyboard('{ArrowDown}');
    const parent = getByRole('menuitem', { name: 'Export as' });
    expect(parent.getAttribute('aria-haspopup')).toBe('menu');
    expect(parent.getAttribute('aria-expanded')).toBe('false');
    expect(parent.getAttribute('aria-controls')).toBeNull();
    expect(queryByRole('menu', { name: 'Export as' })).toBeNull();
    // A plain item says nothing about submenus.
    expect(getByRole('menuitem', { name: 'Open' }).getAttribute('aria-haspopup')).toBeNull();
    expect(getByRole('menuitem', { name: 'Open' }).getAttribute('aria-expanded')).toBeNull();
  });

  it('opens on Right with the first item of the submenu focused', async () => {
    const onSelect = vi.fn();
    const { user, getByRole } = setup(<Demo onSelect={onSelect} />);
    await toExport(user, getByRole);

    await user.keyboard('{ArrowRight}');

    const submenu = getByRole('menu', { name: 'Export as' });
    const parent = getByRole('menuitem', { name: 'Export as' });
    expect(parent.getAttribute('aria-expanded')).toBe('true');
    expect(parent.getAttribute('aria-controls')).toBe(submenu.id);
    expect(focused()).toBe(getByRole('menuitem', { name: 'PNG' }));
    // The first level is still there, and opening a submenu chooses nothing.
    expect(getByRole('menu', { name: 'Actions' })).not.toBeNull();
    expect(onSelect).not.toHaveBeenCalled();
  });

  it.each([['{Enter}'], [' ']])('opens on %j like Right', async (key) => {
    const onSelect = vi.fn();
    const { user, getByRole } = setup(<Demo onSelect={onSelect} />);
    await toExport(user, getByRole);
    await user.keyboard(key);
    expect(focused()).toBe(getByRole('menuitem', { name: 'PNG' }));
    expect(onSelect).not.toHaveBeenCalled();
  });

  it('closes on Left and returns focus to the item that opened it, leaving the first level open', async () => {
    const { user, getByRole, queryByRole } = setup(<Demo />);
    await toExport(user, getByRole);
    await user.keyboard('{ArrowRight}');
    await user.keyboard('{ArrowLeft}');

    await waitFor(() => expect(queryByRole('menu', { name: 'Export as' })).toBeNull());
    const parent = getByRole('menuitem', { name: 'Export as' });
    expect(parent.getAttribute('aria-expanded')).toBe('false');
    expect(focused()).toBe(parent);
    expect(getByRole('menu', { name: 'Actions' })).not.toBeNull();
  });

  it('closes the submenu on the first Esc and the menu on the second, which focuses the trigger', async () => {
    const { user, getByRole, queryByRole, queryAllByRole } = setup(<Demo />);
    const trigger = getByRole('button', { name: 'Menu' });
    await toExport(user, getByRole);
    await user.keyboard('{ArrowRight}');

    await user.keyboard('{Escape}');
    await waitFor(() => expect(queryByRole('menu', { name: 'Export as' })).toBeNull());
    expect(getByRole('menu', { name: 'Actions' })).not.toBeNull();
    expect(focused()).toBe(getByRole('menuitem', { name: 'Export as' }));

    await user.keyboard('{Escape}');
    await waitFor(() => expect(queryAllByRole('menu')).toHaveLength(0));
    expect(focused()).toBe(trigger);
  });

  it('moves with Up, Down, Home, End and type-ahead inside the submenu only', async () => {
    const { user, getByRole } = setup(<Demo />);
    await toExport(user, getByRole);
    await user.keyboard('{ArrowRight}');
    await user.keyboard('{ArrowDown}');
    expect(focused()).toBe(getByRole('menuitem', { name: 'JPEG' }));
    await user.keyboard('{End}');
    expect(focused()).toBe(getByRole('menuitem', { name: 'More formats' }));
    await user.keyboard('{ArrowDown}');
    expect(focused()).toBe(getByRole('menuitem', { name: 'PNG' }));
    await user.keyboard('{ArrowUp}');
    expect(focused()).toBe(getByRole('menuitem', { name: 'More formats' }));
    await user.keyboard('{Home}');
    expect(focused()).toBe(getByRole('menuitem', { name: 'PNG' }));
    await user.keyboard('j');
    expect(focused()).toBe(getByRole('menuitem', { name: 'JPEG' }));
    // The first level did not move.
    expect(getByRole('menuitem', { name: 'Export as' }).getAttribute('aria-expanded')).toBe('true');
  });

  it('does nothing on Right for an item without a submenu, nor on Left in the first level', async () => {
    const { user, getByRole, queryAllByRole } = setup(<Demo />);
    getByRole('button', { name: 'Menu' }).focus();
    await user.keyboard('{ArrowDown}');
    expect(focused()).toBe(getByRole('menuitem', { name: 'Open' }));
    await user.keyboard('{ArrowRight}');
    await user.keyboard('{ArrowLeft}');
    expect(focused()).toBe(getByRole('menuitem', { name: 'Open' }));
    expect(queryAllByRole('menu')).toHaveLength(1);
  });

  it('closes the open submenu when focus moves to another item of the first level', async () => {
    const { user, getByRole } = setup(<Demo />);
    await toExport(user, getByRole);
    await user.keyboard('{ArrowRight}');
    // Back to the first level by the pointer-free route: Left, then Down.
    await user.keyboard('{ArrowLeft}');
    await user.keyboard('{ArrowRight}');
    expect(getByRole('menuitem', { name: 'Export as' }).getAttribute('aria-expanded')).toBe('true');
    // Focus the parent again (Left would close the submenu itself) and move on: it stays closed.
    await user.keyboard('{ArrowLeft}');
    await user.keyboard('{ArrowDown}');
    expect(focused()).toBe(getByRole('menuitem', { name: 'Properties' }));
    expect(getByRole('menuitem', { name: 'Export as' }).getAttribute('aria-expanded')).toBe('false');
  });

  it('chooses an item of the submenu with Enter: runs it, closes every level and focuses the trigger', async () => {
    const onSelect = vi.fn();
    const { user, getByRole, queryAllByRole } = setup(<Demo onSelect={onSelect} />);
    const trigger = getByRole('button', { name: 'Menu' });
    await toExport(user, getByRole);
    await user.keyboard('{ArrowRight}');
    await user.keyboard('{ArrowDown}');
    await user.keyboard('{Enter}');

    expect(onSelect).toHaveBeenCalledExactlyOnceWith('jpeg');
    await waitFor(() => expect(queryAllByRole('menu')).toHaveLength(0));
    expect(focused()).toBe(trigger);
  });

  it('closes everything on Tab inside the submenu and the focus moves on from the trigger', async () => {
    const { user, getByRole, queryAllByRole } = setup(<Demo />);
    await toExport(user, getByRole);
    await user.keyboard('{ArrowRight}');
    await user.tab();
    await waitFor(() => expect(queryAllByRole('menu')).toHaveLength(0));
    expect(focused()).toBe(getByRole('button', { name: 'next' }));
  });

  it('opens a submenu of a submenu, and Esc and Left close the inner one first', async () => {
    const onSelect = vi.fn();
    const { user, getByRole, queryByRole, queryAllByRole } = setup(<Demo onSelect={onSelect} />);
    await toExport(user, getByRole);
    await user.keyboard('{ArrowRight}');
    await user.keyboard('{End}');
    await user.keyboard('{ArrowRight}');
    expect(getByRole('menu', { name: 'More formats' })).not.toBeNull();
    expect(focused()).toBe(getByRole('menuitem', { name: 'TIFF' }));
    expect(queryAllByRole('menu')).toHaveLength(3);

    await user.keyboard('{ArrowLeft}');
    await waitFor(() => expect(queryByRole('menu', { name: 'More formats' })).toBeNull());
    expect(focused()).toBe(getByRole('menuitem', { name: 'More formats' }));
    expect(getByRole('menu', { name: 'Export as' })).not.toBeNull();

    await user.keyboard('{ArrowRight}');
    await user.keyboard('{Escape}');
    await waitFor(() => expect(queryByRole('menu', { name: 'More formats' })).toBeNull());
    expect(getByRole('menu', { name: 'Export as' })).not.toBeNull();

    await user.keyboard('{ArrowRight}');
    await user.keyboard('{ArrowDown}');
    await user.keyboard('{Enter}');
    expect(onSelect).toHaveBeenCalledExactlyOnceWith('bmp');
    await waitFor(() => expect(queryAllByRole('menu')).toHaveLength(0));
  });

  it('keeps a disabled submenu closed on Right, Enter and a click, but focusable', async () => {
    const onSelect = vi.fn();
    const { user, getByRole, queryAllByRole } = setup(<Demo onSelect={onSelect} />);
    getByRole('button', { name: 'Menu' }).focus();
    await user.keyboard('{End}');
    await user.keyboard('{ArrowDown}');
    await user.keyboard('{ArrowUp}');
    const share = getByRole('menuitem', { name: 'Share' });
    expect(focused()).toBe(share);
    expect(share.getAttribute('aria-disabled')).toBe('true');
    await user.keyboard('{ArrowRight}');
    await user.keyboard('{Enter}');
    await user.click(share);
    expect(queryAllByRole('menu')).toHaveLength(1);
    expect(share.getAttribute('aria-expanded')).toBe('false');
    expect(onSelect).not.toHaveBeenCalled();
  });
  it('sizes to its widest item (no cap that cuts labels) and scrolls inside when the window is short (Q7, Q9)', async () => {
    const { user, getByRole } = setup(<Demo />);
    await user.click(getByRole('button', { name: 'Menu' }));
    const menu = getByRole('menu', { name: 'Actions' });
    expect(menu.className).toContain('w-max');
    expect(menu.className).not.toContain('max-w-popover-max');
    expect(menu.className).toContain('overflow-y-auto');
  });
});

describe('Menu submenus (DESIGN 3.5): surface and pointer', () => {
  it('is a solid surface, not glass, and names itself after its item', async () => {
    const { user, getByRole } = setup(<Demo />);
    await toExport(user, getByRole);
    await user.keyboard('{ArrowRight}');
    const submenu = getByRole('menu', { name: 'Export as' });
    expect(submenu.className).toContain('bg-panel border border-border-subtle shadow-floating');
    expect(submenu.className).not.toContain('glass-');
    expect(getByRole('menu', { name: 'Actions' }).className).toContain(
      'bg-panel border border-border-subtle shadow-floating',
    );
    // A submenu in the same layer as the menu (z-popover), in the page body like the menu.
    expect(submenu.parentElement?.className).toContain('z-popover');
    expect(submenu.parentElement?.parentElement).toBe(document.body);
  });

  it('opens on a click, with focus on its first item, and a click on one of its items is no outside click', async () => {
    const onSelect = vi.fn();
    const { user, getByRole, queryAllByRole } = setup(<Demo onSelect={onSelect} />);
    await user.click(getByRole('button', { name: 'Menu' }));
    await user.click(getByRole('menuitem', { name: 'Export as' }));
    expect(focused()).toBe(getByRole('menuitem', { name: 'PNG' }));
    expect(onSelect).not.toHaveBeenCalled();

    // The press on the submenu is inside the popover: nothing closes before the click arrives.
    fireEvent.pointerDown(getByRole('menuitem', { name: 'JPEG' }));
    expect(getByRole('menuitem', { name: 'Export as' }).getAttribute('aria-expanded')).toBe('true');
    expect(queryAllByRole('menu')).toHaveLength(2);

    await user.click(getByRole('menuitem', { name: 'JPEG' }));
    expect(onSelect).toHaveBeenCalledExactlyOnceWith('jpeg');
    await waitFor(() => expect(queryAllByRole('menu')).toHaveLength(0));
  });

  it('closes every level on a click outside', async () => {
    const { user, getByRole, queryAllByRole } = setup(<Demo />);
    await toExport(user, getByRole);
    await user.keyboard('{ArrowRight}');
    expect(queryAllByRole('menu')).toHaveLength(2);
    fireEvent.pointerDown(document.body);
    await waitFor(() => expect(queryAllByRole('menu')).toHaveLength(0));
  });

  it('is placed beside its item, overlapping the panel of the menu, with its first item level with it', async () => {
    const { user, getByRole } = setup(<Demo />);
    // jsdom has no layout: the item sits at x 20..220, y 100..132 and everything else is 200 x 100.
    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (this: HTMLElement) {
      const isItem = this.getAttribute('role') === 'menuitem' && this.textContent === 'Export as';
      return isItem ? new DOMRect(20, 100, 200, 32) : new DOMRect(0, 0, 200, 100);
    });
    await toExport(user, getByRole);
    await user.keyboard('{ArrowRight}');
    const positioner = getByRole('menu', { name: 'Export as' }).parentElement as HTMLElement;
    // Right edge of the item (220), no gap; 8 px (the panel padding) above the item so the first items line up.
    expect(positioner.style.left).toBe('220px');
    expect(positioner.style.top).toBe('92px');
    expect(positioner.dataset.side).toBe('right');
  });
});

describe('Menu submenus (DESIGN 3.5): hover intent', () => {
  // Fake clock for the timers only: animation frames stay real so exit animations can finish (as in Tooltip.test.tsx).
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  const advance = (ms: number) =>
    act(() => {
      vi.advanceTimersByTime(ms);
    });
  const key = (name: string) => fireEvent.keyDown(document.activeElement ?? document.body, { key: name });

  function open(ui: ReactElement = <Demo />) {
    const rendered = render(ui);
    fireEvent.click(rendered.getByRole('button', { name: 'Menu' }));
    const item = (name: string) => rendered.getByRole('menuitem', { name });
    const expanded = (name = 'Export as') => item(name).getAttribute('aria-expanded');
    return { ...rendered, item, expanded };
  }

  it('opens only after the pointer rested for 200 ms, and does not take focus', () => {
    const { item, getByRole, queryByRole, expanded } = open();
    const before = focused();
    fireEvent.pointerEnter(item('Export as'));
    advance(199);
    expect(queryByRole('menu', { name: 'Export as' })).toBeNull();
    advance(1);
    expect(getByRole('menu', { name: 'Export as' })).not.toBeNull();
    expect(expanded()).toBe('true');
    // Hover shows the submenu and leaves the keyboard focus where it was.
    expect(focused()).toBe(before);
  });

  it('does not open when the pointer leaves before the delay is over, nor when it sweeps past', () => {
    const { item, queryByRole } = open();
    fireEvent.pointerEnter(item('Export as'));
    advance(150);
    fireEvent.pointerEnter(item('Properties'));
    advance(1000);
    expect(queryByRole('menu', { name: 'Export as' })).toBeNull();

    fireEvent.pointerEnter(item('Export as'));
    advance(150);
    fireEvent.pointerLeave(item('Export as'));
    advance(1000);
    expect(queryByRole('menu', { name: 'Export as' })).toBeNull();
  });

  it('ignores touch pointers: a tap opens the submenu with its click instead', () => {
    const { item, queryByRole, getByRole } = open();
    fireEvent.pointerOver(item('Export as'), { pointerType: 'touch' });
    advance(1000);
    expect(queryByRole('menu', { name: 'Export as' })).toBeNull();
    fireEvent.click(item('Export as'));
    expect(getByRole('menu', { name: 'Export as' })).not.toBeNull();
  });

  it('stays open for 300 ms after the pointer left the item, and entering the submenu keeps it open', () => {
    const { item, getByRole, expanded } = open();
    fireEvent.pointerEnter(item('Export as'));
    advance(200);
    fireEvent.pointerLeave(item('Export as'));
    advance(299);
    expect(expanded()).toBe('true');
    // Reaching the submenu in time cancels the closing.
    fireEvent.pointerEnter(getByRole('menu', { name: 'Export as' }).parentElement as HTMLElement);
    fireEvent.pointerEnter(item('PNG'));
    advance(2000);
    expect(expanded()).toBe('true');
    expect(getByRole('menu', { name: 'Export as' })).not.toBeNull();
  });

  it('closes 300 ms after the pointer left the item without reaching the submenu', () => {
    const { item, expanded } = open();
    fireEvent.pointerEnter(item('Export as'));
    advance(200);
    fireEvent.pointerLeave(item('Export as'));
    advance(299);
    expect(expanded()).toBe('true');
    advance(1);
    expect(expanded()).toBe('false');
  });

  it('closes 300 ms after the pointer went to another item of the first level', () => {
    const { item, expanded } = open();
    fireEvent.pointerEnter(item('Export as'));
    advance(200);
    fireEvent.pointerLeave(item('Export as'));
    fireEvent.pointerEnter(item('Properties'));
    advance(299);
    expect(expanded()).toBe('true');
    advance(1);
    expect(expanded()).toBe('false');
  });

  it('keeps the submenu when the pointer comes back to its item in time', () => {
    const { item, expanded } = open();
    fireEvent.pointerEnter(item('Export as'));
    advance(200);
    fireEvent.pointerLeave(item('Export as'));
    fireEvent.pointerEnter(item('Properties'));
    advance(200);
    fireEvent.pointerLeave(item('Properties'));
    fireEvent.pointerEnter(item('Export as'));
    advance(2000);
    expect(expanded()).toBe('true');
  });

  it('switches to the submenu of another item once the pointer rested there', async () => {
    const two: MenuEntry[] = [
      { id: 'a', label: 'A', onSelect: noop, submenu: [{ id: 'a1', label: 'A one', onSelect: noop }] },
      { id: 'b', label: 'B', onSelect: noop, submenu: [{ id: 'b1', label: 'B one', onSelect: noop }] },
    ];
    const { item, getByRole, queryByRole, expanded } = open(
      <Menu label="Two" entries={two} trigger={(trigger) => <button {...trigger}>Menu</button>} />,
    );
    fireEvent.pointerEnter(item('A'));
    advance(200);
    expect(getByRole('menu', { name: 'A' })).not.toBeNull();
    fireEvent.pointerLeave(item('A'));
    fireEvent.pointerEnter(item('B'));
    advance(200);
    expect(expanded('B')).toBe('true');
    expect(expanded('A')).toBe('false');
    await vi.waitFor(() => expect(queryByRole('menu', { name: 'A' })).toBeNull());
    expect(getByRole('menu', { name: 'B' })).not.toBeNull();
  });

  it('gives focus back to the item when the submenu closes under the pointer while focus is inside it', () => {
    const { item, expanded } = open();
    key('ArrowDown');
    key('ArrowRight');
    expect(focused()).toBe(item('PNG'));

    fireEvent.pointerEnter(item('Properties'));
    advance(300);

    expect(expanded()).toBe('false');
    expect(focused()).toBe(item('Export as'));
  });
});

describe('Menu submenus (DESIGN 3.5): edge cases', () => {
  /** A rule for every element, since jsdom does not derive `direction` from the `dir` attribute. */
  function rightToLeft() {
    const style = document.head.appendChild(document.createElement('style'));
    style.textContent = '* { direction: rtl; }';
    return () => style.remove();
  }

  it('mirrors the keys and the side in a right-to-left language: Left opens, Right closes, the submenu opens on the left', async () => {
    const undo = rightToLeft();
    try {
      const { user, getByRole, queryByRole } = setup(<Demo />);
      // jsdom has no layout: the item sits at x 400..600, y 100..132, everything else is 200 x 100.
      vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (this: HTMLElement) {
        const isItem = this.getAttribute('role') === 'menuitem' && this.textContent === 'Export as';
        return isItem ? new DOMRect(400, 100, 200, 32) : new DOMRect(0, 0, 200, 100);
      });
      await toExport(user, getByRole);

      // Right is "back" here, and on the first level there is nothing to go back to.
      await user.keyboard('{ArrowRight}');
      expect(queryByRole('menu', { name: 'Export as' })).toBeNull();
      expect(focused()).toBe(getByRole('menuitem', { name: 'Export as' }));

      await user.keyboard('{ArrowLeft}');
      expect(focused()).toBe(getByRole('menuitem', { name: 'PNG' }));
      const positioner = getByRole('menu', { name: 'Export as' }).parentElement as HTMLElement;
      expect(positioner.dataset.side).toBe('left');
      expect(positioner.style.left).toBe('200px');

      // Left in the submenu is "forward": PNG has no submenu, so it does nothing.
      await user.keyboard('{ArrowLeft}');
      expect(focused()).toBe(getByRole('menuitem', { name: 'PNG' }));

      await user.keyboard('{ArrowRight}');
      await waitFor(() => expect(queryByRole('menu', { name: 'Export as' })).toBeNull());
      expect(focused()).toBe(getByRole('menuitem', { name: 'Export as' }));
      expect(getByRole('menu', { name: 'Actions' })).not.toBeNull();
    } finally {
      undo();
    }
  });

  it('runs a checkbox item of a submenu as a checkbox: it shows its state and closes every level', async () => {
    const onSelect = vi.fn();
    const withCheckbox: MenuEntry[] = [
      {
        id: 'view',
        label: 'View',
        onSelect: noop,
        submenu: [
          { id: 'grid', label: 'Grid', checked: true, onSelect: () => onSelect('grid') },
          { id: 'rulers', label: 'Rulers', checked: false, onSelect: () => onSelect('rulers') },
        ],
      },
    ];
    const { user, getByRole, queryAllByRole } = setup(
      <Menu label="Menu" entries={withCheckbox} trigger={(trigger) => <button {...trigger}>Open</button>} />,
    );
    getByRole('button', { name: 'Open' }).focus();
    await user.keyboard('{ArrowDown}');
    await user.keyboard('{ArrowRight}');
    expect(getByRole('menuitemcheckbox', { name: 'Grid' }).getAttribute('aria-checked')).toBe('true');
    expect(getByRole('menuitemcheckbox', { name: 'Rulers' }).getAttribute('aria-checked')).toBe('false');

    await user.keyboard('{ArrowDown}');
    await user.keyboard(' ');

    expect(onSelect).toHaveBeenCalledExactlyOnceWith('rulers');
    await waitFor(() => expect(queryAllByRole('menu')).toHaveLength(0));
    expect(focused()).toBe(getByRole('button', { name: 'Open' }));
  });

  it('renders an optional leading element in the icon slot', async () => {
    const list: MenuEntry[] = [
      { id: 'a', label: 'With thumb', leading: <span data-testid="thumb" />, onSelect: noop },
      { id: 'b', label: 'Plain', onSelect: noop },
    ];
    const { user, getByRole, getByTestId } = setup(
      <Menu label="Menu" entries={list} trigger={(trigger) => <button {...trigger}>Open</button>} />,
    );
    await user.click(getByRole('button', { name: 'Open' }));
    expect(getByTestId('thumb')).toBeTruthy();
    expect(getByRole('menuitem', { name: 'With thumb' }).contains(getByTestId('thumb'))).toBe(true);
  });

  it('closes its submenu when the entries change and the item is gone, without an error', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(noop);
    const onSelect = vi.fn();
    const menu = (list: MenuEntry[]) => (
      <Menu label="Actions" entries={list} trigger={(trigger) => <button {...trigger}>Menu</button>} />
    );
    const { user, getByRole, queryByRole, rerender } = setup(menu(entries(onSelect)));
    await toExport(user, getByRole);
    await user.keyboard('{ArrowRight}');
    expect(getByRole('menu', { name: 'Export as' })).not.toBeNull();

    rerender(menu(entries(onSelect).filter((entry) => entry.id !== 'export')));

    await waitFor(() => expect(queryByRole('menu', { name: 'Export as' })).toBeNull());
    expect(queryByRole('menuitem', { name: 'Export as' })).toBeNull();
    expect(getByRole('menu', { name: 'Actions' })).not.toBeNull();
    expect(error).not.toHaveBeenCalled();
  });
});

describe('Menu submenus (DESIGN 3.5): edge cases of the hover', () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  const advance = (ms: number) =>
    act(() => {
      vi.advanceTimersByTime(ms);
    });
  const key = (name: string) => fireEvent.keyDown(document.activeElement ?? document.body, { key: name });

  function open() {
    const rendered = render(<Demo />);
    fireEvent.click(rendered.getByRole('button', { name: 'Menu' }));
    const item = (name: string) => rendered.getByRole('menuitem', { name });
    return { ...rendered, item };
  }

  it('closes only the submenu on Esc when the pointer opened it, and focus goes to its item', async () => {
    const { item, queryByRole, queryAllByRole, getByRole } = open();
    // A click opens the menu with focus on its first item.
    key('ArrowDown');
    expect(focused()).toBe(item('Export as'));
    fireEvent.pointerEnter(item('Export as'));
    advance(200);
    expect(getByRole('menu', { name: 'Export as' })).not.toBeNull();
    // Hover did not move focus: it is still on the item, which is where Esc returns it.
    expect(focused()).toBe(item('Export as'));

    key('Escape');
    await vi.waitFor(() => expect(queryByRole('menu', { name: 'Export as' })).toBeNull());
    expect(getByRole('menu', { name: 'Actions' })).not.toBeNull();
    expect(item('Export as').getAttribute('aria-expanded')).toBe('false');
    expect(focused()).toBe(item('Export as'));

    key('Escape');
    await vi.waitFor(() => expect(queryAllByRole('menu')).toHaveLength(0));
  });

  it('moves focus into a submenu that the pointer opened when Right is pressed on its item', () => {
    const { item, queryAllByRole } = open();
    // A click opens the menu with focus on its first item.
    key('ArrowDown');
    fireEvent.pointerEnter(item('Export as'));
    advance(200);
    expect(focused()).toBe(item('Export as'));

    key('ArrowRight');

    expect(focused()).toBe(item('PNG'));
    // The same submenu, not a second one.
    expect(queryAllByRole('menu')).toHaveLength(2);
  });

  it('opens no submenu when the menu closed while the pointer was still resting on the item', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(noop);
    const { item, queryByRole, queryAllByRole } = open();
    fireEvent.pointerEnter(item('Export as'));
    advance(100);

    key('Escape');
    advance(500);
    await vi.waitFor(() => expect(queryAllByRole('menu')).toHaveLength(0));
    advance(500);

    expect(queryByRole('menu', { name: 'Export as' })).toBeNull();
    expect(error).not.toHaveBeenCalled();
  });
});

describe('Menu inside a modal (DESIGN 3.9 Q8)', () => {
  it('renders in the layer above the modal and an item click fires', async () => {
    const onSelect = vi.fn();
    const { user, getByRole } = setup(
      <div role="dialog" aria-modal="true" aria-label="Dialog" className="z-modal">
        <Demo onSelect={onSelect} />
      </div>,
    );
    await user.click(getByRole('button', { name: 'Menu' }));
    const menu = getByRole('menu', { name: 'Actions' });
    expect(menu.parentElement?.className).toContain('z-modal-popover');
    expect(menu.parentElement?.className).not.toMatch(/\bz-popover\b/);
    await user.click(getByRole('menuitem', { name: 'Open' }));
    expect(onSelect).toHaveBeenCalledWith('open');
  });

  it('keeps z-popover outside a modal', async () => {
    const { user, getByRole } = setup(<Demo />);
    await user.click(getByRole('button', { name: 'Menu' }));
    expect(getByRole('menu', { name: 'Actions' }).parentElement?.className).toContain('z-popover');
  });
});

describe('Menu disabled reason', () => {
  const list: MenuEntry[] = [
    { id: 'a', label: 'Recognize', disabled: true, reason: 'Wait until it finishes.', onSelect: noop },
    { id: 'b', label: 'Save', reason: 'Never shown while enabled', onSelect: noop },
  ];

  it('shows the reason as a second line and as the description of a disabled item only', async () => {
    const { user, getByRole } = setup(
      <Menu label="Menu" entries={list} trigger={(trigger) => <button {...trigger}>Open</button>} />,
    );
    await user.click(getByRole('button', { name: 'Open' }));
    const disabled = getByRole('menuitem', { name: /Recognize/ });
    expect(disabled.getAttribute('aria-disabled')).toBe('true');
    expect(disabled.getAttribute('aria-description')).toBe('Wait until it finishes.');
    expect(disabled.textContent).toContain('Wait until it finishes.');
    const enabled = getByRole('menuitem', { name: 'Save' });
    expect(enabled.hasAttribute('aria-description')).toBe(false);
    expect(enabled.textContent).toBe('Save');
  });
});
