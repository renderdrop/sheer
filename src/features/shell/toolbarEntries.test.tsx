import { describe, expect, it, vi } from 'vitest';

import { ACTIONS, ACTION_IDS, actionOf, actionShortcut, getAction, type ActionId } from '../../actions/registry';
import { NO_DOCUMENT, type ActionState } from '../../actions/state';
import type { MenuEntry, ToolbarEntry, ToolbarGroup, ToolbarItem } from '../../components';
import { translators } from '../../i18n';
import { ZOOM_STEPS } from '../../lib/zoom';
import {
  buildMoreItems,
  buildToolbar,
  zoomMenuEntries,
  type ToolbarActions,
  type ToolbarState,
} from './toolbarEntries';

const NBSP = String.fromCharCode(0xa0);

const state = (overrides: Partial<ToolbarState> = {}): ToolbarState => ({
  t: translators.en,
  platform: 'windows',
  action: { hasDocument: true, zoomAtMin: false, zoomAtMax: false, canUndo: false, canRedo: false },
  scrollMode: 'continuous',
  activeTool: 'select',
  toolLocked: false,
  leftPanelVisible: true,
  inspectorVisible: false,
  zoomText: `100${NBSP}%`,
  zoomMenu: zoomMenuEntries(1, vi.fn(), 'en'),
  ...overrides,
});

const actions = (): ToolbarActions => ({
  run: vi.fn(),
  selectTool: vi.fn(),
  lockTool: vi.fn(),
});

const groups = (entries: ToolbarEntry[]): ToolbarGroup[] =>
  entries.filter((entry): entry is ToolbarGroup => entry.type === undefined || entry.type === 'group');
const items = (entries: ToolbarEntry[]): ToolbarItem[] => groups(entries).flatMap((group) => group.items);
const entryOf = (entries: readonly MenuEntry[], id: string) => {
  const found = entries.find((candidate) => candidate.id === id);
  if (found === undefined || found.type === 'separator') throw new Error(`no menu entry ${id}`);
  return found;
};
const item = (entries: ToolbarEntry[], id: string): ToolbarItem => {
  const found = items(entries).find((candidate) => candidate.id === id);
  if (found === undefined) throw new Error(`no toolbar item ${id}`);
  return found;
};

describe('the toolbar of DESIGN 3.3 and ADR-011 section 6', () => {
  it('has the order panel toggle | Select | Markup | Fill and sign | Pages | More | spacer | zoom | inspector toggle', () => {
    const { entries } = buildToolbar(state(), actions());
    expect(entries.map((entry) => ('type' in entry && entry.type !== undefined ? entry.type : entry.id))).toEqual([
      'panels',
      'select',
      'markup',
      'fill-and-sign',
      'pages',
      'more',
      'spacer',
      'zoom',
      'inspector',
    ]);
    expect(groups(entries).map((group) => group.items.map((entry) => entry.id))).toEqual([
      ['left-panel'],
      ['select'],
      ['highlight', 'comment', 'draw'],
      ['form', 'signature'],
      ['pages'],
      ['zoom-out', 'zoom-level', 'zoom-in'],
      ['inspector-toggle'],
    ]);
  });

  it('names every cluster for assistive technology', () => {
    const { entries } = buildToolbar(state(), actions());
    expect(groups(entries).map((group) => group.label)).toEqual([
      'Panels',
      'Select',
      'Markup',
      'Fill and sign',
      'Pages',
      'Zoom',
      'Inspector',
    ]);
  });

  describe('without a document', () => {
    it('every item is disabled, which the toolbar renders as aria-disabled', () => {
      const { entries } = buildToolbar(state({ action: NO_DOCUMENT }), actions());
      expect(items(entries).length).toBeGreaterThan(10);
      for (const entry of items(entries)) expect(entry.disabled, entry.id).toBe(true);
    });

    it('with a document every item is enabled, except zoom at its limits', () => {
      const { entries } = buildToolbar(state(), actions());
      for (const entry of items(entries)) expect(entry.disabled, entry.id).toBe(false);
      const atMin = buildToolbar(
        state({ action: { hasDocument: true, zoomAtMin: true, zoomAtMax: false, canUndo: false, canRedo: false } }),
        actions(),
      ).entries;
      expect(item(atMin, 'zoom-out').disabled).toBe(true);
      expect(item(atMin, 'zoom-in').disabled).toBe(false);
      const atMax = buildToolbar(
        state({ action: { hasDocument: true, zoomAtMin: false, zoomAtMax: true, canUndo: false, canRedo: false } }),
        actions(),
      ).entries;
      expect(item(atMax, 'zoom-in').disabled).toBe(true);
      expect(item(atMax, 'zoom-out').disabled).toBe(false);
    });
  });

  describe('tools', () => {
    it('are tools, and only the active one is pressed', () => {
      const { entries } = buildToolbar(state({ activeTool: 'draw' }), actions());
      const tools = ['select', 'highlight', 'comment', 'draw', 'form', 'signature', 'pages'].map((id) =>
        item(entries, id),
      );
      for (const tool of tools) {
        expect(tool.kind, tool.id).toBe('tool');
        expect(tool.pressed, tool.id).toBe(tool.id === 'draw');
        expect(tool.locked, tool.id).toBe(false);
      }
    });

    it('a locked tool shows the lock, the others do not', () => {
      const { entries } = buildToolbar(state({ activeTool: 'comment', toolLocked: true }), actions());
      expect(item(entries, 'comment').locked).toBe(true);
      expect(item(entries, 'highlight').locked).toBe(false);
    });

    it('activating one selects it, and every tool but Select can be locked', () => {
      const calls = actions();
      const { entries } = buildToolbar(state(), calls);
      item(entries, 'highlight').onActivate?.();
      expect(calls.selectTool).toHaveBeenCalledWith('highlight');
      item(entries, 'highlight').onLock?.();
      expect(calls.lockTool).toHaveBeenCalledWith('highlight');
      expect(item(entries, 'select').onLock).toBeUndefined();
    });
  });

  describe('overflow', () => {
    it('moves Pages first, then Form, Signature, zoom out and zoom in into More; the rest never moves', () => {
      const { entries } = buildToolbar(state(), actions());
      const collapsing = items(entries)
        .filter((entry) => entry.collapse !== undefined)
        .sort((a, b) => (a.collapse ?? 0) - (b.collapse ?? 0))
        .map((entry) => entry.id);
      expect(collapsing).toEqual(['pages', 'form', 'signature', 'zoom-out', 'zoom-in']);
      for (const id of ['left-panel', 'select', 'highlight', 'comment', 'draw', 'zoom-level', 'inspector-toggle']) {
        expect(item(entries, id).collapse, id).toBeUndefined();
      }
    });

    it('More carries the commands that have no toolbar button, so a mouse user reaches every one on Windows', () => {
      const { moreItems } = buildToolbar(state(), actions());
      expect(moreItems.map((entry) => entry.id)).toEqual([
        'open',
        'close-document',
        'edit:before',
        'undo',
        'redo',
        'view:before',
        'actual-size',
        'fit-width',
        'fit-page',
        'scroll-continuous',
        'scroll-single',
        'scroll-spread',
        'page:before',
        'next-page',
        'previous-page',
        'next-tab',
        'previous-tab',
        'go-to-page',
        'find',
        'find-next',
        'find-previous',
        'view:before',
        'rotate-view-right',
        'rotate-view-left',
        'rotate-view-reset',
        'app:before',
        'settings',
        'about',
      ]);
      expect(moreItems.filter((entry) => entry.type === 'separator').map((entry) => entry.id)).toEqual([
        'edit:before',
        'view:before',
        'page:before',
        'view:before',
        'app:before',
      ]);
    });

    it('checks the scroll mode that is on among the three ways to lay out pages, and no other entry', () => {
      for (const mode of ['continuous', 'single', 'spread'] as const) {
        const { moreItems } = buildToolbar(state({ scrollMode: mode }), actions());
        const checked = (id: string) => entryOf(moreItems, id).checked;
        expect(checked('scroll-continuous')).toBe(mode === 'continuous');
        expect(checked('scroll-single')).toBe(mode === 'single');
        expect(checked('scroll-spread')).toBe(mode === 'spread');
        expect(checked('fit-width')).toBeUndefined();
        expect(checked('open')).toBeUndefined();
      }
    });

    it('disables the three ways to lay out pages without a document, like every other command', () => {
      const { moreItems } = buildToolbar(state({ action: NO_DOCUMENT }), actions());
      for (const id of ['scroll-continuous', 'scroll-single', 'scroll-spread']) {
        expect(entryOf(moreItems, id).disabled, id).toBe(true);
      }
    });

    it('every action marked for More is in it, with its shortcut chip, and runs through the registry', () => {
      const calls = actions();
      const { moreItems } = buildToolbar(state({ platform: 'macos' }), calls);
      const inMore = ACTIONS.filter((action) => action.more === true).map((action) => action.id);
      expect(moreItems.filter((entry) => entry.type !== 'separator').map((entry) => entry.id)).toEqual(inMore);
      const open = entryOf(moreItems, 'open');
      expect(open).toMatchObject({ label: 'Open…', shortcut: '⌘O', disabled: false });
      open.onSelect();
      expect(calls.run).toHaveBeenCalledWith('open');
      expect(entryOf(moreItems, 'fit-width')).toMatchObject({ label: 'Fit width', shortcut: '⌘2' });
      expect(entryOf(moreItems, 'next-page')).toMatchObject({ shortcut: '⌘↓' });
      expect(entryOf(moreItems, 'about').shortcut).toBeUndefined();
    });

    it('without a document only Open, Settings and About can be chosen', () => {
      const { moreItems } = buildToolbar(state({ action: NO_DOCUMENT }), actions());
      const enabled = moreItems
        .filter((entry) => entry.type !== 'separator' && entry.disabled !== true)
        .map((entry) => entry.id);
      expect(enabled).toEqual(['open', 'settings', 'about']);
    });

    it('is built by buildMoreItems alone, and follows the language and the platform', () => {
      const own = buildMoreItems(state({ t: translators.de, platform: 'windows' }), vi.fn());
      expect(entryOf(own, 'open')).toMatchObject({ label: 'Öffnen…', shortcut: 'Strg+O' });
      expect(entryOf(own, 'close-document')).toMatchObject({ label: 'Dokument schließen', shortcut: 'Strg+W' });
    });
  });

  describe('toggles', () => {
    it('show whether their panel is visible and toggle it', () => {
      const calls = actions();
      const { entries } = buildToolbar(state({ leftPanelVisible: false, inspectorVisible: true }), calls);
      expect(item(entries, 'left-panel')).toMatchObject({ kind: 'toggle', pressed: false });
      expect(item(entries, 'inspector-toggle')).toMatchObject({ kind: 'toggle', pressed: true });
      item(entries, 'left-panel').onActivate?.();
      item(entries, 'inspector-toggle').onActivate?.();
      expect(vi.mocked(calls.run).mock.calls).toEqual([['toggle-left-panel'], ['toggle-inspector']]);
    });
  });

  describe('zoom', () => {
    it('the readout shows what it is given (text, or an element that follows the zoom) and opens the preset menu it is given', () => {
      const menu = zoomMenuEntries(1.25, vi.fn(), 'en');
      const { entries } = buildToolbar(state({ zoomText: `125${NBSP}%`, zoomMenu: menu }), actions());
      const readout = item(entries, 'zoom-level');
      expect(readout.text).toBe(`125${NBSP}%`);
      expect(readout.menu).toBe(menu);
      expect(menu).toHaveLength(ZOOM_STEPS.length);
      const live = <span />;
      const useMenu = () => menu;
      const followed = item(
        buildToolbar(state({ zoomText: live, zoomMenu: useMenu }), actions()).entries,
        'zoom-level',
      );
      expect(followed.text).toBe(live);
      expect(followed.menu).toBe(useMenu);
    });

    it('the buttons step in and out through the registry, with the platform shortcut chips', () => {
      const calls = actions();
      const { entries } = buildToolbar(state({ platform: 'windows' }), calls);
      item(entries, 'zoom-out').onActivate?.();
      item(entries, 'zoom-in').onActivate?.();
      expect(vi.mocked(calls.run).mock.calls).toEqual([['zoom-out'], ['zoom-in']]);
      expect(item(entries, 'zoom-out')).toMatchObject({ shortcut: 'Ctrl+−', keyShortcuts: 'Control+Minus' });
      expect(item(entries, 'zoom-in')).toMatchObject({ shortcut: 'Ctrl++', keyShortcuts: 'Control+Plus' });
    });

    it('the tools show their letter, which works with the canvas focused', () => {
      const { entries } = buildToolbar(state({ platform: 'windows' }), actions());
      const letters = ['select', 'highlight', 'comment', 'draw', 'form', 'signature', 'pages'].map((id) => [
        id,
        item(entries, id).shortcut,
      ]);
      expect(letters).toEqual([
        ['select', 'V'],
        ['highlight', 'H'],
        ['comment', 'C'],
        ['draw', 'D'],
        ['form', 'F'],
        ['signature', 'S'],
        ['pages', 'P'],
      ]);
      expect(item(entries, 'highlight').keyShortcuts).toBe('H');
    });

    it('the panel toggles show the platform key: F4 and Shift+F4, Option+Cmd+1 and Option+Cmd+I', () => {
      const windows = buildToolbar(state({ platform: 'windows' }), actions()).entries;
      expect(item(windows, 'left-panel').shortcut).toBe('F4');
      expect(item(windows, 'inspector-toggle').shortcut).toBe('Shift+F4');
      const mac = buildToolbar(state({ platform: 'macos' }), actions()).entries;
      expect(item(mac, 'left-panel')).toMatchObject({ shortcut: '⌥⌘1', keyShortcuts: 'Alt+Meta+1' });
      expect(item(mac, 'inspector-toggle').shortcut).toBe('⌥⌘I');
    });

    it('the chips are written in the language of the toolbar on Windows and Linux; the announced shortcuts stay canonical', () => {
      for (const platform of ['windows', 'linux'] as const) {
        const { entries, moreItems } = buildToolbar(state({ platform, t: translators.de }), actions());
        expect(item(entries, 'zoom-out')).toMatchObject({ shortcut: 'Strg+−', keyShortcuts: 'Control+Minus' });
        expect(item(entries, 'zoom-in')).toMatchObject({ shortcut: 'Strg++', keyShortcuts: 'Control+Plus' });
        expect(moreItems[0]).toMatchObject({ id: 'open', label: 'Öffnen…', shortcut: 'Strg+O' });
      }
    });

    it('the chips keep the macOS symbols in German', () => {
      const { entries, moreItems } = buildToolbar(state({ platform: 'macos', t: translators.de }), actions());
      expect(item(entries, 'zoom-out')).toMatchObject({ shortcut: '⌘−', keyShortcuts: 'Meta+Minus' });
      expect(moreItems[0]).toMatchObject({ shortcut: '⌘O' });
    });

    it('menu entries are the zoom steps; the current one is checked, and choosing one sets it', () => {
      const setZoom = vi.fn();
      const entries = zoomMenuEntries(0.67, setZoom, 'en');
      const checked = entries.filter((entry) => entry.type !== 'separator' && entry.checked === true);
      expect(checked).toHaveLength(1);
      expect(checked[0]).toMatchObject({ label: `67${String.fromCharCode(0xa0)}%` });
      const two = entries.find((entry) => entry.type !== 'separator' && entry.label.startsWith('200'));
      if (two !== undefined && two.type !== 'separator') two.onSelect();
      expect(setZoom).toHaveBeenCalledWith(2);
    });

    it('a zoom between two steps checks none', () => {
      expect(
        zoomMenuEntries(1.05, vi.fn(), 'en').filter((entry) => entry.type !== 'separator' && entry.checked === true),
      ).toEqual([]);
    });
  });
});

describe('the toolbar and the More menu are the registry (no orphan shortcuts)', () => {
  /** The action each toolbar item stands for. The zoom readout is a menu button, not a command, so it has none. */
  const TOOLBAR_ACTION: Readonly<Record<string, ActionId | null>> = {
    'left-panel': 'toggle-left-panel',
    select: 'tool-select',
    highlight: 'tool-highlight',
    comment: 'tool-comment',
    draw: 'tool-draw',
    form: 'tool-form',
    signature: 'tool-signature',
    pages: 'tool-pages',
    'zoom-out': 'zoom-out',
    'zoom-level': null,
    'zoom-in': 'zoom-in',
    'inspector-toggle': 'toggle-inspector',
  };
  const PLATFORMS = ['macos', 'windows', 'linux', null] as const;
  const LOCALES = ['en', 'de'] as const;
  const STATES: readonly ActionState[] = [
    NO_DOCUMENT,
    { hasDocument: true, zoomAtMin: false, zoomAtMax: false, canUndo: false, canRedo: false },
    { hasDocument: true, zoomAtMin: true, zoomAtMax: false, canUndo: false, canRedo: false },
    { hasDocument: true, zoomAtMin: false, zoomAtMax: true, canUndo: false, canRedo: false },
  ];

  const moreEntries = (entries: readonly MenuEntry[]) =>
    entries.flatMap((entry) => (entry.type === 'separator' ? [] : [entry]));

  it('maps every toolbar item to an action of the registry, or knowingly to none (the zoom readout)', () => {
    const { entries } = buildToolbar(state(), actions());
    expect(items(entries).map((entry) => entry.id)).toEqual(Object.keys(TOOLBAR_ACTION));
    for (const [id, actionId] of Object.entries(TOOLBAR_ACTION)) {
      if (actionId !== null) expect(getAction(actionId), id).toBeDefined();
    }
  });

  it('puts every action in exactly one place, the toolbar or More, so no shortcut works without a visible command', () => {
    const { entries, moreItems } = buildToolbar(state(), actions());
    const onToolbar = items(entries).flatMap((entry) => TOOLBAR_ACTION[entry.id] ?? []);
    const inMore = moreEntries(moreItems).map((entry) => entry.id);
    expect(new Set([...onToolbar, ...inMore]).size).toBe(onToolbar.length + inMore.length);
    expect([...onToolbar, ...inMore].sort()).toEqual([...ACTION_IDS].sort());
    for (const id of inMore) expect(getAction(id), id).toBeDefined();
  });

  it('shows on each item the registry shortcut of the platform and language, and none where the action has none', () => {
    for (const platform of PLATFORMS) {
      for (const locale of LOCALES) {
        const t = translators[locale];
        const { entries, moreItems } = buildToolbar(state({ platform, t }), actions());
        for (const entry of items(entries)) {
          const actionId = TOOLBAR_ACTION[entry.id];
          const expected =
            actionId === null || actionId === undefined ? null : actionShortcut(actionOf(actionId), platform, t);
          const where = `${platform} ${locale} ${entry.id}`;
          expect(entry.shortcut ?? null, where).toBe(expected?.label ?? null);
          expect(entry.keyShortcuts ?? null, where).toBe(expected?.aria ?? null);
        }
        for (const entry of moreEntries(moreItems)) {
          const expected = actionShortcut(actionOf(entry.id as ActionId), platform, t);
          expect(entry.shortcut ?? null, `${platform} ${locale} more ${entry.id}`).toBe(expected?.label ?? null);
        }
      }
    }
  });

  it('disables each item exactly when the registry says the action cannot run', () => {
    for (const action of STATES) {
      const { entries, moreItems } = buildToolbar(state({ action }), actions());
      for (const entry of items(entries)) {
        const actionId = TOOLBAR_ACTION[entry.id];
        const expected =
          actionId === null || actionId === undefined ? !action.hasDocument : !actionOf(actionId).enabled(action);
        expect(entry.disabled === true, `${JSON.stringify(action)} ${entry.id}`).toBe(expected);
      }
      for (const entry of moreEntries(moreItems)) {
        expect(entry.disabled === true, `${JSON.stringify(action)} more ${entry.id}`).toBe(
          !actionOf(entry.id as ActionId).enabled(action),
        );
      }
    }
  });

  it('runs a More entry through the registry under its own id, and nothing else', () => {
    const calls = actions();
    const { moreItems } = buildToolbar(state(), calls);
    for (const entry of moreEntries(moreItems)) entry.onSelect();
    expect(vi.mocked(calls.run).mock.calls.map(([id]) => id)).toEqual(moreEntries(moreItems).map((entry) => entry.id));
    expect(calls.selectTool).not.toHaveBeenCalled();
    expect(calls.lockTool).not.toHaveBeenCalled();
  });
});
