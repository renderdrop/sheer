import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { LAYOUT, PANEL } from '../components/tokens';
import { clampPanelWidth, computeShellLayout, shellStructure, shellTracks, type LayoutInput } from './layout';

/** The editor shows, the window is 1280 wide, the page sidebar has its default width, the user changed nothing. */
const base: LayoutInput = {
  hasDocument: true,
  windowWidth: 1280,
  panelWidth: PANEL.default,
  panelCollapsed: false,
  inspector: 'auto',
};

const layout = (overrides: Partial<LayoutInput> = {}) => computeShellLayout({ ...base, ...overrides });

describe('the editor columns of DESIGN v2 3.2', () => {
  it('page sidebar | splitter 8 | canvas | tool sidebar 280, as tracks of tokens', () => {
    const wide = layout();
    expect(wide.mode).toBe('document');
    expect(wide.tracks).toEqual([
      { slot: 'left', size: '200px' },
      { slot: 'splitter', size: 'var(--splitter-width)' },
      { slot: 'canvas', size: 'minmax(var(--canvas-min), 1fr)' },
      { slot: 'tool', size: 'var(--tool-sidebar-width)' },
    ]);
    expect(wide.columns).toBe('200px var(--splitter-width) minmax(var(--canvas-min), 1fr) var(--tool-sidebar-width)');
    expect(wide.column).toEqual({ left: 1, splitter: 2, canvas: 3, tool: 4 });
  });

  it('the canvas width is what is left of the window after the other tracks', () => {
    // 1280 - 200 - 8 - 280
    expect(layout().canvasWidth).toBe(792);
    // Below 1100 the rail: 1000 - 200 - 8 - 56
    expect(layout({ windowWidth: 1000 }).canvasWidth).toBe(736);
    // A collapsed page sidebar: 1280 - 8 - 280
    expect(layout({ panelCollapsed: true }).canvasWidth).toBe(992);
  });

  it('Home has one slot, the window, whatever the state says', () => {
    const home = layout({ hasDocument: false, windowWidth: 1600, inspector: 'open' });
    expect(home.mode).toBe('empty');
    expect(home.tracks.map((track) => track.slot)).toEqual(['canvas']);
    expect(home.columns).toBe('minmax(0, 1fr)');
    expect(home.inspectorReserved).toBe(false);
    expect(home.inspectorVisible).toBe(false);
    expect(home.leftCollapsed).toBe(true);
    expect(home.canvasWidth).toBe(1600);
  });
});

describe('the page sidebar', () => {
  it('collapsed: its track takes no room but stays in the list, so no slot moves', () => {
    const open = layout();
    const collapsed = layout({ panelCollapsed: true });
    expect(collapsed.leftCollapsed).toBe(true);
    expect(collapsed.leftAutoCollapsed).toBe(false);
    expect(collapsed.tracks[0]).toEqual({ slot: 'left', size: 'var(--spacing-0)' });
    expect(collapsed.tracks.map((track) => track.slot)).toEqual(open.tracks.map((track) => track.slot));
    expect(collapsed.column).toEqual(open.column);
  });

  it('is clamped to 200..320, and a bad width gives the default', () => {
    expect(clampPanelWidth(10)).toBe(200);
    expect(clampPanelWidth(9000)).toBe(320);
    expect(clampPanelWidth(250.4)).toBe(250);
    expect(clampPanelWidth(Number.NaN)).toBe(PANEL.default);
    expect(clampPanelWidth(Number.POSITIVE_INFINITY)).toBe(PANEL.default);
    expect(layout({ panelWidth: 9000 }).tracks[0]?.size).toBe('320px');
  });

  it('collapses by itself below 860 px (exact), and comes back when the window grows', () => {
    expect(shellStructure({ ...base, windowWidth: 859, inspector: 'closed' }).leftAutoCollapsed).toBe(true);
    expect(shellStructure({ ...base, windowWidth: 860, inspector: 'closed' }).leftCollapsed).toBe(false);
  });

  it('collapses by itself when the canvas would be narrower than 360, with the exact threshold', () => {
    // 1100 - 320 - 8 - 280 = 492 fits; with the sidebar open at 960 and the full tool sidebar (a mode): 960 - 320 - 8 - 280 = 352
    const input: LayoutInput = { ...base, windowWidth: 960, panelWidth: 320, inspectorMode: true };
    expect(shellStructure(input).leftAutoCollapsed).toBe(true);
    expect(shellStructure({ ...input, panelWidth: 312 }).leftAutoCollapsed).toBe(false);
    expect(shellStructure({ ...input, panelWidth: 313 }).leftAutoCollapsed).toBe(true);
  });

  it('a sidebar the user collapsed is not reported as auto-collapsed', () => {
    const structure = shellStructure({ ...base, windowWidth: 800, panelCollapsed: true });
    expect(structure.leftCollapsed).toBe(true);
    expect(structure.leftAutoCollapsed).toBe(false);
  });

  it('every sidebar width fits the minimum window with the rail', () => {
    for (const panelWidth of [PANEL.min, PANEL.default, PANEL.max]) {
      const result = layout({ windowWidth: LAYOUT.minWindowWidth, panelWidth });
      expect(result.leftCollapsed).toBe(false);
      expect(result.canvasWidth).toBeGreaterThanOrEqual(LAYOUT.canvasMin);
    }
  });
});

describe('the tool sidebar and the rail', () => {
  it('280 from 1100 wide, the 56 rail below (exact)', () => {
    expect(shellStructure({ ...base, windowWidth: 1100 }).inspectorVisible).toBe(true);
    expect(shellStructure({ ...base, windowWidth: 1099 }).inspectorVisible).toBe(false);
    expect(layout({ windowWidth: 1099 }).tracks[3]).toEqual({ slot: 'tool', size: 'var(--tool-rail-width)' });
  });

  it('the column exists in the editor at every width', () => {
    for (const windowWidth of [960, 1099, 1100, 1920]) {
      expect(shellStructure({ ...base, windowWidth }).inspectorReserved).toBe(true);
    }
  });

  it('"closed" is the rail at any width, "open" is the sidebar at any width', () => {
    expect(shellStructure({ ...base, windowWidth: 1920, inspector: 'closed' }).inspectorVisible).toBe(false);
    expect(shellStructure({ ...base, windowWidth: 960, inspector: 'open' }).inspectorVisible).toBe(true);
  });

  it('"closed" still opens for a mode panel (Crop, Redact) and for nothing else', () => {
    expect(shellStructure({ ...base, inspector: 'closed', inspectorMode: true }).inspectorVisible).toBe(true);
    expect(shellStructure({ ...base, windowWidth: 960, inspectorMode: true }).inspectorVisible).toBe(true);
  });
});

describe('the window minimum', () => {
  it('the spec numbers: 960 x 640, rail below 1100, page sidebar collapse below 860', () => {
    expect(LAYOUT.minWindowWidth).toBe(960);
    expect(LAYOUT.minWindowHeight).toBe(640);
    expect(LAYOUT.railBelow).toBe(1100);
    expect(LAYOUT.leftCollapseBelow).toBe(860);
    expect(LAYOUT.leftCollapseBelow).toBeLessThan(LAYOUT.minWindowWidth);
  });

  it('tauri.conf.json and both platform files set that minimum', () => {
    for (const file of ['tauri.conf.json', 'tauri.windows.conf.json', 'tauri.macos.conf.json']) {
      const config = JSON.parse(
        readFileSync(fileURLToPath(new URL(`../../src-tauri/${file}`, import.meta.url)), 'utf8'),
      ) as { app: { windows: { minWidth: number; minHeight: number }[] } };
      expect(config.app.windows[0]?.minWidth, file).toBe(LAYOUT.minWindowWidth);
      expect(config.app.windows[0]?.minHeight, file).toBe(LAYOUT.minWindowHeight);
    }
  });

  it('a window width that is not a number, Infinity or negative does not break the layout', () => {
    expect(layout({ windowWidth: Number.NaN }).canvasWidth).toBeGreaterThanOrEqual(LAYOUT.canvasMin);
    expect(layout({ windowWidth: Number.POSITIVE_INFINITY }).canvasWidth).toBeGreaterThanOrEqual(LAYOUT.canvasMin);
    expect(layout({ windowWidth: -5 }).mode).toBe('document');
  });
});

describe('the structure and the tracks, which the shell follows separately', () => {
  it('the structure is booleans and a mode, so it is equal for every width inside one regime', () => {
    expect(shellStructure({ ...base, windowWidth: 1100 })).toEqual(shellStructure({ ...base, windowWidth: 1900 }));
    expect(shellStructure({ ...base, windowWidth: 900 })).toEqual(shellStructure({ ...base, windowWidth: 1050 }));
  });

  it('the tracks follow the sidebar width and the structure, and the slots sit where they sat for any width', () => {
    const structure = shellStructure(base);
    const narrow = shellTracks(structure, 200);
    const wide = shellTracks(structure, 320);
    expect(narrow.columns).not.toBe(wide.columns);
    expect(narrow.column).toEqual(wide.column);
    expect(wide.panelWidth).toBe(320);
  });

  it('computeShellLayout is the two together', () => {
    const structure = shellStructure(base);
    expect(layout()).toMatchObject({ ...structure, ...shellTracks(structure, base.panelWidth) });
  });

  it('the Home structure is the same object every time', () => {
    expect(shellStructure({ ...base, hasDocument: false })).toBe(
      shellStructure({ ...base, hasDocument: false, windowWidth: 5 }),
    );
  });
});
