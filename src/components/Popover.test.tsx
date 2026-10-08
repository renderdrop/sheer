// @vitest-environment jsdom
import { act, fireEvent, waitFor } from '@testing-library/react';
import { Plus } from 'lucide-react';
import { useState, useSyncExternalStore } from 'react';
import { describe, expect, it, vi } from 'vitest';

import { openTooltip, setup } from '../test/render';
import { IconButton } from './IconButton';
import { Menu, type MenuEntry } from './Menu';
import { Popover, type PopoverProps } from './Popover';
import { Slider } from './Slider';

function Demo(props: Partial<PopoverProps>) {
  return (
    <>
      <button type="button">before</button>
      <Popover label="Zoom" trigger={(trigger) => <button {...trigger}>Open</button>} {...props}>
        <input aria-label="Value" />
        <button type="button">Apply</button>
      </Popover>
      <button type="button">after</button>
    </>
  );
}

const closed = (query: () => unknown) => waitFor(() => expect(query()).toBeNull());

describe('Popover (dialog)', () => {
  it('opens from the trigger, names itself and moves focus to its first control', async () => {
    const { user, getByRole, queryByRole } = setup(<Demo />);
    const trigger = getByRole('button', { name: 'Open' });
    expect(trigger.getAttribute('aria-haspopup')).toBe('dialog');
    expect(trigger.getAttribute('aria-expanded')).toBe('false');
    expect(queryByRole('dialog')).toBeNull();

    await user.click(trigger);
    const dialog = getByRole('dialog', { name: 'Zoom' });
    expect(trigger.getAttribute('aria-expanded')).toBe('true');
    expect(trigger.getAttribute('aria-controls')).toBe(dialog.id);
    expect(document.activeElement).toBe(getByRole('textbox', { name: 'Value' }));
  });

  it('sits below the banner slot instead of covering a banner', async () => {
    const rect = (left: number, top: number, width: number, height: number): DOMRect =>
      new DOMRect(left, top, width, height);
    const spy = vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (
      this: HTMLElement,
    ) {
      if (this.dataset.region === 'banner') return rect(0, 48, 600, 200);
      if (this.tagName === 'BUTTON' && this.textContent === 'Open') return rect(10, 10, 80, 30);
      return rect(0, 0, 100, 60);
    });
    try {
      const { user, getByRole, getByTestId } = setup(
        <>
          <div data-region="banner" data-testid="banner" />
          <Demo />
        </>,
      );
      await user.click(getByRole('button', { name: 'Open' }));
      const positioner = document.querySelector<HTMLElement>('[data-side]');
      expect(getByTestId('banner')).toBeTruthy();
      expect(Number.parseFloat(positioner?.style.top ?? '0')).toBeGreaterThanOrEqual(48 + 200);
    } finally {
      spy.mockRestore();
    }
  });

  it('closes on Esc and returns focus to the trigger', async () => {
    const { user, getByRole, queryByRole } = setup(<Demo />);
    const trigger = getByRole('button', { name: 'Open' });
    await user.click(trigger);
    await user.keyboard('{Escape}');
    await closed(() => queryByRole('dialog'));
    expect(trigger.getAttribute('aria-expanded')).toBe('false');
    expect(document.activeElement).toBe(trigger);
  });

  it('toggles closed when the trigger is used again', async () => {
    const { user, getByRole, queryByRole } = setup(<Demo />);
    const trigger = getByRole('button', { name: 'Open' });
    await user.click(trigger);
    await user.click(trigger);
    await closed(() => queryByRole('dialog'));
    expect(document.activeElement).toBe(trigger);
  });

  it('closes on an outside click and gives focus to the trigger when nothing else took it', async () => {
    const { user, getByRole, queryByRole } = setup(<Demo />);
    const trigger = getByRole('button', { name: 'Open' });
    await user.click(trigger);
    fireEvent.pointerDown(document.body);
    await closed(() => queryByRole('dialog'));
    await waitFor(() => expect(document.activeElement).toBe(trigger));
  });

  it('leaves focus where an outside click put it', async () => {
    const { user, getByRole, queryByRole } = setup(<Demo />);
    await user.click(getByRole('button', { name: 'Open' }));
    await user.click(getByRole('button', { name: 'after' }));
    await closed(() => queryByRole('dialog'));
    expect(document.activeElement).toBe(getByRole('button', { name: 'after' }));
  });

  it('does not close on a click inside', async () => {
    const { user, getByRole } = setup(<Demo />);
    await user.click(getByRole('button', { name: 'Open' }));
    await user.click(getByRole('button', { name: 'Apply' }));
    expect(getByRole('dialog')).not.toBeNull();
  });

  it('cycles Tab inside the dialog', async () => {
    const { user, getByRole } = setup(<Demo />);
    await user.click(getByRole('button', { name: 'Open' }));
    const input = getByRole('textbox');
    const apply = getByRole('button', { name: 'Apply' });
    expect(document.activeElement).toBe(input);
    await user.tab();
    expect(document.activeElement).toBe(apply);
    await user.tab();
    expect(document.activeElement).toBe(input);
    await user.tab({ shift: true });
    expect(document.activeElement).toBe(apply);
  });

  describe('with a roving group inside (one tab stop, the other members at tabindex -1)', () => {
    /** The group is last in the DOM and its last member is no tab stop, the way the settings popover ends. */
    function WithGroup({ checked = 1 }: { checked?: number }) {
      return (
        <>
          <Popover label="Zoom" trigger={(trigger) => <button {...trigger}>Open</button>}>
            <button type="button">Reset</button>
            <div role="radiogroup" aria-label="Mode">
              {['a', 'b', 'c'].map((name, index) => (
                <button
                  key={name}
                  type="button"
                  role="radio"
                  aria-checked={index === checked}
                  tabIndex={index === checked ? 0 : -1}
                >
                  {name}
                </button>
              ))}
            </div>
          </Popover>
          <button type="button">after</button>
        </>
      );
    }

    it('wraps Tab from the last tab stop to the first, though the last button in the DOM is no tab stop', async () => {
      const { user, getByRole } = setup(<WithGroup />);
      await user.click(getByRole('button', { name: 'Open' }));
      expect(document.activeElement).toBe(getByRole('button', { name: 'Reset' }));
      await user.tab();
      expect(document.activeElement).toBe(getByRole('radio', { name: 'b' }));
      // The last button in the DOM is "c" (tabindex -1): the browser would leave the popover from "b", the trap keeps it in.
      await user.tab();
      expect(document.activeElement).toBe(getByRole('button', { name: 'Reset' }));
    });

    it('wraps Shift+Tab from the first tab stop to the last one, not to a member at tabindex -1', async () => {
      const { user, getByRole } = setup(<WithGroup checked={0} />);
      await user.click(getByRole('button', { name: 'Open' }));
      await user.tab({ shift: true });
      expect(document.activeElement).toBe(getByRole('radio', { name: 'a' }));
      await user.tab({ shift: true });
      expect(document.activeElement).toBe(getByRole('button', { name: 'Reset' }));
    });

    it('starts on the first tab stop: the chosen member of a group that comes first, not its first button', async () => {
      const { user, getByRole } = setup(
        <Popover label="Mode" trigger={(trigger) => <button {...trigger}>Open</button>}>
          <div role="radiogroup" aria-label="Mode">
            <button type="button" role="radio" aria-checked="false" tabIndex={-1}>
              a
            </button>
            <button type="button" role="radio" aria-checked="true" tabIndex={0}>
              b
            </button>
          </div>
        </Popover>,
      );
      await user.click(getByRole('button', { name: 'Open' }));
      expect(document.activeElement).toBe(getByRole('radio', { name: 'b' }));
    });
  });

  it('can be controlled: reports the wish to close and waits for the parent', async () => {
    const onOpenChange = vi.fn();
    const { user, getByRole } = setup(<Demo open onOpenChange={onOpenChange} />);
    expect(getByRole('dialog')).not.toBeNull();
    await user.keyboard('{Escape}');
    expect(onOpenChange).toHaveBeenCalledWith(false);
    expect(getByRole('dialog')).not.toBeNull();
  });

  it('allows one open popover at a time', async () => {
    const { user, getAllByRole, getByRole, queryByRole } = setup(
      <>
        <Popover label="First" trigger={(trigger) => <button {...trigger}>One</button>}>
          <button type="button">a</button>
        </Popover>
        <Popover label="Second" trigger={(trigger) => <button {...trigger}>Two</button>}>
          <button type="button">b</button>
        </Popover>
      </>,
    );
    await user.click(getByRole('button', { name: 'One' }));
    expect(getAllByRole('dialog')).toHaveLength(1);
    await user.click(getByRole('button', { name: 'Two' }));
    await closed(() => queryByRole('dialog', { name: 'First' }));
    expect(getByRole('dialog', { name: 'Second' })).not.toBeNull();
    expect(getAllByRole('dialog')).toHaveLength(1);
  });

  it('lets Esc close a shown tooltip first and the popover second', async () => {
    const { user, getByRole, queryByRole } = setup(
      <Popover label="Tools" trigger={(trigger) => <button {...trigger}>Open</button>}>
        <IconButton label="Add" icon={Plus} shortcut="A" />
      </Popover>,
    );
    await user.click(getByRole('button', { name: 'Open' }));
    // Focus went to the icon button by keyboard rules, so its tooltip opens after 300 ms.
    await waitFor(() => expect(openTooltip()).not.toBeNull(), { timeout: 2000 });

    await user.keyboard('{Escape}');
    await closed(openTooltip);
    expect(getByRole('dialog')).not.toBeNull();

    await user.keyboard('{Escape}');
    await closed(() => queryByRole('dialog'));
  });
});

describe('Popover with a numeric field', () => {
  function WithSlider() {
    const [value, setValue] = useState(50);
    return (
      <Popover label="Opacity" trigger={(trigger) => <button {...trigger}>Open</button>}>
        <Slider label="Opacity" unit="%" value={value} onValueChange={setValue} />
      </Popover>
    );
  }

  it('lets Esc cancel an unsaved edit of the field before it closes the popover', async () => {
    const { user, getByRole, queryByRole } = setup(<WithSlider />);
    await user.click(getByRole('button', { name: 'Open' }));
    const field = getByRole('textbox', { name: 'Opacity' }) as HTMLInputElement;
    field.focus();
    await user.clear(field);
    await user.type(field, '80');
    await user.keyboard('{Escape}');
    expect(field.value).toBe('50 %');
    expect(getByRole('dialog')).not.toBeNull();
    await user.keyboard('{Escape}');
    await closed(() => queryByRole('dialog'));
  });
});

const entries = (onSelect: (id: string) => void): MenuEntry[] => [
  { id: 'alpha', label: 'Alpha', icon: Plus, onSelect: () => onSelect('alpha') },
  { id: 'beta', label: 'Beta', disabled: true, onSelect: () => onSelect('beta') },
  { id: 'gamma', label: 'Gamma', checked: true, onSelect: () => onSelect('gamma') },
  { type: 'separator', id: 'sep' },
  { id: 'delta', label: 'Delta', shortcut: 'Ctrl+D', onSelect: () => onSelect('delta') },
];

function MenuDemo({ onSelect }: { onSelect: (id: string) => void }) {
  return (
    <>
      <Menu label="Actions" entries={entries(onSelect)} trigger={(trigger) => <button {...trigger}>Menu</button>} />
      <button type="button">next</button>
    </>
  );
}

describe('Menu', () => {
  it('opens on ArrowDown with the first item focused', async () => {
    const { user, getByRole } = setup(<MenuDemo onSelect={vi.fn()} />);
    const trigger = getByRole('button', { name: 'Menu' });
    expect(trigger.getAttribute('aria-haspopup')).toBe('menu');
    trigger.focus();
    await user.keyboard('{ArrowDown}');
    expect(getByRole('menu', { name: 'Actions' })).not.toBeNull();
    expect(document.activeElement).toBe(getByRole('menuitem', { name: /Alpha/ }));
  });

  it('opens on ArrowUp with the last item focused', async () => {
    const { user, getByRole } = setup(<MenuDemo onSelect={vi.fn()} />);
    getByRole('button', { name: 'Menu' }).focus();
    await user.keyboard('{ArrowUp}');
    expect(document.activeElement).toBe(getByRole('menuitem', { name: /Delta/ }));
  });

  it.each([['{Enter}'], [' ']])('opens on %j with the first item focused', async (key) => {
    const { user, getByRole } = setup(<MenuDemo onSelect={vi.fn()} />);
    getByRole('button', { name: 'Menu' }).focus();
    await user.keyboard(key);
    expect(document.activeElement).toBe(getByRole('menuitem', { name: /Alpha/ }));
  });

  it('moves with Up and Down, wrapping, and jumps with Home and End; disabled items stay reachable', async () => {
    const { user, getByRole } = setup(<MenuDemo onSelect={vi.fn()} />);
    getByRole('button', { name: 'Menu' }).focus();
    await user.keyboard('{ArrowDown}');
    await user.keyboard('{ArrowDown}');
    expect(document.activeElement).toBe(getByRole('menuitem', { name: 'Beta' }));
    await user.keyboard('{ArrowDown}');
    expect(document.activeElement).toBe(getByRole('menuitemcheckbox', { name: 'Gamma' }));
    await user.keyboard('{End}');
    expect(document.activeElement).toBe(getByRole('menuitem', { name: /Delta/ }));
    await user.keyboard('{ArrowDown}');
    expect(document.activeElement).toBe(getByRole('menuitem', { name: /Alpha/ }));
    await user.keyboard('{ArrowUp}');
    expect(document.activeElement).toBe(getByRole('menuitem', { name: /Delta/ }));
    await user.keyboard('{Home}');
    expect(document.activeElement).toBe(getByRole('menuitem', { name: /Alpha/ }));
  });

  it('jumps to the item that starts with the typed letter', async () => {
    const { user, getByRole } = setup(<MenuDemo onSelect={vi.fn()} />);
    getByRole('button', { name: 'Menu' }).focus();
    await user.keyboard('{ArrowDown}');
    await user.keyboard('g');
    expect(document.activeElement).toBe(getByRole('menuitemcheckbox', { name: 'Gamma' }));
  });

  it('treats letters typed in quick succession as one word', async () => {
    const { user, getByRole } = setup(<MenuDemo onSelect={vi.fn()} />);
    getByRole('button', { name: 'Menu' }).focus();
    await user.keyboard('{ArrowDown}');
    await user.keyboard('de');
    expect(document.activeElement).toBe(getByRole('menuitem', { name: /Delta/ }));
    // "del" still matches Delta, "dex" matches nothing and keeps focus where it is.
    await user.keyboard('x');
    expect(document.activeElement).toBe(getByRole('menuitem', { name: /Delta/ }));
  });

  it('exposes the checked state', async () => {
    const { user, getByRole } = setup(<MenuDemo onSelect={vi.fn()} />);
    await user.click(getByRole('button', { name: 'Menu' }));
    expect(getByRole('menuitemcheckbox', { name: 'Gamma' }).getAttribute('aria-checked')).toBe('true');
    expect(getByRole('menuitem', { name: 'Beta' }).getAttribute('aria-disabled')).toBe('true');
  });

  it('chooses with Enter: runs the item, closes and returns focus to the trigger', async () => {
    const onSelect = vi.fn();
    const { user, getByRole, queryByRole } = setup(<MenuDemo onSelect={onSelect} />);
    const trigger = getByRole('button', { name: 'Menu' });
    trigger.focus();
    await user.keyboard('{ArrowDown}');
    await user.keyboard('{Enter}');
    expect(onSelect).toHaveBeenCalledExactlyOnceWith('alpha');
    await closed(() => queryByRole('menu'));
    expect(document.activeElement).toBe(trigger);
  });

  it('chooses with a click', async () => {
    const onSelect = vi.fn();
    const { user, getByRole, queryByRole } = setup(<MenuDemo onSelect={onSelect} />);
    await user.click(getByRole('button', { name: 'Menu' }));
    await user.click(getByRole('menuitem', { name: /Delta/ }));
    expect(onSelect).toHaveBeenCalledExactlyOnceWith('delta');
    await closed(() => queryByRole('menu'));
  });

  it('does nothing for a disabled item and stays open', async () => {
    const onSelect = vi.fn();
    const { user, getByRole } = setup(<MenuDemo onSelect={onSelect} />);
    getByRole('button', { name: 'Menu' }).focus();
    await user.keyboard('{ArrowDown}');
    await user.keyboard('{ArrowDown}');
    await user.keyboard('{Enter}');
    expect(onSelect).not.toHaveBeenCalled();
    expect(getByRole('menu')).not.toBeNull();
  });

  it('closes on Esc and returns focus to the trigger', async () => {
    const { user, getByRole, queryByRole } = setup(<MenuDemo onSelect={vi.fn()} />);
    const trigger = getByRole('button', { name: 'Menu' });
    trigger.focus();
    await user.keyboard('{ArrowDown}');
    await user.keyboard('{Escape}');
    await closed(() => queryByRole('menu'));
    expect(document.activeElement).toBe(trigger);
  });

  it('closes on Tab and the focus moves on from the trigger', async () => {
    const { user, getByRole, queryByRole } = setup(<MenuDemo onSelect={vi.fn()} />);
    getByRole('button', { name: 'Menu' }).focus();
    await user.keyboard('{ArrowDown}');
    await user.tab();
    await closed(() => queryByRole('menu'));
    expect(document.activeElement).toBe(getByRole('button', { name: 'next' }));
  });

  it('works controlled, like the toolbar overflow menu uses it', async () => {
    function Controlled() {
      const [open, setOpen] = useState(false);
      return (
        <Menu
          label="Actions"
          open={open}
          onOpenChange={setOpen}
          entries={entries(() => undefined)}
          trigger={(trigger) => <button {...trigger}>Menu</button>}
        />
      );
    }
    const { user, getByRole, queryByRole } = setup(<Controlled />);
    await user.click(getByRole('button', { name: 'Menu' }));
    expect(getByRole('menu')).not.toBeNull();
    await user.keyboard('{Escape}');
    await closed(() => queryByRole('menu'));
  });
});

describe('Menu with entries that are made while it renders', () => {
  it('calls the function only while the menu is open, and may use hooks to follow state of its own', async () => {
    // Spies, because a render must not write to variables outside of it.
    const onEntries = vi.fn();
    const onParent = vi.fn();
    const store = { value: 'Alpha', listeners: new Set<() => void>() };
    const subscribe = (listener: () => void) => {
      store.listeners.add(listener);
      return () => store.listeners.delete(listener);
    };
    // A hook, as the toolbar's zoom menu is: the entries follow the store without the parent rendering again.
    const useEntries = (): MenuEntry[] => {
      onEntries();
      const value = useSyncExternalStore(subscribe, () => store.value);
      return [
        { id: 'a', label: 'Alpha', checked: value === 'Alpha', onSelect: () => undefined },
        { id: 'b', label: 'Beta', checked: value === 'Beta', onSelect: () => undefined },
      ];
    };
    function Parent() {
      onParent();
      return <Menu label="Actions" entries={useEntries} trigger={(trigger) => <button {...trigger}>Menu</button>} />;
    }
    const { user, getByRole, queryByRole } = setup(<Parent />);
    expect(onEntries).not.toHaveBeenCalled();
    await user.click(getByRole('button', { name: 'Menu' }));
    expect(onEntries).toHaveBeenCalled();
    expect(getByRole('menuitemcheckbox', { name: 'Alpha' }).getAttribute('aria-checked')).toBe('true');

    const rendersOfParent = onParent.mock.calls.length;
    act(() => {
      store.value = 'Beta';
      store.listeners.forEach((listener) => listener());
    });
    expect(getByRole('menuitemcheckbox', { name: 'Beta' }).getAttribute('aria-checked')).toBe('true');
    expect(getByRole('menuitemcheckbox', { name: 'Alpha' }).getAttribute('aria-checked')).toBe('false');
    expect(onParent).toHaveBeenCalledTimes(rendersOfParent);

    await user.keyboard('{Escape}');
    await closed(() => queryByRole('menu'));
    const callsWhenClosed = onEntries.mock.calls.length;
    act(() => {
      store.value = 'Alpha';
      store.listeners.forEach((listener) => listener());
    });
    expect(onEntries).toHaveBeenCalledTimes(callsWhenClosed);
  });

  it('a plain list works as before', async () => {
    const onSelect = vi.fn();
    const { user, getByRole } = setup(
      <Menu
        label="Actions"
        entries={[{ id: 'a', label: 'Alpha', onSelect }]}
        trigger={(trigger) => <button {...trigger}>Menu</button>}
      />,
    );
    await user.click(getByRole('button', { name: 'Menu' }));
    await user.click(getByRole('menuitem', { name: 'Alpha' }));
    expect(onSelect).toHaveBeenCalledTimes(1);
  });
});

describe('Popover edge cases', () => {
  it('takes focus itself when it has nothing to focus, keeps Tab inside, and Esc still returns focus', async () => {
    const { user, getByRole, queryByRole } = setup(
      <>
        <Popover label="Info" trigger={(trigger) => <button {...trigger}>Open</button>}>
          Read only text
        </Popover>
        <button type="button">after</button>
      </>,
    );
    const trigger = getByRole('button', { name: 'Open' });
    await user.click(trigger);
    const dialog = getByRole('dialog', { name: 'Info' });
    expect(document.activeElement).toBe(dialog);
    await user.tab();
    expect(document.activeElement).toBe(dialog);
    await user.tab({ shift: true });
    expect(document.activeElement).toBe(dialog);
    await user.keyboard('{Escape}');
    await closed(() => queryByRole('dialog'));
    expect(document.activeElement).toBe(trigger);
  });

  it('opens again after Esc with focus on its first control, and does not swallow Esc while closed', async () => {
    const { user, getByRole, queryByRole } = setup(<Demo />);
    const trigger = getByRole('button', { name: 'Open' });
    await user.click(trigger);
    await user.keyboard('{Escape}');
    await closed(() => queryByRole('dialog'));
    // Nothing is open: the key reaches the page untouched (no layer is left registered).
    expect(fireEvent.keyDown(document.body, { key: 'Escape' })).toBe(true);
    await user.click(trigger);
    expect(document.activeElement).toBe(getByRole('textbox', { name: 'Value' }));
    await user.keyboard('{Escape}');
    await closed(() => queryByRole('dialog'));
    expect(document.activeElement).toBe(trigger);
  });

  it('opens from the keyboard on the trigger with Enter and with Space', async () => {
    const { user, getByRole, queryByRole } = setup(<Demo />);
    const trigger = getByRole('button', { name: 'Open' });
    trigger.focus();
    await user.keyboard('{Enter}');
    expect(getByRole('dialog')).not.toBeNull();
    await user.keyboard('{Escape}');
    await closed(() => queryByRole('dialog'));
    await user.keyboard(' ');
    expect(getByRole('dialog')).not.toBeNull();
  });

  it('reports an outside click as the wish to close when controlled, and stays open until told', () => {
    const onOpenChange = vi.fn();
    const { getByRole } = setup(<Demo open onOpenChange={onOpenChange} />);
    fireEvent.pointerDown(document.body);
    expect(onOpenChange).toHaveBeenCalledWith(false);
    expect(getByRole('dialog')).not.toBeNull();
  });

  it('does not treat a press on its own trigger as an outside click', async () => {
    const onOpenChange = vi.fn();
    const { user, getByRole } = setup(<Demo onOpenChange={onOpenChange} />);
    const trigger = getByRole('button', { name: 'Open' });
    await user.click(trigger);
    expect(onOpenChange.mock.calls).toEqual([[true]]);
    await user.click(trigger);
    // Close once, by the toggle: not twice (pointerdown as outside click, then the click as toggle).
    expect(onOpenChange.mock.calls).toEqual([[true], [false]]);
  });
});

describe('Menu edge cases', () => {
  it('closes on an outside click and gives focus to the trigger when nothing else took it', async () => {
    const onSelect = vi.fn();
    const { user, getByRole, queryByRole } = setup(<MenuDemo onSelect={onSelect} />);
    const trigger = getByRole('button', { name: 'Menu' });
    await user.click(trigger);
    expect(getByRole('menu')).not.toBeNull();
    fireEvent.pointerDown(document.body);
    await closed(() => queryByRole('menu'));
    await waitFor(() => expect(document.activeElement).toBe(trigger));
    expect(onSelect).not.toHaveBeenCalled();
  });

  it('chooses with Space and leaves a disabled item alone with Space and a click', async () => {
    const onSelect = vi.fn();
    const { user, getByRole, queryByRole } = setup(<MenuDemo onSelect={onSelect} />);
    getByRole('button', { name: 'Menu' }).focus();
    await user.keyboard('{ArrowDown}{ArrowDown}');
    expect(document.activeElement).toBe(getByRole('menuitem', { name: 'Beta' }));
    await user.keyboard(' ');
    await user.click(getByRole('menuitem', { name: 'Beta' }));
    expect(onSelect).not.toHaveBeenCalled();
    expect(getByRole('menu')).not.toBeNull();
    await user.keyboard('{ArrowUp} ');
    expect(onSelect).toHaveBeenCalledExactlyOnceWith('alpha');
    await closed(() => queryByRole('menu'));
  });

  it('can be used again after a choice: each use runs exactly one item', async () => {
    const onSelect = vi.fn();
    const { user, getByRole } = setup(<MenuDemo onSelect={onSelect} />);
    getByRole('button', { name: 'Menu' }).focus();
    await user.keyboard('{ArrowDown}{Enter}');
    expect(onSelect).toHaveBeenCalledTimes(1);
    await user.keyboard('{ArrowDown}{Enter}');
    expect(onSelect).toHaveBeenCalledTimes(2);
    expect(onSelect).toHaveBeenLastCalledWith('alpha');
  });

  it('opens a menu with an empty list without throwing and closes on Esc', async () => {
    const { user, getByRole, queryByRole } = setup(
      <Menu label="Empty" entries={[]} trigger={(trigger) => <button {...trigger}>Menu</button>} />,
    );
    const trigger = getByRole('button', { name: 'Menu' });
    trigger.focus();
    await user.keyboard('{ArrowDown}');
    expect(getByRole('menu', { name: 'Empty' })).not.toBeNull();
    await user.keyboard('{Escape}');
    await closed(() => queryByRole('menu'));
    expect(document.activeElement).toBe(trigger);
  });
});

describe('Popover with a disabled trigger', () => {
  /** A plain button (not an IconButton), so only the Popover's own `disabled` can stop it. */
  function DisabledMenu({ disabled }: { disabled: boolean }) {
    return (
      <Menu
        label="Actions"
        disabled={disabled}
        entries={entries(() => undefined)}
        trigger={(trigger) => (
          <button {...trigger} aria-disabled={disabled ? true : undefined}>
            Menu
          </button>
        )}
      />
    );
  }

  it.each([['click'], ['{ArrowDown}'], ['{ArrowUp}'], ['{Enter}'], [' ']])('does not open on %s', async (input) => {
    const { user, getByRole, queryByRole } = setup(<DisabledMenu disabled />);
    const trigger = getByRole('button', { name: 'Menu' });
    trigger.focus();
    if (input === 'click') await user.click(trigger);
    else await user.keyboard(input);
    expect(queryByRole('menu')).toBeNull();
    expect(trigger.getAttribute('aria-expanded')).toBe('false');
  });

  it('opens as usual while enabled, and an open popover closes when the trigger becomes disabled', async () => {
    const { user, getByRole, queryByRole, rerender } = setup(<DisabledMenu disabled={false} />);
    getByRole('button', { name: 'Menu' }).focus();
    await user.keyboard('{ArrowDown}');
    expect(getByRole('menu')).not.toBeNull();
    rerender(<DisabledMenu disabled />);
    await closed(() => queryByRole('menu'));
    expect(getByRole('button', { name: 'Menu' }).getAttribute('aria-expanded')).toBe('false');
  });
});
