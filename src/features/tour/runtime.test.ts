// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { updateSettings, type Settings } from '../../api/app';
import { openWelcomeDocument, type DocumentInfo } from '../../api/documents';
import { useDocuments } from '../../stores/documents';
import { useSettings } from '../../stores/settings';
import { useView } from '../../stores/view';
import { HOLD_MS, NAVIGATE_SETTLE_MS } from './engine';
import { LAUNCH_SETTLE_MS, OPEN_SETTLE_MS, bindTour, maybeFirstLaunch, resetFirstLaunch } from './runtime';
import { useTour } from './store';

vi.mock('../../api/app', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../api/app')>()),
  updateSettings: vi.fn(),
}));
vi.mock('../../api/documents', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../api/documents')>()),
  openWelcomeDocument: vi.fn(),
  closeDocument: vi.fn(() => Promise.resolve()),
}));

const updateSettingsMock = vi.mocked(updateSettings);
const openWelcomeMock = vi.mocked(openWelcomeDocument);
const settingsInitial = useSettings.getState();
const documentsInitial = useDocuments.getState();
const viewInitial = useView.getState();
const tourInitial = useTour.getState();

const WELCOME: DocumentInfo = { id: 1, pageCount: 4, displayName: 'Welcome', kind: 'welcome' };
const USER: DocumentInfo = { id: 2, pageCount: 3, displayName: 'a.pdf', kind: 'user' };

/** What the viewer does for a document the backend opened: its view first, then the document. */
function show(info: DocumentInfo) {
  useView.getState().open(info.id, info.pageCount);
  useDocuments.getState().add(info);
}

let unbind: () => void;

beforeEach(() => {
  vi.useFakeTimers();
  useSettings.setState({ ...settingsInitial, loaded: true }, true);
  useDocuments.setState({ ...documentsInitial }, true);
  useView.setState({ ...viewInitial }, true);
  useTour.setState({ ...tourInitial }, true);
  updateSettingsMock.mockReset();
  updateSettingsMock.mockImplementation((patch) => {
    const { glass, theme, language, leftPanelWidth, welcomeTour } = useSettings.getState();
    const current: Settings = { glass, theme, language, leftPanelWidth, welcomeTour };
    return Promise.resolve({ ...current, ...patch });
  });
  openWelcomeMock.mockReset();
  openWelcomeMock.mockImplementation(() => {
    show(WELCOME);
    return Promise.resolve({ type: 'opened', document: WELCOME });
  });
  resetFirstLaunch();
  unbind = bindTour();
});

afterEach(() => {
  unbind();
  useTour.getState().end('restart');
  vi.useRealTimers();
});

const tour = () => useTour.getState();

describe('starting', () => {
  it('starts at step 1 when a welcome document opens, and marks the tour as shown', () => {
    show(WELCOME);
    expect(tour()).toMatchObject({ docId: 1, index: 0, phase: 'waiting' });
    expect(updateSettingsMock).toHaveBeenCalledWith({ welcomeTour: 'shown' });
  });

  it('does not start for a document the user opened', () => {
    show(USER);
    expect(tour().docId).toBeNull();
    expect(updateSettingsMock).not.toHaveBeenCalled();
  });

  it('does not write the setting again on a restart when it is shown already', () => {
    useSettings.setState({ welcomeTour: 'shown' });
    show(WELCOME);
    expect(tour().docId).toBe(1);
    expect(updateSettingsMock).not.toHaveBeenCalled();
  });
});

describe('the steps', () => {
  it('runs Open, Navigate and Zoom with a success moment between them, then ends', () => {
    show(WELCOME);
    vi.advanceTimersByTime(OPEN_SETTLE_MS);
    expect(tour().phase).toBe('done');
    vi.advanceTimersByTime(HOLD_MS);
    expect(tour()).toMatchObject({ index: 1, phase: 'waiting' });

    // Navigate: page 2 counts once scrolling has settled.
    useView.getState().reportPage(1, 1);
    vi.advanceTimersByTime(NAVIGATE_SETTLE_MS - 1);
    expect(tour().phase).toBe('waiting');
    vi.advanceTimersByTime(1);
    expect(tour().phase).toBe('done');
    vi.advanceTimersByTime(HOLD_MS);
    expect(tour()).toMatchObject({ index: 2, phase: 'waiting' });

    // Zoom: 1.2 times the zoom at the step start.
    useView.getState().setZoom(1, 1.19);
    expect(tour().phase).toBe('waiting');
    useView.getState().setZoom(1, 1.2);
    expect(tour().phase).toBe('done');
    vi.advanceTimersByTime(HOLD_MS);
    expect(tour().phase).toBe('finishing');
    vi.advanceTimersByTime(HOLD_MS);
    expect(tour().docId).toBeNull();
  });

  it('does not count a page that was left again before it settled', () => {
    show(WELCOME);
    vi.advanceTimersByTime(OPEN_SETTLE_MS + HOLD_MS);
    useView.getState().reportPage(1, 1);
    vi.advanceTimersByTime(NAVIGATE_SETTLE_MS - 100);
    useView.getState().reportPage(1, 0);
    vi.advanceTimersByTime(NAVIGATE_SETTLE_MS * 2);
    expect(tour()).toMatchObject({ index: 1, phase: 'waiting' });
  });

  it('completes a step at once when its state is true at the step start', () => {
    show(WELCOME);
    useView.getState().reportPage(1, 2);
    vi.advanceTimersByTime(OPEN_SETTLE_MS + HOLD_MS);
    expect(tour()).toMatchObject({ index: 1, phase: 'done' });
  });
});

describe('ending', () => {
  it('ends when the welcome document is closed, and nothing resumes', () => {
    show(WELCOME);
    useDocuments.getState().remove(1);
    expect(tour().docId).toBeNull();
    vi.advanceTimersByTime(OPEN_SETTLE_MS * 2);
    expect(tour().docId).toBeNull();
  });

  it('ends when another document opens over it', () => {
    show(WELCOME);
    show(USER);
    expect(tour().docId).toBeNull();
  });

  it('ends on skip and leaves the document open', () => {
    show(WELCOME);
    tour().skip();
    expect(tour().docId).toBeNull();
    expect(useDocuments.getState().byId[1]).toBeDefined();
    vi.advanceTimersByTime(OPEN_SETTLE_MS * 2);
    expect(tour().docId).toBeNull();
  });

  it('hides and shows the card without ending the tour', () => {
    show(WELCOME);
    tour().hide();
    expect(tour()).toMatchObject({ docId: 1, hidden: true });
    tour().toggle();
    expect(tour().hidden).toBe(false);
  });
});

describe('first launch', () => {
  it('writes shown first, then opens the welcome document, and only once', async () => {
    useSettings.setState({ welcomeTour: 'pending' });
    const order: string[] = [];
    updateSettingsMock.mockImplementationOnce((patch) => {
      order.push('settings');
      return Promise.resolve({ ...settingsInitial, ...patch } as Settings);
    });
    openWelcomeMock.mockImplementationOnce(() => {
      order.push('open');
      show(WELCOME);
      return Promise.resolve({ type: 'opened', document: WELCOME });
    });
    const first = maybeFirstLaunch();
    const second = maybeFirstLaunch();
    await vi.advanceTimersByTimeAsync(LAUNCH_SETTLE_MS);
    await Promise.all([first, second]);
    expect(order).toEqual(['settings', 'open']);
    expect(openWelcomeMock).toHaveBeenCalledTimes(1);
    expect(tour().docId).toBe(1);
  });

  it('does nothing once the tour was shown or before the settings are loaded', async () => {
    useSettings.setState({ welcomeTour: 'shown' });
    const a = maybeFirstLaunch();
    useSettings.setState({ welcomeTour: 'pending', loaded: false });
    const b = maybeFirstLaunch();
    await vi.advanceTimersByTimeAsync(LAUNCH_SETTLE_MS);
    await Promise.all([a, b]);
    expect(openWelcomeMock).not.toHaveBeenCalled();
    expect(updateSettingsMock).not.toHaveBeenCalled();
  });

  it('writes shown but opens no welcome document when a document came with the launch', async () => {
    useSettings.setState({ welcomeTour: 'pending' });
    useDocuments.getState().add(USER);
    const run = maybeFirstLaunch();
    await vi.advanceTimersByTimeAsync(LAUNCH_SETTLE_MS);
    await run;
    expect(updateSettingsMock).toHaveBeenCalledWith({ welcomeTour: 'shown' });
    expect(openWelcomeMock).not.toHaveBeenCalled();
    expect(tour().docId).toBeNull();
  });

  it('waits for a launch document that arrives late before deciding', async () => {
    useSettings.setState({ welcomeTour: 'pending' });
    const run = maybeFirstLaunch();
    await vi.advanceTimersByTimeAsync(LAUNCH_SETTLE_MS - 100);
    show(USER);
    await vi.advanceTimersByTimeAsync(100);
    await run;
    expect(openWelcomeMock).not.toHaveBeenCalled();
    expect(updateSettingsMock).toHaveBeenCalledWith({ welcomeTour: 'shown' });
  });
});
