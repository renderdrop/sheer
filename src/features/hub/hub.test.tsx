// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { DocumentInfo, OpenOutcome } from '../../api/documents';
import { activeDocument, opened, resetDocuments } from '../../stores/documents.testutil';
import { useUi } from '../../stores/ui';
import { useView } from '../../stores/view';
import { useJobs } from '../jobs/state';
import { useViewer } from '../viewer/useViewer';
import { useHub } from './intent';
import { runHubCard } from './run';

const documentsApi = vi.hoisted(() => ({
  openDocumentDialog: vi.fn(),
  closeDocument: vi.fn(),
}));
const formsApi = vi.hoisted(() => ({
  load: vi.fn(),
  focusFirstEmpty: vi.fn(),
}));

vi.mock('../../api/documents', () => documentsApi);
vi.mock('../../api/render', () => ({
  renderPage: vi.fn(),
  setViewport: vi.fn().mockResolvedValue(undefined),
  getPageSizes: vi.fn().mockResolvedValue([]),
}));
vi.mock('../../api/pages', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../api/pages')>()),
  getPages: vi.fn().mockResolvedValue([]),
}));
vi.mock('../forms/focus', () => ({ focusFirstEmpty: formsApi.focusFirstEmpty }));

import { useForms } from '../forms/store';

const uiInitial = useUi.getState();
const viewerInitial = useViewer.getState();
const formsInitial = useForms.getState();
const A: DocumentInfo = { id: 1, pageCount: 3, displayName: 'A.pdf' };
const B: DocumentInfo = { id: 2, pageCount: 5, displayName: 'B.pdf' };

function reset() {
  useUi.setState({ ...uiInitial }, true);
  useViewer.setState({ ...viewerInitial }, true);
  useForms.setState({ ...formsInitial }, true);
  useHub.setState({ busy: null, pending: null });
  useJobs.setState({ sheet: null, drop: null });
  resetDocuments();
  useView.setState({ byDoc: {} });
}

const answer = (...outcomes: OpenOutcome[]) => documentsApi.openDocumentDialog.mockResolvedValueOnce(outcomes);

beforeEach(() => {
  reset();
  documentsApi.openDocumentDialog.mockReset().mockResolvedValue([]);
  documentsApi.closeDocument.mockReset().mockResolvedValue(undefined);
  formsApi.focusFirstEmpty.mockReset();
});

afterEach(() => {
  vi.restoreAllMocks();
  reset();
});

describe('hub card intents (DESIGN 3.54)', () => {
  it('a cancelled file dialog changes nothing and frees the guard', async () => {
    await runHubCard('split');
    expect(activeDocument()).toBeNull();
    expect(useJobs.getState().sheet).toBeNull();
    expect(useHub.getState().busy).toBeNull();
    expect(useViewer.getState().opening).toBe(false);
  });

  it('Open uses the viewer open and opens every chosen file', async () => {
    answer(opened(A), opened(B));
    await runHubCard('open');
    expect(documentsApi.openDocumentDialog).toHaveBeenCalledTimes(1);
    expect(activeDocument()).toEqual(B);
  });

  it('Merge holds the files in pick order for the merge sheet and opens no tab', async () => {
    answer(opened(B), opened(A));
    await runHubCard('merge');
    expect(useJobs.getState().sheet).toEqual({ kind: 'merge', held: [B, A] });
    expect(activeDocument()).toBeNull();
  });

  it('Merge with one file still shows the sheet (Merge disabled there)', async () => {
    answer(opened(A));
    await runHubCard('merge');
    expect(useJobs.getState().sheet).toEqual({ kind: 'merge', held: [A] });
  });

  it('Split opens the file in Organize with the Split dialog on top', async () => {
    answer(opened(A));
    await runHubCard('split');
    expect(activeDocument()).toEqual(A);
    expect(useUi.getState().activeTool).toBe('pages');
    expect(useJobs.getState().sheet).toEqual({ kind: 'split', mode: 'every' });
  });

  it('one-file cards keep the first file and close the others', async () => {
    answer(opened(A), opened(B));
    await runHubCard('compress');
    expect(activeDocument()).toEqual(A);
    expect(documentsApi.closeDocument).toHaveBeenCalledWith(B.id, true);
  });

  it('Compress opens the file with the Compress dialog on top', async () => {
    answer(opened(A));
    await runHubCard('compress');
    expect(activeDocument()).toEqual(A);
    expect(useJobs.getState().sheet).toEqual({ kind: 'compress' });
  });

  it('Redact opens the file in Redact mode', async () => {
    answer(opened(A));
    await runHubCard('redact');
    expect(activeDocument()).toEqual(A);
    expect(useUi.getState().redactMode).toBe(true);
  });

  it('Sign opens the file and clicks the Fill & Sign toolbar item', async () => {
    const item = document.createElement('button');
    item.setAttribute('data-toolbar-item', 'signature');
    const click = vi.fn();
    item.addEventListener('click', click);
    document.body.append(item);
    answer(opened(A));
    await runHubCard('sign');
    item.remove();
    expect(activeDocument()).toEqual(A);
    expect(click).toHaveBeenCalledTimes(1);
  });

  it('Fill form with fields turns the highlight on and focuses the first empty field', async () => {
    const field = { id: 1 } as never;
    vi.spyOn(useForms.getState(), 'load').mockImplementation(() => {
      useForms.setState({ byDoc: { 1: { status: 'ready', fields: [field], hasScripts: false } } });
      return Promise.resolve();
    });
    useForms.setState({ highlight: false });
    answer(opened(A));
    await runHubCard('fill');
    expect(useForms.getState().highlight).toBe(true);
    expect(formsApi.focusFirstEmpty).toHaveBeenCalledWith(1);
  });

  it('Fill form without fields says so and opens the Fill section of the popover', async () => {
    const item = document.createElement('button');
    item.setAttribute('data-toolbar-item', 'signature');
    const click = vi.fn();
    item.addEventListener('click', click);
    document.body.append(item);
    useForms.setState({ byDoc: { 1: { status: 'none', fields: [], hasScripts: false } } });
    answer(opened(A));
    await runHubCard('fill');
    item.remove();
    expect(useUi.getState().toast?.message).toBe('This PDF has no form fields. Use Fill & Sign to add text and marks.');
    expect(click).toHaveBeenCalledTimes(1);
    expect(formsApi.focusFirstEmpty).not.toHaveBeenCalled();
  });

  it('Images to PDF opens the dialog of 3.43, which starts with its own picker', async () => {
    await runHubCard('images');
    expect(useUi.getState().imagesToPdfOpen).toBe(true);
    expect(documentsApi.openDocumentDialog).not.toHaveBeenCalled();
  });

  it('one opening guard: a second card does nothing while one runs', async () => {
    let finish: (outcomes: OpenOutcome[]) => void = () => undefined;
    documentsApi.openDocumentDialog.mockReturnValueOnce(
      new Promise<OpenOutcome[]>((resolve) => {
        finish = resolve;
      }),
    );
    const first = runHubCard('compress');
    expect(useHub.getState().busy).toBe('compress');
    await runHubCard('redact');
    expect(documentsApi.openDocumentDialog).toHaveBeenCalledTimes(1);
    finish([]);
    await first;
    expect(useHub.getState().busy).toBeNull();
  });

  it('a failing dialog is an error banner and the hub stays', async () => {
    documentsApi.openDocumentDialog.mockRejectedValueOnce(new Error('boom'));
    await runHubCard('merge');
    expect(useUi.getState().banner).not.toBeNull();
    expect(useHub.getState().busy).toBeNull();
  });
});
