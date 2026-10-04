import { describe, expect, it, vi } from 'vitest';

import { translators } from '../../i18n';
import { ZOOM_STEPS } from '../../lib/zoom';
import type { ToolbarItem } from '../../components';
import { buildToolbar, zoomMenuEntries, type ToolbarActions, type ToolbarState } from './toolbarEntries';

const state = (overrides: Partial<ToolbarState> = {}): ToolbarState => ({
  t: translators.en,
  platform: 'windows',
  action: { hasDocument: true, zoomAtMin: false, zoomAtMax: false, canUndo: false, canRedo: false },
  activeTool: 'select',
  toolLocked: false,
  leftPanelVisible: true,
  inspectorVisible: false,
  ...overrides,
});

const actions = (): ToolbarActions => ({
  run: vi.fn(),
  selectTool: vi.fn(),
  lockTool: vi.fn(),
  toggleRedact: vi.fn(),
});

const items = (overrides: Partial<ToolbarState> = {}) => {
  const built = buildToolbar(state(overrides), actions());
  return { ...built, all: built.groups.flatMap((group) => group.items) };
};
const item = (all: ToolbarItem[], id: string): ToolbarItem => {
  const found = all.find((candidate) => candidate.id === id);
  if (found === undefined) throw new Error(`no toolbar item ${id}`);
  return found;
};

describe('the toolbar of DESIGN 3.55: tools only', () => {
  it('has the seven tools in three groups and nothing else', () => {
    const { groups } = items();
    expect(groups.map((group) => group.items.map((entry) => entry.id))).toEqual([
      ['select'],
      ['highlight', 'note', 'draw', 'shapes'],
      ['signature', 'redact'],
    ]);
  });

  it('names Comment and Fill & Sign as the design does', () => {
    const { all } = items();
    expect(item(all, 'note').label).toBe('Comment');
    expect(item(all, 'signature').label).toBe('Fill & Sign');
    expect(item(all, 'redact').label).toBe('Redact');
  });

  it('has no Undo, Redo, zoom, More, Form, Pages or Edit tools (they are in the menus and the status bar)', () => {
    const { all } = items();
    const ids = all.map((entry) => entry.id);
    for (const gone of [
      'undo',
      'redo',
      'zoom-in',
      'zoom-out',
      'more',
      'form',
      'pages',
      'textBox',
      'image',
      'crop',
      'text',
    ]) {
      expect(ids, gone).not.toContain(gone);
    }
  });

  it('frames the card with the two panel toggles', () => {
    const { leading, trailing } = items({ leftPanelVisible: true, inspectorVisible: false });
    expect(leading).toMatchObject({ id: 'left-panel', kind: 'toggle', pressed: true });
    expect(trailing).toMatchObject({ id: 'inspector-toggle', kind: 'toggle', pressed: false });
  });

  it('presses the active tool, Comment for both of its variants, and Redact while its mode is on', () => {
    expect(item(items({ activeTool: 'draw' }).all, 'draw').pressed).toBe(true);
    expect(item(items({ activeTool: 'text' }).all, 'note')).toMatchObject({ pressed: true });
    expect(item(items({ activeTool: 'select', redactMode: true }).all, 'redact').pressed).toBe(true);
    expect(item(items({ activeTool: 'select', redactMode: true }).all, 'select').pressed).toBe(false);
    expect(item(items().all, 'select').pressed).toBe(true);
  });

  it('shows the Shapes and Highlight variants in the icon and the name', () => {
    const { all } = items({ shapeVariant: 'ellipse', markupVariant: 'underline' });
    expect(item(all, 'shapes').label).toBe('Ellipse');
    expect(item(all, 'highlight').label).toBe('Underline');
  });

  it('shows the keys of the tools', () => {
    const { all } = items();
    expect(item(all, 'select').shortcut).toBe('V');
    expect(item(all, 'redact').shortcut).toBe('X');
    expect(item(all, 'note').shortcut).toBe('C');
  });

  it('disables every tool without a document, and Sign and Redact in a read-only one', () => {
    const none = items({
      action: { hasDocument: false, zoomAtMin: false, zoomAtMax: false, canUndo: false, canRedo: false },
    });
    for (const entry of [...none.all, none.leading, none.trailing]) expect(entry.disabled, entry.id).toBe(true);
    const readOnly = items({ readOnly: true });
    expect(item(readOnly.all, 'signature').disabled).toBe(true);
    expect(item(readOnly.all, 'redact').disabled).toBe(true);
    expect(item(readOnly.all, 'draw').disabled).toBe(false);
  });

  it('opens the Sign menu instead of toggling', () => {
    expect(item(items().all, 'signature').menu).toBeDefined();
  });

  it('lets a tool be locked, except Select', () => {
    const { all } = items();
    expect(item(all, 'select').onLock).toBeUndefined();
    expect(item(all, 'draw').onLock).toBeTypeOf('function');
  });

  it('activates through the callbacks it is given', () => {
    const a = actions();
    const built = buildToolbar(state(), a);
    const all = built.groups.flatMap((group) => group.items);
    item(all, 'draw').onActivate?.();
    expect(a.selectTool).toHaveBeenCalledWith('draw');
    item(all, 'redact').onActivate?.();
    expect(a.toggleRedact).toHaveBeenCalled();
    built.leading.onActivate?.();
    expect(a.run).toHaveBeenCalledWith('toggle-left-panel');
  });

  it('turns Comment into the Text comment tool when that variant is the active one', () => {
    const a = actions();
    const built = buildToolbar(state({ activeTool: 'text' }), a);
    item(
      built.groups.flatMap((group) => group.items),
      'note',
    ).onActivate?.();
    expect(a.selectTool).toHaveBeenCalledWith('text');
  });
});

describe('the zoom presets', () => {
  it('check the preset that is the zoom', () => {
    const entries = zoomMenuEntries(1, vi.fn(), 'en');
    expect(entries).toHaveLength(ZOOM_STEPS.length);
    expect(entries.filter((entry) => entry.type !== 'separator' && entry.checked === true)).toHaveLength(1);
  });

  it('set the zoom they name', () => {
    const setZoom = vi.fn();
    const first = zoomMenuEntries(1, setZoom, 'en')[0];
    if (first === undefined || first.type === 'separator') throw new Error('no entry');
    first.onSelect();
    expect(setZoom).toHaveBeenCalledWith(ZOOM_STEPS[0]);
  });
});
