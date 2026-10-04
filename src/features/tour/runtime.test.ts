// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { updateSettings, type Settings } from '../../api/app';
import { openWelcomeDocument, type DocumentInfo } from '../../api/documents';
import type { Annotation } from '../../api/annotations';
import { EMPTY_HISTORY, useAnnotations } from '../../stores/annotations';
import { useDocuments } from '../../stores/documents';
import { usePages } from '../../stores/pages';
import { useSettings } from '../../stores/settings';
import { useView } from '../../stores/view';
import { HOLD_MS, NAVIGATE_SETTLE_MS, SIGN_SETTLE_MS } from './engine';
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
const annotationsInitial = useAnnotations.getState();
const pagesInitial = usePages.getState();

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
  useAnnotations.setState({ ...annotationsInitial }, true);
  usePages.setState({ ...pagesInitial }, true);
  updateSettingsMock.mockReset();
  updateSettingsMock.mockImplementation((patch) => {
    const { language, leftPanelWidth, welcomeTour, authorName, authorPrompt } = useSettings.getState();
    const current: Settings = { language, leftPanelWidth, welcomeTour, authorName, authorPrompt };
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
    useSettings.setState({ welcomeTour: 'shown', authorName: 'Author' });
    show(WELCOME);
    expect(tour().docId).toBe(1);
    expect(updateSettingsMock).not.toHaveBeenCalled();
  });
});

describe('the steps', () => {
  /** Puts annotations into the replica of the welcome document, as a change set would. */
  function annotate(...annotations: Annotation[]) {
    const byId = Object.fromEntries(annotations.map((annotation) => [annotation.id, annotation]));
    useAnnotations.setState({
      byDoc: { 1: { rev: 1, byId, loaded: {}, removed: {}, history: EMPTY_HISTORY } },
    });
  }
  const base = {
    color: [0, 0, 0],
    opacity: 1,
    contents: '',
    author: null,
    modified: null,
    inReplyTo: null,
    locked: false,
    sync: 'new',
  } as const;
  const markup = (id: number, pageId: number, x: number, w: number): Annotation => ({
    ...base,
    id,
    pageId,
    rect: { x, y: 268, w, h: 18 },
    kind: 'highlight',
    quads: [
      [
        { x, y: 268 },
        { x: x + w, y: 268 },
        { x, y: 286 },
        { x: x + w, y: 286 },
      ],
    ],
  });
  const slots = (order: number[]) =>
    usePages.getState().setSlots(
      1,
      order.map((id) => ({ id, width: 600, height: 800, rotation: 0, rev: 0, label: null, origin: 'file' as const })),
    );

  it('runs all seven steps with a success moment between them, then ends', () => {
    show(WELCOME);
    slots([0, 1, 2, 3, 4]);
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

    // Zoom: any zoom-in above the zoom at the step start.
    useView.getState().setZoom(1, 0.9);
    expect(tour().phase).toBe('waiting');
    useView.getState().setZoom(1, 1.1);
    expect(tour().phase).toBe('done');
    vi.advanceTimersByTime(HOLD_MS);
    expect(tour()).toMatchObject({ index: 3, phase: 'waiting' });

    // Highlight: too little of the sentence does not count, half of it does.
    annotate(markup(1, 2, 72, 60));
    expect(tour().phase).toBe('waiting');
    annotate(markup(1, 2, 72, 150));
    expect(tour().phase).toBe('done');
    vi.advanceTimersByTime(HOLD_MS);
    expect(tour()).toMatchObject({ index: 4, phase: 'waiting' });

    // Note: a note near the dot, on page M.
    annotate(markup(1, 2, 72, 150), {
      ...base,
      id: 2,
      pageId: 2,
      rect: { x: 480, y: 392, w: 24, h: 24 },
      kind: 'note',
      at: { x: 481, y: 393 },
      icon: 'note',
    });
    expect(tour().phase).toBe('done');
    vi.advanceTimersByTime(HOLD_MS);
    expect(tour()).toMatchObject({ index: 5, phase: 'waiting' });

    // Sign: placed outside the frame first, then dragged in; it counts once it has settled.
    const signature = (x: number): Annotation => ({
      ...base,
      id: 3,
      pageId: 3,
      rect: { x, y: 260, w: 120, h: 40 },
      kind: 'signature',
      box: { x, y: 260, w: 120, h: 40 },
      role: 'signature',
      art: { type: 'asset', assetId: 1, aspect: 3 },
    });
    annotate(signature(400));
    vi.advanceTimersByTime(SIGN_SETTLE_MS * 2);
    expect(tour().phase).toBe('waiting');
    annotate(signature(80));
    vi.advanceTimersByTime(SIGN_SETTLE_MS - 1);
    expect(tour().phase).toBe('waiting');
    vi.advanceTimersByTime(1);
    expect(tour().phase).toBe('done');
    vi.advanceTimersByTime(HOLD_MS);
    expect(tour()).toMatchObject({ index: 6, phase: 'waiting' });

    // Reorder: page S above page M, whatever moved it.
    slots([0, 1, 2, 4, 3]);
    expect(tour().phase).toBe('waiting');
    slots([0, 1, 3, 2, 4]);
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
    useSettings.setState({ welcomeTour: 'pending', authorName: 'Author' });
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
    useSettings.setState({ welcomeTour: 'shown', authorName: 'Author' });
    const a = maybeFirstLaunch();
    useSettings.setState({ welcomeTour: 'pending', authorName: 'Author', loaded: false });
    const b = maybeFirstLaunch();
    await vi.advanceTimersByTimeAsync(LAUNCH_SETTLE_MS);
    await Promise.all([a, b]);
    expect(openWelcomeMock).not.toHaveBeenCalled();
    expect(updateSettingsMock).not.toHaveBeenCalled();
  });

  it('writes shown but opens no welcome document when a document came with the launch', async () => {
    useSettings.setState({ welcomeTour: 'pending', authorName: 'Author' });
    useDocuments.getState().add(USER);
    const run = maybeFirstLaunch();
    await vi.advanceTimersByTimeAsync(LAUNCH_SETTLE_MS);
    await run;
    expect(updateSettingsMock).toHaveBeenCalledWith({ welcomeTour: 'shown' });
    expect(openWelcomeMock).not.toHaveBeenCalled();
    expect(tour().docId).toBeNull();
  });

  it('waits for a launch document that arrives late before deciding', async () => {
    useSettings.setState({ welcomeTour: 'pending', authorName: 'Author' });
    const run = maybeFirstLaunch();
    await vi.advanceTimersByTimeAsync(LAUNCH_SETTLE_MS - 100);
    show(USER);
    await vi.advanceTimersByTimeAsync(100);
    await run;
    expect(openWelcomeMock).not.toHaveBeenCalled();
    expect(updateSettingsMock).toHaveBeenCalledWith({ welcomeTour: 'shown' });
  });
});
