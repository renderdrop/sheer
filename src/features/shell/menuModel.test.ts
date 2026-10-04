import { describe, expect, it, vi } from 'vitest';

import { buildBarMenus, buildMenuEntries, type MenuContext } from '../../actions/menuModel';
import { NO_DOCUMENT } from '../../actions/state';
import { translators } from '../../i18n';

const context = (overrides: Partial<MenuContext> = {}): MenuContext => ({
  t: translators.en,
  platform: 'windows',
  state: { ...NO_DOCUMENT, hasDocument: true },
  run: vi.fn(),
  checked: () => undefined,
  hasTextSelection: false,
  recents: { items: [], clear: vi.fn() },
  ...overrides,
});

const labels = (menuId: string, ctx = context()) =>
  buildMenuEntries(menuId, ctx).map((entry) => (entry.type === 'separator' ? '-' : entry.label));

describe('the Windows menus built from menu.json', () => {
  it('are File, Edit, View, Tools and Help with their access keys, in English and German', () => {
    expect(buildBarMenus(context()).map((menu) => [menu.label, menu.access])).toEqual([
      ['File', 'F'],
      ['Edit', 'E'],
      ['View', 'V'],
      ['Tools', 'T'],
      ['Help', 'H'],
    ]);
    expect(buildBarMenus(context({ t: translators.de })).map((menu) => [menu.label, menu.access])).toEqual([
      ['Datei', 'D'],
      ['Bearbeiten', 'B'],
      ['Ansicht', 'A'],
      ['Werkzeuge', 'W'],
      ['Hilfe', 'H'],
    ]);
  });

  it('leave out the system items of macOS and never start, end or double a divider', () => {
    const edit = labels('edit');
    expect(edit).not.toContain('Cut');
    expect(edit.at(0)).not.toBe('-');
    expect(edit.at(-1)).not.toBe('-');
    expect(edit.join('|')).not.toContain('-|-');
    expect(edit).toEqual(expect.arrayContaining(['Undo', 'Redo', 'Delete', 'Add Comment', 'Find…']));
  });

  it('keep Settings, Exit, Full Screen and About for Windows', () => {
    expect(labels('file')).toEqual(expect.arrayContaining(['Settings…', 'Exit']));
    expect(labels('view')).toContain('Full Screen');
    expect(labels('help')).toEqual(['Welcome Tour', 'Show Tips Again', '-', 'About sheer.']);
  });

  it('take shortcuts from the registry, so the menu and the keys cannot differ', () => {
    const open = buildMenuEntries('file', context()).find((entry) => entry.id === 'open');
    expect(open?.type !== 'separator' && open?.shortcut).toBe('Ctrl+O');
  });

  it('enable Add Comment only with a text selection', () => {
    const find = (ctx: MenuContext) => {
      const entry = buildMenuEntries('edit', ctx).find((candidate) => candidate.id === 'add-comment');
      return entry?.type === 'separator' ? undefined : entry?.disabled;
    };
    expect(find(context({ hasTextSelection: false }))).toBe(true);
    expect(find(context({ hasTextSelection: true }))).toBe(false);
  });

  it('list the recent files in Open Recent with Clear, and disable it when there are none', () => {
    const onSelect = vi.fn();
    const withRecents = buildMenuEntries(
      'file',
      context({ recents: { items: [{ id: '1', label: 'A.pdf', onSelect }], clear: vi.fn() } }),
    ).find((entry) => entry.id === 'submenu:recent');
    expect(
      withRecents?.type !== 'separator' &&
        withRecents?.submenu?.map((entry) => (entry.type === 'separator' ? '-' : entry.label)),
    ).toEqual(['A.pdf', '-', 'Clear Menu']);
    const none = buildMenuEntries('file', context()).find((entry) => entry.id === 'submenu:recent');
    expect(none?.type !== 'separator' && none?.disabled).toBe(true);
  });

  it('run the action of the item and show its check state', () => {
    const run = vi.fn();
    const entries = buildMenuEntries('tools', context({ run, checked: (id) => id === 'tool-draw' }));
    const draw = entries.find((entry) => entry.id === 'tool-draw');
    if (draw === undefined || draw.type === 'separator') throw new Error('no Draw');
    expect(draw.checked).toBe(true);
    draw.onSelect();
    expect(run).toHaveBeenCalledWith('tool-draw');
  });
});
