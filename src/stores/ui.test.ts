import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { AppError } from '../api/errors';
import { PANEL } from '../components/tokens';
import {
  PANEL_WIDTH_PERSIST_DELAY_MS,
  bindInspectorWidthToSettings,
  bindPanelWidthToSettings,
  bindSidebarCollapseToSettings,
  useUi,
} from './ui';
import { useSettings } from './settings';

const initial = useUi.getState();
const reset = () => useUi.setState({ ...initial }, true);

beforeEach(reset);
afterEach(reset);

describe('the ui store', () => {
  it('starts with the defaults of the spec: Thumbnails, default width, nothing collapsed, Select, Lesen', () => {
    expect(useUi.getState()).toMatchObject({
      leftPanelTab: 'thumbnails',
      leftPanelWidth: PANEL.default,
      leftPanelCollapsed: false,
      mode: 'read',
      activeTool: 'select',
      toolLocked: false,
      dropHover: false,
      banner: null,
    });
  });

  it('keeps the panel width inside the range', () => {
    const { setLeftPanelWidth } = useUi.getState();
    setLeftPanelWidth(300);
    expect(useUi.getState().leftPanelWidth).toBe(300);
    setLeftPanelWidth(10);
    expect(useUi.getState().leftPanelWidth).toBe(PANEL.min);
    setLeftPanelWidth(10_000);
    expect(useUi.getState().leftPanelWidth).toBe(PANEL.max);
    setLeftPanelWidth(Number.NaN);
    expect(useUi.getState().leftPanelWidth).toBe(PANEL.default);
  });

  it('the ends of the range are valid widths, and a width one pixel outside is moved onto them', () => {
    const { setLeftPanelWidth } = useUi.getState();
    for (const [given, kept] of [
      [PANEL.min, PANEL.min],
      [PANEL.min - 1, PANEL.min],
      [PANEL.max, PANEL.max],
      [PANEL.max + 1, PANEL.max],
      [Number.NEGATIVE_INFINITY, PANEL.default],
      [Number.POSITIVE_INFINITY, PANEL.default],
    ] as const) {
      setLeftPanelWidth(given);
      expect(useUi.getState().leftPanelWidth, String(given)).toBe(kept);
    }
  });

  it('the tab and the collapsed flag are set as given', () => {
    const state = useUi.getState();
    state.setLeftPanelTab('search');
    state.setLeftPanelCollapsed(true);
    expect(useUi.getState()).toMatchObject({ leftPanelTab: 'search', leftPanelCollapsed: true });
  });

  describe('tools (DESIGN 3.3)', () => {
    it('a click activates a tool once, and a second click goes back to Select', () => {
      const { selectTool } = useUi.getState();
      selectTool('highlight');
      expect(useUi.getState()).toMatchObject({ activeTool: 'highlight', toolLocked: false });
      selectTool('draw');
      expect(useUi.getState().activeTool).toBe('draw');
      selectTool('draw');
      expect(useUi.getState()).toMatchObject({ activeTool: 'select', toolLocked: false });
    });

    it('a double click locks the tool; clicking the locked tool, or Esc, releases it', () => {
      const { selectTool, lockTool, releaseTool } = useUi.getState();
      lockTool('note');
      expect(useUi.getState()).toMatchObject({ activeTool: 'note', toolLocked: true });
      selectTool('note');
      expect(useUi.getState()).toMatchObject({ activeTool: 'select', toolLocked: false });

      lockTool('note');
      releaseTool();
      expect(useUi.getState()).toMatchObject({ activeTool: 'select', toolLocked: false });
    });

    it('the click that starts a double click and the lock end with a locked tool', () => {
      const { selectTool, lockTool } = useUi.getState();
      // First click of the double click, then the double click itself.
      selectTool('form');
      lockTool('form');
      expect(useUi.getState()).toMatchObject({ activeTool: 'form', toolLocked: true });
    });

    it('Select cannot be locked, and choosing another tool unlocks the first', () => {
      const { selectTool, lockTool } = useUi.getState();
      lockTool('select');
      expect(useUi.getState()).toMatchObject({ activeTool: 'select', toolLocked: false });
      lockTool('draw');
      selectTool('signature');
      expect(useUi.getState()).toMatchObject({ activeTool: 'signature', toolLocked: false });
    });
  });

  it('the banner holds one error until it is dismissed, and the drop flag only the look of the drop zone', () => {
    const error: AppError = { code: 'damaged_file', key: 'error.damaged_file', retryable: false };
    useUi.getState().showBanner(error);
    expect(useUi.getState().banner).toBe(error);
    useUi.getState().dismissBanner();
    expect(useUi.getState().banner).toBeNull();
    useUi.getState().setDropHover(true);
    expect(useUi.getState().dropHover).toBe(true);
  });
});

describe('bindPanelWidthToSettings', () => {
  const settingsInitial = useSettings.getState();
  const update = vi.fn<(patch: { leftPanelWidth?: number }) => Promise<void>>();

  beforeEach(() => {
    vi.useFakeTimers();
    update.mockReset().mockResolvedValue(undefined);
    useSettings.setState({ ...settingsInitial, loaded: false, leftPanelWidth: PANEL.default, update }, true);
  });

  afterEach(() => {
    vi.useRealTimers();
    useSettings.setState(settingsInitial, true);
  });

  const loaded = (leftPanelWidth: number) => useSettings.setState({ loaded: true, leftPanelWidth });

  it('takes the saved width once the settings have loaded', () => {
    const stop = bindPanelWidthToSettings();
    expect(useUi.getState().leftPanelWidth).toBe(PANEL.default);
    loaded(320);
    expect(useUi.getState().leftPanelWidth).toBe(320);
    // Taking the saved width is not a change to save.
    vi.advanceTimersByTime(PANEL_WIDTH_PERSIST_DELAY_MS * 2);
    expect(update).not.toHaveBeenCalled();
    stop();
  });

  it('takes a late answer too (after the startup timeout), while the user has not touched the splitter', () => {
    const stop = bindPanelWidthToSettings();
    useSettings.setState({ loaded: true }); // the timeout: defaults, loaded
    expect(useUi.getState().leftPanelWidth).toBe(PANEL.default);
    useSettings.setState({ leftPanelWidth: 296 }); // the backend answers
    expect(useUi.getState().leftPanelWidth).toBe(296);
    stop();
  });

  it('saves a change once it has been still for the delay, not once per step of a drag', () => {
    loaded(PANEL.default);
    const stop = bindPanelWidthToSettings();
    for (const width of [256, 264, 272, 280, 288]) {
      useUi.getState().setLeftPanelWidth(width);
      vi.advanceTimersByTime(PANEL_WIDTH_PERSIST_DELAY_MS - 50);
    }
    expect(update).not.toHaveBeenCalled();
    vi.advanceTimersByTime(60);
    expect(update).toHaveBeenCalledTimes(1);
    expect(update).toHaveBeenCalledWith({ leftPanelWidth: 288 });
    stop();
  });

  it('does not write a width the settings already hold', () => {
    loaded(288);
    const stop = bindPanelWidthToSettings();
    useUi.getState().setLeftPanelWidth(256);
    useUi.getState().setLeftPanelWidth(288);
    vi.advanceTimersByTime(PANEL_WIDTH_PERSIST_DELAY_MS * 2);
    expect(update).not.toHaveBeenCalled();
    stop();
  });

  it('when the user moves the splitter before the settings arrive, their width wins and is saved after the load', () => {
    const stop = bindPanelWidthToSettings();
    useUi.getState().setLeftPanelWidth(304);
    vi.advanceTimersByTime(PANEL_WIDTH_PERSIST_DELAY_MS * 2);
    expect(update).not.toHaveBeenCalled(); // nothing to compare with yet
    loaded(PANEL.default);
    expect(useUi.getState().leftPanelWidth).toBe(304);
    vi.advanceTimersByTime(PANEL_WIDTH_PERSIST_DELAY_MS + 1);
    expect(update).toHaveBeenCalledTimes(1);
    expect(update).toHaveBeenCalledWith({ leftPanelWidth: 304 });
    stop();
  });

  it('a write that fails is not retried by every later change of the settings', () => {
    loaded(PANEL.default);
    const stop = bindPanelWidthToSettings();
    useUi.getState().setLeftPanelWidth(264);
    vi.advanceTimersByTime(PANEL_WIDTH_PERSIST_DELAY_MS + 1);
    expect(update).toHaveBeenCalledTimes(1);
    // The backend refused: the settings store records an error, which notifies its subscribers.
    useSettings.setState({ error: { code: 'internal', key: 'error.internal', retryable: false } });
    useSettings.setState({ error: null });
    vi.advanceTimersByTime(PANEL_WIDTH_PERSIST_DELAY_MS * 3);
    expect(update).toHaveBeenCalledTimes(1);
    stop();
  });

  it('stops following and drops a waiting write when it is disconnected', () => {
    loaded(PANEL.default);
    const stop = bindPanelWidthToSettings();
    useUi.getState().setLeftPanelWidth(264);
    stop();
    vi.advanceTimersByTime(PANEL_WIDTH_PERSIST_DELAY_MS * 2);
    expect(update).not.toHaveBeenCalled();
    useSettings.setState({ leftPanelWidth: 312 });
    expect(useUi.getState().leftPanelWidth).toBe(264);
  });

  it('clamps a saved width that is out of range', () => {
    const stop = bindPanelWidthToSettings();
    loaded(5000);
    expect(useUi.getState().leftPanelWidth).toBe(PANEL.max);
    stop();
  });

  it('persists the clamped width, never the raw one: a drag past either end is saved as 320 or 200', () => {
    loaded(260);
    const stop = bindPanelWidthToSettings();
    useUi.getState().setLeftPanelWidth(9000);
    vi.advanceTimersByTime(PANEL_WIDTH_PERSIST_DELAY_MS + 1);
    expect(update).toHaveBeenLastCalledWith({ leftPanelWidth: PANEL.max });

    useUi.getState().setLeftPanelWidth(-20);
    vi.advanceTimersByTime(PANEL_WIDTH_PERSIST_DELAY_MS + 1);
    expect(update).toHaveBeenLastCalledWith({ leftPanelWidth: PANEL.min });
    expect(update).toHaveBeenCalledTimes(2);
    stop();
  });

  it('a drag that ends where the settings already are, past the end of the range, writes nothing', () => {
    loaded(PANEL.max);
    const stop = bindPanelWidthToSettings();
    useUi.getState().setLeftPanelWidth(PANEL.max); // already there: not a change
    useUi.getState().setLeftPanelWidth(4000); // clamps to the same 320
    vi.advanceTimersByTime(PANEL_WIDTH_PERSIST_DELAY_MS * 2);
    expect(update).not.toHaveBeenCalled();
    stop();
  });

  it('the range ends themselves are saved as they are', () => {
    loaded(260);
    const stop = bindPanelWidthToSettings();
    useUi.getState().setLeftPanelWidth(PANEL.min);
    vi.advanceTimersByTime(PANEL_WIDTH_PERSIST_DELAY_MS + 1);
    expect(update).toHaveBeenLastCalledWith({ leftPanelWidth: PANEL.min });
    stop();
  });

  it('takes a saved width at the edge of the range as it is', () => {
    const stop = bindPanelWidthToSettings();
    loaded(PANEL.min);
    expect(useUi.getState().leftPanelWidth).toBe(PANEL.min);
    stop();
  });

  it('collapsing and restoring the panel is not a width change and writes nothing', () => {
    loaded(PANEL.default);
    const stop = bindPanelWidthToSettings();
    useUi.getState().setLeftPanelCollapsed(true);
    useUi.getState().setLeftPanelCollapsed(false);
    vi.advanceTimersByTime(PANEL_WIDTH_PERSIST_DELAY_MS * 2);
    expect(update).not.toHaveBeenCalled();
    stop();
  });
});

describe('releaseTool', () => {
  it('does not notify subscribers when Select is already active', () => {
    let calls = 0;
    const stop = useUi.subscribe(() => (calls += 1));
    useUi.getState().releaseTool();
    expect(calls).toBe(0);
    useUi.getState().selectTool('draw');
    useUi.getState().releaseTool();
    expect(calls).toBe(2);
    stop();
  });
});

describe('bindSidebarCollapseToSettings', () => {
  const settingsInitial = useSettings.getState();
  const uiInitial = useUi.getState();
  const update = vi.fn<(patch: object) => Promise<void>>();

  beforeEach(() => {
    update.mockReset().mockResolvedValue(undefined);
    useSettings.setState({ ...settingsInitial, loaded: false, update }, true);
    useUi.setState({ leftPanelCollapsed: false });
  });

  afterEach(() => {
    useSettings.setState(settingsInitial, true);
    useUi.setState(uiInitial, true);
  });

  it('applies the saved flag once the settings have loaded', () => {
    const stop = bindSidebarCollapseToSettings();
    useSettings.setState({ loaded: true, pageSidebarCollapsed: true });
    expect(useUi.getState().leftPanelCollapsed).toBe(true);
    expect(update).not.toHaveBeenCalled();
    stop();
  });

  it('writes a change of the page sidebar and nothing the settings already hold', () => {
    useSettings.setState({ loaded: true });
    const stop = bindSidebarCollapseToSettings();
    useUi.getState().setLeftPanelCollapsed(true);
    expect(update).toHaveBeenLastCalledWith({ pageSidebarCollapsed: true });
    useUi.getState().setLeftPanelCollapsed(false);
    // The settings mock does not follow, and it holds false: nothing more to write.
    expect(update).toHaveBeenCalledTimes(1);
    stop();
  });

  it('keeps the user choice made before the settings arrived', () => {
    const stop = bindSidebarCollapseToSettings();
    useUi.getState().setLeftPanelCollapsed(true);
    useSettings.setState({ loaded: true, pageSidebarCollapsed: false });
    expect(useUi.getState().leftPanelCollapsed).toBe(true);
    expect(update).toHaveBeenCalledWith({ pageSidebarCollapsed: true });
    stop();
  });
});

describe('the inspector width (F20.8)', () => {
  it('starts at 300 and stays inside 240 to 480', () => {
    expect(useUi.getState().inspectorWidth).toBe(300);
    const { setInspectorWidth } = useUi.getState();
    setInspectorWidth(100);
    expect(useUi.getState().inspectorWidth).toBe(240);
    setInspectorWidth(9000);
    expect(useUi.getState().inspectorWidth).toBe(480);
    setInspectorWidth(Number.NaN);
    expect(useUi.getState().inspectorWidth).toBe(300);
  });

  describe('persistence in the settings', () => {
    const settingsInitial = useSettings.getState();
    const update = vi.fn<(patch: { inspectorWidth?: number }) => Promise<void>>();

    beforeEach(() => {
      vi.useFakeTimers();
      update.mockReset().mockResolvedValue(undefined);
      useSettings.setState({ ...settingsInitial, loaded: false, update }, true);
    });
    afterEach(() => {
      vi.useRealTimers();
      useSettings.setState(settingsInitial, true);
    });

    it('takes the saved (clamped) width once the settings have loaded', () => {
      const stop = bindInspectorWidthToSettings();
      expect(useUi.getState().inspectorWidth).toBe(300);
      useSettings.setState({ loaded: true, inspectorWidth: 380 });
      expect(useUi.getState().inspectorWidth).toBe(380);
      useSettings.setState({ inspectorWidth: 9000 });
      expect(useUi.getState().inspectorWidth).toBe(480);
      expect(update).not.toHaveBeenCalled();
      stop();
    });

    it('saves a changed width once it has been still, and not a width the settings hold', () => {
      const stop = bindInspectorWidthToSettings();
      useSettings.setState({ loaded: true, inspectorWidth: 300 });
      useUi.getState().setInspectorWidth(340);
      useUi.getState().setInspectorWidth(360);
      vi.advanceTimersByTime(PANEL_WIDTH_PERSIST_DELAY_MS);
      expect(update).toHaveBeenCalledTimes(1);
      expect(update).toHaveBeenCalledWith({ inspectorWidth: 360 });
      useSettings.setState({ inspectorWidth: 360 });
      useUi.getState().setInspectorWidth(360);
      vi.advanceTimersByTime(PANEL_WIDTH_PERSIST_DELAY_MS);
      expect(update).toHaveBeenCalledTimes(1);
      stop();
    });
  });
});
