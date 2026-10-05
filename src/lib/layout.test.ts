import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { LAYOUT, PANEL } from '../components/tokens';
import {
  bodyHeight,
  COMMENTS_PANEL_MIN,
  clampPanelWidth,
  panelWidthFor,
  computeShellLayout,
  shellStructure,
  shellTracks,
  type LayoutInput,
} from './layout';

/** The editor shows, the window is 1280 wide, the page sidebar has its default width, the user changed nothing. */
const base: LayoutInput = {
  hasDocument: true,
  windowWidth: 1280,
  panelWidth: PANEL.default,
  panelCollapsed: false,
};

const layout = (overrides: Partial<LayoutInput> = {}) => computeShellLayout({ ...base, ...overrides });

describe('the editor columns of DESIGN v2 3.2', () => {
  it('page sidebar | splitter 8 | canvas, as tracks of tokens, with no tool column', () => {
    const wide = layout();
    expect(wide.mode).toBe('document');
    expect(wide.tracks).toEqual([
      { slot: 'left', size: '200px' },
      { slot: 'splitter', size: 'var(--splitter-width)' },
      { slot: 'canvas', size: 'minmax(var(--canvas-min), 1fr)' },
    ]);
    expect(wide.columns).toBe('200px var(--splitter-width) minmax(var(--canvas-min), 1fr)');
    expect(wide.column).toEqual({ left: 1, splitter: 2, canvas: 3 });
  });

  it('the canvas width is what is left of the window after the other tracks, at every width', () => {
    // 1280 - 200 - 8
    expect(layout().canvasWidth).toBe(1072);
    expect(layout({ windowWidth: 1000 }).canvasWidth).toBe(792);
    // A collapsed page sidebar: 1280 - 8
    expect(layout({ panelCollapsed: true }).canvasWidth).toBe(1272);
  });

  it('Home has one slot, the window, whatever the state says', () => {
    const home = layout({ hasDocument: false, windowWidth: 1600, menuRow: true });
    expect(home.mode).toBe('empty');
    expect(home.tracks.map((track) => track.slot)).toEqual(['canvas']);
    expect(home.columns).toBe('minmax(0, 1fr)');
    expect(home.menuRow).toBe(false);
    expect(home.rows).toBe('minmax(0, 1fr)');
    expect(home.leftCollapsed).toBe(true);
    expect(home.canvasWidth).toBe(1600);
  });
});

describe('the editor rows of DESIGN v2 3.2', () => {
  it('Windows: menu 32 | top bar 56 | mode 40 | tool 48 | body', () => {
    const windows = layout({ menuRow: true });
    expect(windows.menuRow).toBe(true);
    expect(windows.rowTracks.map((track) => track.row)).toEqual(['menu', 'topbar', 'mode', 'tool', 'body']);
    expect(windows.rows).toBe(
      'var(--menubar-height) var(--topbar-height) var(--mode-row-height) var(--tool-row-height) minmax(0, 1fr)',
    );
    expect(windows.row).toEqual({ menu: 1, topbar: 2, mode: 3, tool: 4, body: 5 });
  });

  it('macOS has no menu row: the native bar', () => {
    const mac = layout();
    expect(mac.menuRow).toBe(false);
    expect(mac.rows).toBe('var(--topbar-height) var(--mode-row-height) var(--tool-row-height) minmax(0, 1fr)');
    expect(mac.row).toEqual({ topbar: 1, mode: 2, tool: 3, body: 4 });
  });

  it('the body at 960 x 640 is 464 on Windows and 496 on macOS', () => {
    expect(bodyHeight(shellStructure({ ...base, menuRow: true }), LAYOUT.minWindowHeight)).toBe(464);
    expect(bodyHeight(shellStructure(base), LAYOUT.minWindowHeight)).toBe(496);
    expect(bodyHeight(shellStructure({ ...base, hasDocument: false }), 640)).toBe(640);
  });
});

describe('the page sidebar', () => {
  it('collapsed: its track takes no room but stays in the list, so no slot moves', () => {
    const open = layout();
    const collapsed = layout({ panelCollapsed: true });
    expect(collapsed.leftCollapsed).toBe(true);
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
    expect(shellStructure({ ...base, windowWidth: 859 }).leftCollapsed).toBe(true);
    expect(shellStructure({ ...base, windowWidth: 860 }).leftCollapsed).toBe(false);
  });

  it('collapses by itself when the canvas would be narrower than 360, with the exact threshold', () => {
    // 960 - 320 - 8 = 632 fits; at 860 (the lowest width where the sidebar stays) 860 - 320 - 8 = 532 fits too, so only a wide
    // sidebar in a narrow window can trip the rule: 860 - 492 - 8 = 360 is the edge, but the sidebar is at most 320.
    const input: LayoutInput = { ...base, windowWidth: 860, panelWidth: 320 };
    expect(shellStructure(input).leftCollapsed).toBe(false);
    expect(shellStructure({ ...input, windowWidth: 859 }).leftCollapsed).toBe(true);
  });

  it('every sidebar width fits the minimum window', () => {
    for (const panelWidth of [PANEL.min, PANEL.default, PANEL.max]) {
      const result = layout({ windowWidth: LAYOUT.minWindowWidth, panelWidth });
      expect(result.leftCollapsed).toBe(false);
      expect(result.canvasWidth).toBeGreaterThanOrEqual(LAYOUT.canvasMin);
    }
  });
});

describe('the window minimum', () => {
  it('the spec numbers: 960 x 640, page sidebar collapse below 860, rows 32, 56, 40, 48', () => {
    expect(LAYOUT.minWindowWidth).toBe(960);
    expect(LAYOUT.minWindowHeight).toBe(640);
    expect([LAYOUT.menubar, LAYOUT.topbar, LAYOUT.modeRow, LAYOUT.toolRow]).toEqual([32, 56, 40, 48]);
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

describe('the Comments tab width (ADR-106)', () => {
  it('widens the sidebar for the Comments tab only', () => {
    expect(panelWidthFor(PANEL.default, 'thumbnails')).toBe(PANEL.default);
    expect(panelWidthFor(PANEL.default, 'comments')).toBe(COMMENTS_PANEL_MIN);
    expect(panelWidthFor(PANEL.max, 'comments')).toBe(PANEL.max);
    expect(COMMENTS_PANEL_MIN).toBeLessThanOrEqual(PANEL.max);
  });

  it('puts the wider width in the track', () => {
    const input = { hasDocument: true, windowWidth: 1400, panelWidth: PANEL.default, panelCollapsed: false };
    expect(computeShellLayout({ ...input, leftTab: 'comments' }).panelWidth).toBe(COMMENTS_PANEL_MIN);
    expect(computeShellLayout(input).panelWidth).toBe(PANEL.default);
  });
});
