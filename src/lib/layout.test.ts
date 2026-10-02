import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { LAYOUT, PANEL } from '../components/tokens';
import { clampPanelWidth, computeShellLayout, shellStructure, shellTracks, type LayoutInput } from './layout';

/** A document is open, the window is 1100 wide (the default size), the panel has its default width, the user changed nothing. */
const base: LayoutInput = {
  hasDocument: true,
  windowWidth: 1100,
  panelWidth: PANEL.default,
  panelCollapsed: false,
  inspector: 'auto',
  inspectorContent: false,
};

const layout = (overrides: Partial<LayoutInput> = {}) => computeShellLayout({ ...base, ...overrides });
const slots = (overrides: Partial<LayoutInput> = {}) => layout(overrides).tracks.map((track) => track.slot);

describe('the columns of DESIGN 2', () => {
  it('with a document: 8 | left | splitter 8 | canvas | 8 | inspector 288 | 8, as tracks of tokens', () => {
    const wide = layout({ windowWidth: 1280 });
    expect(wide.mode).toBe('document');
    expect(wide.tracks).toEqual([
      { slot: 'gutter-start', size: 'var(--space-1)' },
      { slot: 'left', size: '248px' },
      { slot: 'splitter', size: 'var(--splitter-width)' },
      { slot: 'canvas', size: 'minmax(var(--canvas-min), 1fr)' },
      { slot: 'gap', size: 'var(--space-1)' },
      { slot: 'inspector', size: 'var(--inspector-width)' },
      { slot: 'gutter-end', size: 'var(--space-1)' },
    ]);
    expect(wide.columns).toBe(
      'var(--space-1) 248px var(--splitter-width) minmax(var(--canvas-min), 1fr) var(--space-1) var(--inspector-width) var(--space-1)',
    );
    expect(wide.column).toEqual({
      'gutter-start': 1,
      left: 2,
      splitter: 3,
      canvas: 4,
      gap: 5,
      inspector: 6,
      'gutter-end': 7,
    });
  });

  it('the canvas width is what is left of the window after the other tracks', () => {
    // 1280 - 8 - 248 - 8 - 8 - 288 - 8
    expect(layout({ windowWidth: 1280 }).canvasWidth).toBe(712);
    // No inspector track below 1280: 1100 - 8 - 248 - 8 - 8
    expect(layout().canvasWidth).toBe(828);
    // The minimum window, default panel, no inspector: 960 - 8 - 248 - 8 - 8
    expect(layout({ windowWidth: 960 }).canvasWidth).toBe(688);
  });

  it('without a document: 8 | empty state | 8, no panel and no inspector whatever the state says', () => {
    const empty = layout({ hasDocument: false, windowWidth: 1600, inspector: 'open', inspectorContent: true });
    expect(empty.mode).toBe('empty');
    expect(empty.tracks.map((track) => track.slot)).toEqual(['gutter-start', 'canvas', 'gutter-end']);
    expect(empty.columns).toBe('var(--space-1) minmax(0, 1fr) var(--space-1)');
    expect(empty.inspectorReserved).toBe(false);
    expect(empty.inspectorVisible).toBe(false);
    expect(empty.canvasWidth).toBe(1600 - 2 * LAYOUT.gutter);
  });
});

describe('the left panel', () => {
  it('collapsed: its track and the outer gutter go, the splitter is the leading gutter', () => {
    const collapsed = layout({ panelCollapsed: true });
    expect(collapsed.leftCollapsed).toBe(true);
    expect(collapsed.leftAutoCollapsed).toBe(false);
    expect(collapsed.tracks.map((track) => track.slot)).toEqual(['splitter', 'canvas', 'gutter-end']);
    expect(collapsed.column).toEqual({ splitter: 1, canvas: 2, 'gutter-end': 3 });
    // 1100 - 8 (splitter) - 8 (outer gutter)
    expect(collapsed.canvasWidth).toBe(1084);
  });

  it('is clamped to the range of the spec, and a bad width gives the default', () => {
    expect(layout({ panelWidth: 100 }).panelWidth).toBe(192);
    expect(layout({ panelWidth: 9000 }).panelWidth).toBe(400);
    expect(layout({ panelWidth: 300 }).tracks[1]).toEqual({ slot: 'left', size: '300px' });
    expect(layout({ panelWidth: Number.NaN }).panelWidth).toBe(248);
    expect(clampPanelWidth(Number.POSITIVE_INFINITY)).toBe(248);
    expect(clampPanelWidth(192)).toBe(192);
    expect(clampPanelWidth(400)).toBe(400);
  });

  it('collapses by itself when the canvas would be narrower than 360, and comes back when there is room', () => {
    // 960, inspector open, widest panel: 960 - 8 - 400 - 8 - 8 - 296 = 240 < 360
    const squeezed = layout({ windowWidth: 960, panelWidth: 400, inspector: 'open' });
    expect(squeezed.leftCollapsed).toBe(true);
    expect(squeezed.leftAutoCollapsed).toBe(true);
    expect(squeezed.inspectorReserved).toBe(true);
    // The canvas then gets 960 - 8 (splitter) - 296 - 8 = 648 and never falls under its minimum.
    expect(squeezed.canvasWidth).toBe(648);
    expect(squeezed.canvasWidth).toBeGreaterThanOrEqual(LAYOUT.canvasMin);

    // The same panel with room: 1280 - 8 - 400 - 8 - 8 - 296 = 560
    const roomy = layout({ windowWidth: 1280, panelWidth: 400, inspector: 'open' });
    expect(roomy.leftCollapsed).toBe(false);
    expect(roomy.canvasWidth).toBe(560);
  });

  it('the threshold is exact: 360 keeps the panel, 359 collapses it', () => {
    // canvas = width - 8 - 248 - 8 - 8 - 296 with the inspector open
    const fits = 360 + 8 + 248 + 8 + 8 + 296;
    expect(layout({ windowWidth: fits, inspector: 'open' }).leftCollapsed).toBe(false);
    expect(layout({ windowWidth: fits, inspector: 'open' }).canvasWidth).toBe(360);
    expect(layout({ windowWidth: fits - 1, inspector: 'open' }).leftAutoCollapsed).toBe(true);
  });

  it('a panel the user collapsed is not reported as auto-collapsed', () => {
    const both = layout({ windowWidth: 960, panelWidth: 400, inspector: 'open', panelCollapsed: true });
    expect(both.leftCollapsed).toBe(true);
    expect(both.leftAutoCollapsed).toBe(false);
  });

  it('every panel width of the range fits the minimum window with the inspector closed', () => {
    for (const panelWidth of [PANEL.min, PANEL.default, PANEL.max]) {
      const result = layout({ windowWidth: LAYOUT.minWindowWidth, panelWidth });
      expect(result.leftCollapsed, String(panelWidth)).toBe(false);
      expect(result.canvasWidth, String(panelWidth)).toBeGreaterThanOrEqual(LAYOUT.canvasMin);
    }
  });
});

describe('the inspector', () => {
  it('from 1280 px its track is reserved while a document is open, so the canvas never shifts', () => {
    const quiet = layout({ windowWidth: 1280 });
    const withTool = layout({ windowWidth: 1280, inspectorContent: true });
    expect(quiet.inspectorReserved).toBe(true);
    expect(quiet.inspectorVisible).toBe(false);
    expect(withTool.inspectorVisible).toBe(true);
    // Appearing changes neither the tracks nor the canvas.
    expect(withTool.columns).toBe(quiet.columns);
    expect(withTool.canvasWidth).toBe(quiet.canvasWidth);
    // 1279 is the last width without a reserved track.
    expect(layout({ windowWidth: 1279 }).inspectorReserved).toBe(false);
    expect(layout({ windowWidth: LAYOUT.inspectorReserveFrom }).inspectorReserved).toBe(true);
  });

  it('between 960 and 1279 the track exists only through the toggle, and a selection or tool does not open it', () => {
    for (const windowWidth of [960, 1100, 1279]) {
      const auto = layout({ windowWidth, inspectorContent: true });
      expect(auto.inspectorReserved, String(windowWidth)).toBe(false);
      expect(auto.inspectorVisible, String(windowWidth)).toBe(false);
      expect(slots({ windowWidth, inspectorContent: true })).not.toContain('inspector');

      const open = layout({ windowWidth, inspector: 'open' });
      expect(open.inspectorReserved, String(windowWidth)).toBe(true);
      expect(open.inspectorVisible, String(windowWidth)).toBe(true);
      expect(slots({ windowWidth, inspector: 'open' })).toContain('inspector');
    }
  });

  it('hidden: the track and the gap go', () => {
    expect(slots({ windowWidth: 1100 })).toEqual(['gutter-start', 'left', 'splitter', 'canvas', 'gutter-end']);
  });

  it('"closed" at 1280 and more keeps the track (the canvas does not shift) but hides the panel', () => {
    const closed = layout({ windowWidth: 1400, inspector: 'closed', inspectorContent: true });
    expect(closed.inspectorReserved).toBe(true);
    expect(closed.inspectorVisible).toBe(false);
    // Below 1280 "closed" has no track at all.
    expect(layout({ windowWidth: 1100, inspector: 'closed' }).inspectorReserved).toBe(false);
  });

  it('"open" at 1280 and more shows the panel without a selection', () => {
    expect(layout({ windowWidth: 1400, inspector: 'open' }).inspectorVisible).toBe(true);
  });
});

describe('the window minimum', () => {
  it('the spec numbers: 960 x 640, inspector reserved from 1280', () => {
    expect(LAYOUT.minWindowWidth).toBe(960);
    expect(LAYOUT.minWindowHeight).toBe(640);
    expect(LAYOUT.inspectorReserveFrom).toBe(1280);
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

  it('a window that is not a number does not break the layout', () => {
    expect(layout({ windowWidth: Number.NaN }).canvasWidth).toBeGreaterThanOrEqual(LAYOUT.canvasMin);
  });
});

describe('edge cases of the clamp and the collapse rules', () => {
  it('rounds a fractional width to whole pixels before clamping, and a negative or -Infinity width is a bad one', () => {
    expect(clampPanelWidth(247.6)).toBe(248);
    expect(clampPanelWidth(191.6)).toBe(192);
    expect(clampPanelWidth(400.4)).toBe(400);
    expect(clampPanelWidth(-50)).toBe(PANEL.min);
    expect(clampPanelWidth(Number.NEGATIVE_INFINITY)).toBe(PANEL.default);
    expect(layout({ panelWidth: 300.4 }).tracks[1]).toEqual({ slot: 'left', size: '300px' });
  });

  it('the collapse decision uses the clamped width: 9000 behaves like 400, 1 like 192', () => {
    const wide = layout({ windowWidth: 960, panelWidth: 9000, inspector: 'open' });
    expect(wide.panelWidth).toBe(PANEL.max);
    expect(wide.leftAutoCollapsed).toBe(true);
    // 960 - 8 - 192 - 8 - 8 - 296 = 448: the narrowest panel keeps its place next to an open inspector.
    const narrow = layout({ windowWidth: 960, panelWidth: 1, inspector: 'open' });
    expect(narrow.panelWidth).toBe(PANEL.min);
    expect(narrow.leftCollapsed).toBe(false);
    expect(narrow.canvasWidth).toBe(448);
    expect(narrow.tracks[1]).toEqual({ slot: 'left', size: '192px' });
  });

  it('the threshold is exact for the widest panel too: 360 keeps it, 359 collapses it', () => {
    const fits = 360 + 8 + PANEL.max + 8 + 8 + 296;
    const at = layout({ windowWidth: fits, panelWidth: PANEL.max, inspector: 'open' });
    expect(at.leftCollapsed).toBe(false);
    expect(at.canvasWidth).toBe(360);
    expect(layout({ windowWidth: fits - 1, panelWidth: PANEL.max, inspector: 'open' }).leftAutoCollapsed).toBe(true);
  });

  it('at the 960 minimum with the inspector open the default panel stays and a 296 px panel gives way', () => {
    // 960 - 8 - 248 - 8 - 8 - 296 = 392
    expect(layout({ windowWidth: 960, inspector: 'open' }).leftCollapsed).toBe(false);
    expect(layout({ windowWidth: 960, inspector: 'open' }).canvasWidth).toBe(392);
    // 960 - 8 - 296 - 8 - 8 - 296 = 344
    expect(layout({ windowWidth: 960, panelWidth: 296, inspector: 'open' }).leftAutoCollapsed).toBe(true);
  });

  it('from 1280 the reserved inspector track never squeezes the canvas under 360, whatever the panel width', () => {
    for (const panelWidth of [PANEL.min, PANEL.default, PANEL.max]) {
      for (const inspector of ['auto', 'open', 'closed'] as const) {
        const result = layout({ windowWidth: LAYOUT.inspectorReserveFrom, panelWidth, inspector });
        expect(result.leftCollapsed, `${panelWidth} ${inspector}`).toBe(false);
        expect(result.canvasWidth, `${panelWidth} ${inspector}`).toBeGreaterThanOrEqual(LAYOUT.canvasMin);
      }
    }
  });

  it('without a document the panel flags say "no panel", the window width does not matter, and a bad width stays clamped', () => {
    for (const windowWidth of [960, 1279, 1280, 2400]) {
      const empty = layout({ hasDocument: false, windowWidth, panelCollapsed: true, panelWidth: Number.NaN });
      expect(empty.columns, String(windowWidth)).toBe('var(--space-1) minmax(0, 1fr) var(--space-1)');
      expect(empty.leftCollapsed).toBe(true);
      expect(empty.leftAutoCollapsed).toBe(false);
      expect(empty.panelWidth).toBe(PANEL.default);
      expect(empty.column).toEqual({ 'gutter-start': 1, canvas: 2, 'gutter-end': 3 });
    }
  });

  it('a window width that is Infinity or negative does not break the layout', () => {
    expect(layout({ windowWidth: Number.POSITIVE_INFINITY }).canvasWidth).toBeGreaterThanOrEqual(LAYOUT.canvasMin);
    expect(layout({ hasDocument: false, windowWidth: -5 }).canvasWidth).toBe(0);
  });
});

describe('the structure and the tracks, which the shell follows separately', () => {
  it('the structure is booleans and a mode, so it is equal for every width inside one regime', () => {
    const at = (windowWidth: number) => shellStructure({ ...base, windowWidth });
    expect(at(1000)).toEqual(at(1279));
    expect(at(1280)).toEqual(at(2400));
    expect(at(1279)).not.toEqual(at(1280));
    for (const value of Object.values(at(1100))) expect(['string', 'boolean']).toContain(typeof value);
  });

  it('the structure does not depend on the panel width until the canvas would fall under 360', () => {
    const at = (panelWidth: number) => shellStructure({ ...base, panelWidth });
    expect(at(PANEL.min)).toEqual(at(PANEL.max));
    expect(shellStructure({ ...base, windowWidth: 960, inspector: 'open', panelWidth: PANEL.max })).not.toEqual(
      shellStructure({ ...base, windowWidth: 960, inspector: 'open', panelWidth: PANEL.min }),
    );
  });

  it('the tracks follow the panel width and the structure, and the slots sit where they sat for any width', () => {
    const structure = shellStructure({ ...base, windowWidth: 1280 });
    const narrow = shellTracks(structure, PANEL.min);
    const wide = shellTracks(structure, PANEL.max);
    expect(narrow.columns).toContain(`${PANEL.min}px`);
    expect(wide.columns).toContain(`${PANEL.max}px`);
    expect(narrow.column).toEqual(wide.column);
    expect(narrow.panelWidth).toBe(PANEL.min);
    expect(shellTracks(structure, 9000).panelWidth).toBe(PANEL.max);
    expect(shellTracks(structure, Number.NaN).panelWidth).toBe(PANEL.default);
  });

  it('computeShellLayout is the two together', () => {
    for (const windowWidth of [960, 1100, 1280, 1600]) {
      for (const inspector of ['auto', 'open', 'closed'] as const) {
        const input = { ...base, windowWidth, inspector, panelWidth: 300 };
        const whole = computeShellLayout(input);
        expect(whole).toMatchObject(shellStructure(input));
        expect(whole).toMatchObject(shellTracks(shellStructure(input), 300));
      }
    }
  });

  it('the empty structure is the same object every time and has no panel and no inspector', () => {
    const one = shellStructure({ ...base, hasDocument: false });
    expect(shellStructure({ ...base, hasDocument: false, windowWidth: 2400 })).toBe(one);
    expect(one).toEqual({
      mode: 'empty',
      leftCollapsed: true,
      leftAutoCollapsed: false,
      inspectorReserved: false,
      inspectorVisible: false,
    });
    expect(shellTracks(one, 300).columns).toBe('var(--space-1) minmax(0, 1fr) var(--space-1)');
  });
});
