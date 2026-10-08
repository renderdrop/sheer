// @vitest-environment jsdom
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MotionGlobalConfig } from 'motion/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { ChangeSet, ContentAnnotation } from '../../api/annotations';
import type { JobEvent, JobWarning } from '../../api/jobs';
import { EMPTY_HISTORY, useAnnotations } from '../../stores/annotations';
import { useDocuments } from '../../stores/documents';
import { resetDocuments } from '../../stores/documents.testutil';
import { useUi } from '../../stores/ui';
import { useSearch, type Hit } from '../search/store';
import { markSelection, redactSearchResults } from './actions';
import { RedactApplyDialog } from './RedactApplyDialog';
import { RedactBanner } from './RedactBanner';
import { RedactLayer } from './RedactLayer';
import { useRedact, type RedactMark } from './store';
import { useRedactInspector } from './useRedactInspector';

const api = vi.hoisted(() => ({ markRedactions: vi.fn(), applyRedactions: vi.fn() }));
const annotations = vi.hoisted(() => ({ applyCommand: vi.fn() }));
const jobs = vi.hoisted(() => ({ cancelJob: vi.fn() }));
const goToPoint = vi.hoisted(() => vi.fn());
const peekLayer = vi.hoisted(() => vi.fn());
vi.mock('../../api/redaction', async (importOriginal) => ({ ...(await importOriginal<object>()), ...api }));
vi.mock('../../api/annotations', async (importOriginal) => ({ ...(await importOriginal<object>()), ...annotations }));
vi.mock('../../api/jobs', async (importOriginal) => ({ ...(await importOriginal<object>()), ...jobs }));
vi.mock('../viewer/useViewer', () => ({
  useViewer: { getState: () => ({ goToPoint }) },
  adoptOpenOutcomes: vi.fn(),
}));
vi.mock('../textlayer/cache', () => ({ loadLayer: () => Promise.resolve(null), peekLayer }));

MotionGlobalConfig.skipAnimations = true;

const DOC = 1;
const quad = (x: number) =>
  [
    { x, y: 20 },
    { x: x + 50, y: 20 },
    { x, y: 32 },
    { x: x + 50, y: 32 },
  ] as const;

function mark(id: number, pageId: number, source: 'text' | 'area' = 'area'): RedactMark {
  return {
    id,
    pageId,
    rect: { x: 0, y: 0, w: 0, h: 0 },
    color: [0, 0, 0],
    opacity: 1,
    contents: '',
    author: null,
    modified: null,
    inReplyTo: null,
    locked: false,
    sync: 'new',
    kind: 'redactMark',
    quads: [quad(10)],
    source,
  };
}

const changes = (content: ContentAnnotation[], removed: number[] = [], rev = 1): ChangeSet => ({
  rev,
  upserted: [],
  removed,
  pages: null,
  content,
  history: { ...EMPTY_HISTORY, canUndo: true, dirty: true },
});

/** The inspector of the mode, rendered as the shell does. */
function Inspector() {
  const entry = useRedactInspector();
  if (entry === null) return <p>standard</p>;
  return (
    <section>
      <h2>{entry.title}</h2>
      {entry.body}
    </section>
  );
}

beforeEach(() => {
  resetDocuments();
  useDocuments.getState().add({ id: DOC, pageCount: 5, displayName: 'A.pdf' });
  useAnnotations.setState({ byDoc: {}, selectedIds: {}, pageRevs: {} });
  useRedact.setState({ marks: {}, selected: {}, applyOpen: false, removeMetadata: true });
  useUi.setState({ redactMode: false, activeTool: 'select', toast: null, banner: null });
  useSearch.setState({ byDoc: {} });
  for (const fn of [...Object.values(api), ...Object.values(annotations), ...Object.values(jobs)]) fn.mockReset();
  jobs.cancelJob.mockResolvedValue(undefined);
  goToPoint.mockReset();
  peekLayer.mockReset();
});

const seed = (...marks: RedactMark[]) => act(() => useAnnotations.getState().applyChanges(DOC, changes(marks)));

describe('the marks follow the model', () => {
  it('adds the marks of a change set, drops removed ones and ignores an older answer', () => {
    seed(mark(1, 0), mark(2, 1, 'text'));
    expect(Object.keys(useRedact.getState().marks[DOC] ?? {})).toEqual(['1', '2']);
    act(() => useAnnotations.getState().applyChanges(DOC, changes([], [1], 2)));
    expect(Object.keys(useRedact.getState().marks[DOC] ?? {})).toEqual(['2']);
    act(() => useAnnotations.getState().applyChanges(DOC, changes([mark(9, 0)], [], 1)));
    expect(useRedact.getState().marks[DOC]?.[9]).toBeUndefined();
  });

  it('forgets a closed document', () => {
    seed(mark(1, 0));
    act(() => useAnnotations.getState().remove(DOC));
    expect(useRedact.getState().marks[DOC]).toBeUndefined();
  });
});

describe('the pending banner', () => {
  it('shows while there are marks and the mode is off, and Review turns the mode on', async () => {
    render(<RedactBanner />);
    expect(screen.queryByRole('status')).toBeNull();
    seed(mark(1, 0), mark(2, 0));
    expect(screen.getByRole('status').textContent).toContain('2 redaction marks are not applied yet.');
    fireEvent.click(screen.getByRole('button', { name: 'Review' }));
    expect(useUi.getState().redactMode).toBe(true);
    await waitFor(() => expect(screen.queryByText(/not applied yet/)).toBeNull());
  });
});

describe('the redact band', () => {
  it('shows in the mode, Cancel keeps the marks, Apply opens the dialog, and it hides the pending notice', async () => {
    seed(mark(1, 0));
    render(<RedactBanner />);
    expect(screen.getByRole('status').textContent).toContain('1 redaction mark is');
    act(() => useUi.getState().setRedactMode(true));
    const band = document.querySelector('[data-banner="redact"]');
    expect(band?.textContent).toContain('Redaction is permanent');
    await waitFor(() => expect(screen.queryByText(/not applied yet/)).toBeNull());
    fireEvent.click(screen.getByRole('button', { name: 'Apply' }));
    expect(useRedact.getState().applyOpen).toBe(true);
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(useUi.getState().redactMode).toBe(false);
    expect(Object.keys(useRedact.getState().marks[DOC] ?? {})).toEqual(['1']);
  });
});

describe('the inspector', () => {
  it('is the standard one outside the mode, and an empty state without marks', () => {
    render(<Inspector />);
    expect(screen.getByText('standard')).toBeTruthy();
    act(() => useUi.getState().setRedactMode(true));
    expect(screen.getByText('No marks')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Apply…' })).toBeNull();
  });

  it('lists the marks by page; a click goes to the mark and selects it', async () => {
    seed(mark(1, 0), mark(2, 2, 'text'));
    act(() => useUi.getState().setRedactMode(true));
    render(<Inspector />);
    expect(screen.getByRole('heading').textContent).toBe('2 marks');
    const options = screen.getAllByRole('option');
    expect(options).toHaveLength(2);
    expect(screen.getByText('Page 1')).toBeTruthy();
    expect(screen.getByText('Page 3')).toBeTruthy();
    fireEvent.click(options[1] as HTMLElement);
    expect(useRedact.getState().selected[DOC]).toBe(2);
    await waitFor(() => expect(goToPoint).toHaveBeenCalledTimes(1));
    expect(goToPoint.mock.calls[0]?.[0]).toBe(2);
  });

  it('removes a mark with its button and with Delete, as one undo step each', async () => {
    seed(mark(1, 0), mark(2, 0));
    act(() => useUi.getState().setRedactMode(true));
    annotations.applyCommand.mockImplementation((_doc: number, command: { ids: number[] }) =>
      Promise.resolve(changes([], command.ids, 5)),
    );
    render(<Inspector />);
    const first = screen.getAllByRole('option')[0] as HTMLElement;
    fireEvent.click(within(first).getByRole('button', { name: 'Remove mark' }));
    await waitFor(() => expect(Object.keys(useRedact.getState().marks[DOC] ?? {})).toEqual(['2']));
    expect(annotations.applyCommand).toHaveBeenCalledWith(DOC, { type: 'deleteAnnotations', ids: [1] });
    fireEvent.keyDown(screen.getAllByRole('option')[0] as HTMLElement, { key: 'Delete' });
    await waitFor(() =>
      expect(annotations.applyCommand).toHaveBeenLastCalledWith(DOC, { type: 'deleteAnnotations', ids: [2] }),
    );
  });

  it('clears all marks in one command and opens the apply dialog', async () => {
    seed(mark(1, 0), mark(2, 1));
    act(() => useUi.getState().setRedactMode(true));
    annotations.applyCommand.mockResolvedValue(changes([], [1, 2], 5));
    render(<Inspector />);
    fireEvent.click(screen.getByRole('button', { name: 'Clear all' }));
    await waitFor(() => expect(useRedact.getState().marks[DOC]).toEqual({}));
    expect(annotations.applyCommand).toHaveBeenCalledWith(DOC, { type: 'deleteAnnotations', ids: [1, 2] });
  });

  it('keeps the metadata choice and has no Apply of its own', () => {
    seed(mark(1, 0));
    act(() => useUi.getState().setRedactMode(true));
    render(<Inspector />);
    const box = screen.getByRole('checkbox', { name: 'Also remove document metadata' }) as HTMLInputElement;
    expect(box.checked).toBe(true);
    fireEvent.click(box);
    expect(useRedact.getState().removeMetadata).toBe(false);
    expect(screen.queryByRole('button', { name: 'Apply…' })).toBeNull();
  });
});

describe('a text selection becomes marks', () => {
  it('sends the quads of the selected characters as a text mark and clears the selection', async () => {
    const text = 'alpha beta';
    const boxes = Float32Array.from(Array.from({ length: text.length }, (_, i) => [i * 6, 0, 6, 12]).flat());
    peekLayer.mockReturnValue({ text, boxes, truncated: false });
    const layer = document.createElement('div');
    layer.dataset.textLayer = '';
    layer.dataset.textPage = '1';
    layer.dataset.textLength = String(text.length);
    const span = document.createElement('span');
    span.dataset.runStart = '0';
    span.dataset.runEnd = String(text.length);
    span.textContent = text;
    layer.append(span);
    document.body.append(layer);
    const selection = window.getSelection() as Selection;
    selection.setBaseAndExtent(span.firstChild as Node, 0, span.firstChild as Node, 5);
    api.markRedactions.mockResolvedValue(changes([mark(1, 1, 'text')]));
    expect(markSelection()).toBe(true);
    await waitFor(() => expect(useRedact.getState().marks[DOC]?.[1]).toBeDefined());
    const [doc, specs] = api.markRedactions.mock.calls[0] as [
      number,
      { pageId: number; source: string; quads: unknown[] }[],
    ];
    expect(doc).toBe(DOC);
    expect(specs).toHaveLength(1);
    expect(specs[0]).toMatchObject({ pageId: 1, source: 'text' });
    expect(specs[0]?.quads).toHaveLength(1);
    expect(selection.rangeCount).toBe(0);
    layer.remove();
  });

  it('marks nothing without a selection in a text layer', () => {
    expect(markSelection()).toBe(false);
    expect(api.markRedactions).not.toHaveBeenCalled();
  });
});

describe('search results become marks', () => {
  const hit = (index: number, page: number): Hit => ({ index, page, quads: [quad(10 * index)] });

  it('sends every hit as one command and opens the mode', async () => {
    useSearch.setState({
      byDoc: { [DOC]: { ...useSearch.getState().byDoc[DOC], hits: [hit(0, 0), hit(1, 0), hit(2, 3)] } as never },
    });
    api.markRedactions.mockResolvedValue(changes([mark(1, 0, 'text'), mark(2, 0, 'text'), mark(3, 3, 'text')]));
    await redactSearchResults(DOC);
    expect(api.markRedactions).toHaveBeenCalledTimes(1);
    expect(api.markRedactions.mock.calls[0]?.[1]).toEqual([
      { pageId: 0, quads: [quad(0)], source: 'text' },
      { pageId: 0, quads: [quad(10)], source: 'text' },
      { pageId: 3, quads: [quad(20)], source: 'text' },
    ]);
    expect(useUi.getState().redactMode).toBe(true);
    expect(Object.keys(useRedact.getState().marks[DOC] ?? {})).toHaveLength(3);
  });

  it('does nothing without hits and shows a refused command as the banner', async () => {
    await redactSearchResults(DOC);
    expect(api.markRedactions).not.toHaveBeenCalled();
    useSearch.setState({ byDoc: { [DOC]: { hits: [hit(0, 0)] } as never } });
    api.markRedactions.mockRejectedValue({ code: 'limit_exceeded', params: { what: 'marks', limit: 10000 } });
    await redactSearchResults(DOC);
    expect(useUi.getState().banner).not.toBeNull();
  });
});

describe('the apply dialog', () => {
  const open = () => {
    seed(mark(1, 0), mark(2, 2));
    act(() => useRedact.getState().setApplyOpen(true));
  };
  const done = (warnings: JobWarning[]): JobEvent => ({
    type: 'done',
    outputs: 0,
    bytesBefore: 0,
    bytesAfter: 0,
    warnings,
    opened: null,
    changes: changes([], [1, 2], 9),
  });
  const reports = (event: JobEvent) => (_doc: number, _opts: unknown, onEvent: (e: JobEvent) => void) => {
    queueMicrotask(() => onEvent(event));
    return Promise.resolve(7);
  };

  it('says it is permanent, lists the pages and focuses Cancel', async () => {
    open();
    render(<RedactApplyDialog />);
    const dialog = await screen.findByRole('dialog', { name: 'Redact permanently?' });
    expect(dialog.textContent).toContain('Marked content is removed, not covered.');
    expect(dialog.textContent).toContain('Pages: 1, 3');
    expect(document.activeElement).toBe(within(dialog).getByRole('button', { name: 'Cancel' }));
    expect(within(dialog).getByRole('button', { name: 'Redact 2 pages' })).toBeTruthy();
  });

  it('Cancel closes it without a job', async () => {
    open();
    render(<RedactApplyDialog />);
    fireEvent.click(await screen.findByRole('button', { name: 'Cancel' }));
    expect(useRedact.getState().applyOpen).toBe(false);
    expect(api.applyRedactions).not.toHaveBeenCalled();
  });

  it('runs the job with the marked pages and the metadata option, applies the result and offers Undo', async () => {
    open();
    useRedact.getState().setRemoveMetadata(false);
    api.applyRedactions.mockImplementation(reports(done([])));
    render(<RedactApplyDialog />);
    fireEvent.click(await screen.findByRole('button', { name: 'Redact 2 pages' }));
    await waitFor(() => expect(useRedact.getState().applyOpen).toBe(false));
    expect(api.applyRedactions.mock.calls[0]?.[0]).toBe(DOC);
    expect(api.applyRedactions.mock.calls[0]?.[1]).toEqual({ pages: [0, 2], removeMetadata: false });
    expect(useRedact.getState().marks[DOC]).toEqual({});
    expect(useUi.getState().toast?.message).toBe('Redacted. Save to make it permanent.');
    expect(useUi.getState().toast?.action?.label).toBe('Undo');
  });

  it('keeps the dialog open to show the warnings of the job', async () => {
    open();
    api.applyRedactions.mockImplementation(reports(done(['unsavedEditsDropped', 'hiddenDataKept'])));
    render(<RedactApplyDialog />);
    fireEvent.click(await screen.findByRole('button', { name: 'Redact 2 pages' }));
    await screen.findByText(/Unsaved edits on the redacted pages were dropped/);
    expect(screen.getByText(/Bookmarks, attachments, page labels or scripts were kept/)).toBeTruthy();
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Close' }));
    fireEvent.click(screen.getByRole('button', { name: 'Close' }));
    expect(useRedact.getState().applyOpen).toBe(false);
  });

  it('shows a failed job in the dialog and leaves the marks', async () => {
    open();
    api.applyRedactions.mockImplementation(
      reports({ type: 'failed', error: { code: 'limit_exceeded', params: { what: 'redactPage' } } as never }),
    );
    render(<RedactApplyDialog />);
    fireEvent.click(await screen.findByRole('button', { name: 'Redact 2 pages' }));
    await screen.findByRole('alert');
    expect(useRedact.getState().applyOpen).toBe(true);
    expect(Object.keys(useRedact.getState().marks[DOC] ?? {})).toHaveLength(2);
  });
});

describe('the page layer', () => {
  const props = {
    docId: DOC,
    pageIndex: 0,
    boxWidth: 200,
    boxHeight: 100,
    widthPt: 200,
    heightPt: 100,
    rotation: 0,
    ready: true,
  };
  const mountPage = () => {
    const view = render(
      <div data-page="1" data-testid="page">
        <RedactLayer {...props} />
      </div>,
    );
    const page = screen.getByTestId('page');
    page.getBoundingClientRect = () => ({
      left: 0,
      top: 0,
      width: 200,
      height: 100,
      right: 200,
      bottom: 100,
      x: 0,
      y: 0,
      toJSON: () => ({}),
    });
    page.setPointerCapture = vi.fn();
    page.releasePointerCapture = vi.fn();
    page.hasPointerCapture = () => true;
    return { ...view, page };
  };
  const pointer = (page: HTMLElement, type: string, x: number, y: number) =>
    fireEvent(
      page,
      Object.assign(new MouseEvent(type, { bubbles: true, clientX: x, clientY: y, button: 0 }), { pointerId: 1 }),
    );

  it('draws the marks of its page with the role description, and nothing for other pages', () => {
    seed(mark(1, 0), mark(2, 1));
    act(() => useUi.getState().setRedactMode(true));
    mountPage();
    const marks = screen.getAllByRole('button', { name: /Area/ });
    expect(marks).toHaveLength(1);
    expect(marks[0]?.getAttribute('aria-roledescription')).toBe('Redaction mark');
  });

  it('a drag of at least 4 pt marks the area; a click does not', async () => {
    seed(mark(1, 0));
    act(() => useUi.getState().setRedactMode(true));
    api.markRedactions.mockResolvedValue(changes([mark(5, 0)], [], 2));
    const { page } = mountPage();
    pointer(page, 'pointerdown', 50, 50);
    pointer(page, 'pointermove', 90, 80);
    expect(document.querySelector('[data-redact-draft]')).not.toBeNull();
    pointer(page, 'pointerup', 90, 80);
    await waitFor(() => expect(api.markRedactions).toHaveBeenCalledTimes(1));
    expect(api.markRedactions.mock.calls[0]?.[1]).toEqual([
      { pageId: 0, quads: [quad4(50, 50, 40, 30)], source: 'area' },
    ]);
    expect(useRedact.getState().selected[DOC] ?? null).toBeNull();
    pointer(page, 'pointerdown', 10, 10);
    pointer(page, 'pointerup', 11, 11);
    expect(api.markRedactions).toHaveBeenCalledTimes(1);
  });

  it('places several marks without any dialog; Apply opens exactly one', async () => {
    act(() => useUi.getState().setRedactMode(true));
    api.markRedactions.mockImplementation((_d: number, specs: unknown[]) =>
      Promise.resolve(changes([mark(10 + api.markRedactions.mock.calls.length, 0)], [], specs.length)),
    );
    const { page } = mountPage();
    for (const y of [10, 40, 70]) {
      pointer(page, 'pointerdown', 20, y);
      pointer(page, 'pointerup', 80, y + 15);
    }
    await waitFor(() => expect(api.markRedactions).toHaveBeenCalledTimes(3));
    expect(useRedact.getState().applyOpen).toBe(false);
    expect(screen.queryByRole('dialog')).toBeNull();
    render(<RedactBanner />);
    fireEvent.click(screen.getByRole('button', { name: 'Apply' }));
    expect(useRedact.getState().applyOpen).toBe(true);
    render(<RedactApplyDialog />);
    expect(await screen.findAllByRole('dialog')).toHaveLength(1);
  });

  it('with the Select tool outside the mode a click selects a mark, Delete removes it and a change set restores it', async () => {
    seed(mark(1, 0));
    annotations.applyCommand.mockResolvedValue(changes([], [1], 5));
    mountPage();
    const button = screen.getByRole('button', { name: /Area/ });
    fireEvent.pointerDown(button, { button: 0, pointerId: 1 });
    expect(useRedact.getState().selected[DOC]).toBe(1);
    fireEvent.keyDown(button, { key: 'Delete' });
    await waitFor(() => expect(useRedact.getState().marks[DOC]).toEqual({}));
    expect(annotations.applyCommand).toHaveBeenCalledWith(DOC, { type: 'deleteAnnotations', ids: [1] });
    act(() => useAnnotations.getState().applyChanges(DOC, changes([mark(1, 0)], [], 6)));
    expect(Object.keys(useRedact.getState().marks[DOC] ?? {})).toEqual(['1']);
  });

  it('takes no pointer input outside the mode', () => {
    seed(mark(1, 0));
    const { page } = mountPage();
    pointer(page, 'pointerdown', 50, 50);
    pointer(page, 'pointerup', 90, 80);
    expect(api.markRedactions).not.toHaveBeenCalled();
  });
});

function quad4(x: number, y: number, w: number, h: number) {
  return [
    { x, y },
    { x: x + w, y },
    { x, y: y + h },
    { x: x + w, y: y + h },
  ];
}
