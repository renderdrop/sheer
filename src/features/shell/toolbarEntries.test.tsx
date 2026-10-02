import { describe, expect, it, vi } from 'vitest';

import type { ToolbarEntry, ToolbarGroup, ToolbarItem } from '../../components';
import { ZOOM_STEPS } from '../../lib/zoom';
import { buildToolbar, zoomMenuEntries, type ToolbarActions, type ToolbarState } from './toolbarEntries';

const NBSP = String.fromCharCode(0xa0);

const state = (overrides: Partial<ToolbarState> = {}): ToolbarState => ({
  platform: 'windows',
  hasDocument: true,
  activeTool: 'select',
  toolLocked: false,
  leftPanelVisible: true,
  inspectorVisible: false,
  zoomAtMin: false,
  zoomAtMax: false,
  zoomText: `100${NBSP}%`,
  zoomMenu: zoomMenuEntries(1, vi.fn()),
  ...overrides,
});

const actions = (): ToolbarActions => ({
  open: vi.fn(),
  selectTool: vi.fn(),
  lockTool: vi.fn(),
  toggleLeftPanel: vi.fn(),
  toggleInspector: vi.fn(),
  zoomStep: vi.fn(),
});

const groups = (entries: ToolbarEntry[]): ToolbarGroup[] =>
  entries.filter((entry): entry is ToolbarGroup => entry.type === undefined || entry.type === 'group');
const items = (entries: ToolbarEntry[]): ToolbarItem[] => groups(entries).flatMap((group) => group.items);
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
      const { entries } = buildToolbar(state({ hasDocument: false }), actions());
      expect(items(entries).length).toBeGreaterThan(10);
      for (const entry of items(entries)) expect(entry.disabled, entry.id).toBe(true);
    });

    it('with a document every item is enabled, except zoom at its limits', () => {
      const { entries } = buildToolbar(state(), actions());
      for (const entry of items(entries)) expect(entry.disabled, entry.id).toBe(false);
      const atMin = buildToolbar(state({ zoomAtMin: true }), actions()).entries;
      expect(item(atMin, 'zoom-out').disabled).toBe(true);
      expect(item(atMin, 'zoom-in').disabled).toBe(false);
      const atMax = buildToolbar(state({ zoomAtMax: true }), actions()).entries;
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

    it('More always carries Open, so a mouse user can open a file before the menu bar exists', () => {
      const calls = actions();
      const { moreItems } = buildToolbar(state({ hasDocument: false, platform: 'macos' }), calls);
      expect(moreItems).toHaveLength(1);
      const open = moreItems[0];
      expect(open).toMatchObject({ id: 'open', label: 'Open…', shortcut: '⌘O' });
      if (open !== undefined && open.type !== 'separator') open.onSelect();
      expect(calls.open).toHaveBeenCalledTimes(1);
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
      expect(calls.toggleLeftPanel).toHaveBeenCalledTimes(1);
      expect(calls.toggleInspector).toHaveBeenCalledTimes(1);
    });
  });

  describe('zoom', () => {
    it('the readout shows what it is given (text, or an element that follows the zoom) and opens the preset menu it is given', () => {
      const menu = zoomMenuEntries(1.25, vi.fn());
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

    it('the buttons step in and out, with the platform shortcut chips', () => {
      const calls = actions();
      const { entries } = buildToolbar(state({ platform: 'windows' }), calls);
      item(entries, 'zoom-out').onActivate?.();
      item(entries, 'zoom-in').onActivate?.();
      expect(vi.mocked(calls.zoomStep).mock.calls).toEqual([[-1], [1]]);
      expect(item(entries, 'zoom-out')).toMatchObject({ shortcut: 'Ctrl+−', keyShortcuts: 'Control+Minus Meta+Minus' });
      expect(item(entries, 'zoom-in')).toMatchObject({ shortcut: 'Ctrl++', keyShortcuts: 'Control+Plus Meta+Plus' });
    });

    it('menu entries are the zoom steps; the current one is checked, and choosing one sets it', () => {
      const setZoom = vi.fn();
      const entries = zoomMenuEntries(0.67, setZoom);
      const checked = entries.filter((entry) => entry.type !== 'separator' && entry.checked === true);
      expect(checked).toHaveLength(1);
      expect(checked[0]).toMatchObject({ label: `67${String.fromCharCode(0xa0)}%` });
      const two = entries.find((entry) => entry.type !== 'separator' && entry.label.startsWith('200'));
      if (two !== undefined && two.type !== 'separator') two.onSelect();
      expect(setZoom).toHaveBeenCalledWith(2);
    });

    it('a zoom between two steps checks none', () => {
      expect(
        zoomMenuEntries(1.05, vi.fn()).filter((entry) => entry.type !== 'separator' && entry.checked === true),
      ).toEqual([]);
    });
  });
});
