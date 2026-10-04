import { describe, expect, it } from 'vitest';

import { catalogs } from '../i18n/catalog';
import layout from './menu.json';
import { ACTIONS, getAction } from './registry';
import { NO_DOCUMENT } from './state';
import { isBareKey, resolveBinding, toAccelerator } from './shortcut';

/**
 * `src/actions/menu.json` is the layout of the macOS menu bar. The Rust side builds the menu from it (`src-tauri/src/menu`,
 * which has its own tests for the file and for its allowlist of ids); these tests tie it to the command registry and the
 * catalogs, so a command cannot be in the menu with another shortcut or another name than everywhere else.
 */
interface ActionItem {
  platform?: string;
  action: string;
  label: string;
  accelerator?: string;
  requiresDocument?: boolean;
  withoutDocument?: string;
  withoutDocumentLabel?: string;
}
interface PredefinedItem {
  predefined: string;
  label: string;
}
interface SeparatorItem {
  separator: true;
  platform?: string;
}
interface SubmenuItem {
  submenu: string;
  label: string;
  clearLabel?: string;
  platform?: string;
}
type Item = ActionItem | PredefinedItem | SeparatorItem | SubmenuItem;
interface MenuSpec {
  id: string;
  label?: string;
  access?: string;
  items: Item[];
}

const menus = (layout as { menus: MenuSpec[]; barLabel: string }).menus;
const barLabel = (layout as { barLabel: string }).barLabel;
/** What the macOS menu bar has: the items for Windows only are left out. */
const onMac = (item: Item): boolean => !('platform' in item && item.platform === 'windows');
const items = menus.flatMap((menu) => menu.items);
const actionItems = items.filter((item): item is ActionItem => 'action' in item);
const macActionItems = actionItems.filter(onMac);
const predefinedItems = items.filter((item): item is PredefinedItem => 'predefined' in item);

/** The system items Rust knows (`Predefined` in src-tauri/src/menu/spec.rs); the Rust test names the same list. */
const PREDEFINED = [
  'about',
  'services',
  'hide',
  'hide_others',
  'show_all',
  'quit',
  'undo',
  'redo',
  'cut',
  'copy',
  'paste',
  'select_all',
  'minimize',
  'maximize',
  'fullscreen',
  'bring_all_to_front',
];

describe('the layout of the macOS menu bar', () => {
  it('is App, File, Edit, View, Tools, Window and Help, in that order (HIG)', () => {
    expect(menus.map((menu) => menu.id)).toEqual(['app', 'file', 'edit', 'view', 'tools', 'window', 'help']);
  });

  it('has a title for every menu but the first, which macOS names after the app', () => {
    expect(menus[0]?.label).toBeUndefined();
    for (const menu of menus.slice(1)) expect(menu.label, menu.id).toMatch(/^menu\.[a-z]+$/);
  });

  it('puts the system items where the HIG has them: About, Services, Hide and Quit in the app menu, the editing commands in Edit', () => {
    const names = (id: string) =>
      (menus.find((menu) => menu.id === id)?.items ?? []).flatMap((item) =>
        'predefined' in item ? [item.predefined] : [],
      );
    expect(names('app')).toEqual(['about', 'services', 'hide', 'hide_others', 'show_all', 'quit']);
    expect(names('edit')).toEqual(['cut', 'copy', 'paste', 'select_all']);
    expect(names('window')).toEqual(['minimize', 'maximize', 'bring_all_to_front']);
    expect(names('view')).toEqual(['fullscreen']);
  });

  it('starts and ends no menu with a separator and never has two in a row, on either platform', () => {
    const lists = menus.flatMap((menu) => [
      { id: menu.id, items: menu.items.filter(onMac) },
      ...(menu.access === undefined
        ? []
        : [{ id: `${menu.id} (Windows)`, items: menu.items.filter((item) => !('predefined' in item)) }]),
    ]);
    for (const menu of lists) {
      const flags = menu.items.map((item) => 'separator' in item);
      expect(flags[0], `${menu.id} start`).not.toBe(true);
      expect(flags.at(-1), `${menu.id} end`).not.toBe(true);
      for (let index = 1; index < flags.length; index += 1) {
        expect(flags[index] === true && flags[index - 1] === true, `${menu.id} ${index}`).toBe(false);
      }
    }
  });

  it('names only system items that Rust builds', () => {
    for (const item of predefinedItems) expect(PREDEFINED, item.predefined).toContain(item.predefined);
    expect(new Set(predefinedItems.map((item) => item.predefined)).size).toBe(predefinedItems.length);
  });
});

describe('the commands in the menu bar', () => {
  it('are exactly the actions of the registry that are marked for it, each once per platform', () => {
    const inMenu = macActionItems.map((item) => item.action);
    expect(new Set(inMenu).size).toBe(inMenu.length);
    const windows = actionItems.filter((item) => item.platform !== 'macos').map((item) => item.action);
    expect(new Set(windows.filter((id) => id !== 'settings')).size).toBe(
      windows.filter((id) => id !== 'settings').length,
    );
    expect([...new Set(actionItems.map((item) => item.action))].sort()).toEqual(
      ACTIONS.filter((action) => action.menuBar === true)
        .map((action) => action.id)
        .sort(),
    );
  });

  it('carry the accelerator of the macOS shortcut of their action, and none when the action has none', () => {
    for (const item of macActionItems) {
      const action = getAction(item.action);
      const binding = resolveBinding(action?.shortcut, 'macos');
      // The tool letters are bare keys, which a menu key equivalent must never be (they work in the canvas only).
      const expected = binding === null || isBareKey(binding) ? undefined : toAccelerator(binding);
      expect(item.accelerator, item.action).toBe(expected);
    }
  });

  it('use no accelerator twice, and none that is a bare key (a menu key equivalent would take the letter from a text field)', () => {
    const accelerators = actionItems.flatMap((item) => (item.accelerator === undefined ? [] : [item.accelerator]));
    expect(new Set(accelerators).size).toBe(accelerators.length);
    for (const accelerator of accelerators) expect(accelerator, accelerator).toMatch(/^(CmdOrCtrl|Alt|Shift)\+/);
  });

  it('are greyed in the menu bar without a document exactly when the action is disabled then (requiresDocument)', () => {
    for (const item of actionItems) {
      const enabled = getAction(item.action)?.enabled(NO_DOCUMENT) === true;
      expect(item.requiresDocument === true, item.action).toBe(!enabled);
    }
  });

  it('use kebab-case ids, which is what the allowlist in Rust and the UI both expect', () => {
    for (const item of actionItems) expect(item.action).toMatch(/^[a-z0-9]+(?:-[a-zA-Z0-9]+)*$/);
  });
});

describe('the labels of the menu bar', () => {
  const labels = [
    barLabel,
    ...menus.flatMap((menu) => (menu.label === undefined ? [] : [menu.label])),
    ...menus.flatMap((menu) => (menu.access === undefined ? [] : [menu.access])),
    ...items.flatMap((item) => ('clearLabel' in item && item.clearLabel !== undefined ? [item.clearLabel] : [])),
    ...items.flatMap((item) => ('label' in item ? [item.label] : [])),
    ...actionItems.flatMap((item) => (item.withoutDocumentLabel === undefined ? [] : [item.withoutDocumentLabel])),
  ];
  const menuKeys = (locale: 'en' | 'de') => Object.keys(catalogs[locale]).filter((key) => key.startsWith('menu.'));

  it('are keys of both catalogs, with a text', () => {
    for (const label of labels) {
      for (const locale of ['en', 'de'] as const)
        expect(catalogs[locale][label]?.trim(), `${locale} ${label}`).toBeTruthy();
    }
  });

  it('cover every menu.* key of the catalogs: none is missing, none is left over', () => {
    // The Windows menu bar has its own label for full screen and the macOS bar the system item's; no label is used twice.
    expect(new Set(labels).size).toBe(labels.length);
    for (const locale of ['en', 'de'] as const)
      expect([...menuKeys(locale)].sort(), locale).toEqual([...labels].sort());
  });

  it('use the {app} placeholder only in the app menu, where the name of the app belongs', () => {
    const appItems = new Set((menus[0]?.items ?? []).flatMap((item) => ('label' in item ? [item.label] : [])));
    for (const label of labels) {
      for (const locale of ['en', 'de'] as const) {
        const hasPlaceholder = (catalogs[locale][label] ?? '').includes('{app}');
        if (!appItems.has(label) && label !== 'menu.help.about')
          expect(hasPlaceholder, `${locale} ${label}`).toBe(false);
      }
    }
    expect(catalogs.en['menu.app.quit']).toBe('Quit {app}');
    expect(catalogs.de['menu.app.quit']).toBe('{app} beenden');
  });

  it('are written in the title case of macOS menus in English', () => {
    for (const label of labels) {
      if (label === 'menu.bar' || label === 'menu.app.about' || label === 'menu.app.hide' || label === 'menu.app.quit')
        continue;
      const text = catalogs.en[label] ?? '';
      // Every word of a menu title starts with a capital letter, except small words ("or", "to") in longer titles.
      for (const word of text.replace('…', '').split(' ')) {
        expect(
          word === 'or' || word === 'to' || word === '&' || word === '{app}' || /^[A-Z]/.test(word),
          `${label}: ${text}`,
        ).toBe(true);
      }
    }
  });
});
