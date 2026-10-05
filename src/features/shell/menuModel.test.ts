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

  it('has the File menu of the design: the commands outside the modes, Close, Settings and Exit last', () => {
    expect(labels('file')).toEqual([
      'Open…',
      '-',
      'Save',
      'Save As…',
      'Export Copy…',
      'Export Images…',
      'Create PDF From Images…',
      'Compress…',
      '-',
      'Flatten Form…',
      'Protect…',
      'Document Properties…',
      'Copy Citation List',
      'Save Citation List…',
      '-',
      'Print…',
      'Close Document',
      '-',
      'Settings…',
      'Exit',
    ]);
    expect(labels('file', context({ t: translators.de }))).toEqual(
      expect.arrayContaining([
        'Speichern',
        'Speichern unter…',
        'Kopie exportieren…',
        'Als Bilder exportieren…',
        'Drucken…',
        'Formular reduzieren…',
        'Dokumenteigenschaften…',
        'PDF aus Bildern erstellen…',
      ]),
    );
  });

  it('lose the Properties item in View', () => {
    expect(buildMenuEntries('view', context()).map((entry) => entry.id)).not.toContain('toggle-inspector');
  });

  it('list the five modes as radio items with the digit as hint, then form highlight and signatures, and no tools', () => {
    const entries = buildMenuEntries('tools', context({ checked: (id) => (id === 'mode-fill' ? true : undefined) }));
    expect(labels('tools')).toEqual([
      'Read',
      'Comment',
      'Fill & Sign',
      'Pages',
      'Edit',
      '-',
      'Highlight Form Fields',
      'Manage Signatures…',
    ]);
    const modes = entries.slice(0, 5).flatMap((entry) => (entry.type === 'separator' ? [] : [entry]));
    expect(modes.map((entry) => entry.shortcut)).toEqual(['1', '2', '3', '4', '5']);
    expect(modes.map((entry) => [entry.radio, entry.checked])).toEqual([
      [true, false],
      [true, false],
      [true, true],
      [true, false],
      [true, false],
    ]);
    expect(entries.map((entry) => entry.id).some((id) => id.startsWith('tool-'))).toBe(false);
    expect(labels('tools', context({ t: translators.de })).slice(0, 5)).toEqual([
      'Lesen',
      'Kommentieren',
      'Ausfüllen & Signieren',
      'Seiten',
      'Bearbeiten',
    ]);
  });

  it('run the action of the item and show its check state', () => {
    const run = vi.fn();
    const entries = buildMenuEntries('tools', context({ run, checked: (id) => id === 'mode-comment' }));
    const draw = entries.find((entry) => entry.id === 'mode-comment');
    if (draw === undefined || draw.type === 'separator') throw new Error('no Comment');
    expect(draw.checked).toBe(true);
    draw.onSelect();
    expect(run).toHaveBeenCalledWith('mode-comment');
  });
});
