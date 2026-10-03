// @vitest-environment jsdom
import { act, screen, waitFor } from '@testing-library/react';
import { MotionGlobalConfig } from 'motion/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { DocumentInfo } from '../../api/documents';
import type { JobEvent } from '../../api/jobs';
import { useDocuments } from '../../stores/documents';
import { resetDocuments } from '../../stores/documents.testutil';
import { useUi } from '../../stores/ui';
import { setup } from '../../test/render';
import { checkInput } from './SplitDialog';
import { DropBatcher } from './dropBatch';
import { DropBannerRow, JobsHost } from './JobsHost';
import { initialEntries, moveEntry } from './MergeSheet';
import { openCompress, openMerge, openSplit, useJobs } from './state';

const documents = vi.hoisted(() => ({ closeDocument: vi.fn() }));
const jobs = vi.hoisted(() => ({
  splitDocument: vi.fn(),
  extractPages: vi.fn(),
  mergeDocuments: vi.fn(),
  compressDocument: vi.fn(),
  estimateCompression: vi.fn(),
  listPageIds: vi.fn(),
  pickPdfSources: vi.fn(),
  releaseSource: vi.fn(),
  cancelJob: vi.fn(),
}));
const adopt = vi.hoisted(() => vi.fn());

vi.mock('../../api/documents', () => documents);
vi.mock('../../api/jobs', async (importOriginal) => ({ ...(await importOriginal<object>()), ...jobs }));
vi.mock('../viewer/useViewer', () => ({ adoptOpenOutcomes: adopt }));

MotionGlobalConfig.skipAnimations = true;

const A: DocumentInfo = { id: 1, pageCount: 10, displayName: 'A.pdf' };
const B: DocumentInfo = { id: 2, pageCount: 3, displayName: 'B.pdf' };

/** A job command that reports `event` right after it has started. */
const reports =
  (event: JobEvent) =>
  (...args: unknown[]) => {
    const onEvent = args.find((arg) => typeof arg === 'function') as (e: JobEvent) => void;
    queueMicrotask(() => onEvent(event));
    return Promise.resolve(5);
  };
const done = (bytesAfter: number, opened: DocumentInfo | null): JobEvent => ({
  type: 'done',
  outputs: 1,
  bytesBefore: 100,
  bytesAfter,
  warnings: [],
  opened,
});

beforeEach(() => {
  resetDocuments();
  useDocuments.getState().add(A);
  useJobs.setState({ sheet: null, drop: null });
  for (const fn of Object.values(jobs)) fn.mockReset();
  documents.closeDocument.mockReset().mockResolvedValue(undefined);
  adopt.mockReset();
  jobs.estimateCompression.mockRejectedValue(new Error('none'));
  jobs.cancelJob.mockResolvedValue(undefined);
  useUi.setState({ toast: null });
});

describe('checkInput', () => {
  it('every N needs 1 to total - 1', () => {
    expect(checkInput('every', '3', 10)).toMatchObject({ ok: true, files: 4 });
    expect(checkInput('every', '10', 10)).toEqual({ ok: false, problem: 'invalid' });
    expect(checkInput('every', '', 10)).toEqual({ ok: false, problem: null });
  });
  it('ranges must be a partition, extract any pages', () => {
    expect(checkInput('ranges', '1-4, 5-', 10)).toMatchObject({ ok: true, files: 2 });
    expect(checkInput('ranges', '1-3, 5', 10)).toMatchObject({ ok: true, files: 2 });
    expect(checkInput('extract', '1-3, 5', 10)).toMatchObject({ ok: true, files: 4 });
    expect(checkInput('extract', '1-11', 10)).toEqual({ ok: false, problem: 'invalid' });
  });
});

describe('the merge list', () => {
  it('moves entries and starts with the active document first', () => {
    expect(moveEntry(['a', 'b', 'c'], 0, 2)).toEqual(['b', 'c', 'a']);
    expect(moveEntry(['a', 'b'], 0, 5)).toEqual(['a', 'b']);
    expect(initialEntries(null, A).map((entry) => entry.name)).toEqual(['A.pdf']);
    expect(initialEntries([A, B], null)).toHaveLength(2);
  });
});

describe('a multi-file drop', () => {
  it('shows the banner for two documents and a tab for one', () => {
    const clock = 10_000;
    const batch = new DropBatcher({ windowMs: 1000, now: () => clock });
    const show = vi.fn();
    batch.noteHover(true);
    batch.intake(A, show);
    batch.flushNow();
    expect(show).toHaveBeenCalledTimes(1);
    batch.intake(A, show);
    batch.intake(B, show);
    batch.flushNow();
    expect(show).toHaveBeenCalledTimes(1);
    expect(useJobs.getState().drop).toEqual([A, B]);
  });

  it('shows a document at once unless files were just dragged over the window, and keeps its state to itself', () => {
    vi.useFakeTimers();
    try {
      let clock = 10_000;
      const first = new DropBatcher({ windowMs: 120, now: () => clock });
      const second = new DropBatcher({ windowMs: 120, now: () => clock });
      const show = vi.fn();
      first.intake(A, show);
      expect(show).toHaveBeenCalledTimes(1);
      first.noteHover(false);
      first.intake(B, show);
      second.intake(A, show);
      expect(show).toHaveBeenCalledTimes(2);
      vi.advanceTimersByTime(120);
      expect(show).toHaveBeenCalledTimes(3);
      clock += 5000;
      first.intake(A, show);
      expect(show).toHaveBeenCalledTimes(4);
    } finally {
      vi.useRealTimers();
    }
  });

  it('offers Merge, Open as tabs, and a close that opens nothing', async () => {
    act(() => useJobs.getState().setDrop([A, B]));
    const { user } = setup(<DropBannerRow />);
    expect(screen.getByRole('status').textContent).toContain('Merge 2 files into one document?');
    await user.click(screen.getByRole('button', { name: 'Open as tabs' }));
    expect(adopt).toHaveBeenCalledWith([
      { type: 'opened', document: A },
      { type: 'opened', document: B },
    ]);
    expect(useJobs.getState().drop).toBeNull();

    act(() => useJobs.getState().setDrop([{ ...B, id: 9 }]));
    await user.click(screen.getByRole('button', { name: 'Dismiss' }));
    expect(documents.closeDocument).toHaveBeenCalledWith(9, true);
    expect(adopt).toHaveBeenCalledTimes(1);
  });
});

describe('the merge sheet', () => {
  it('merges the dropped files and opens the result', async () => {
    jobs.mergeDocuments.mockImplementation(reports(done(50, { ...A, id: 7 })));
    act(() =>
      useJobs.getState().setSheet({
        kind: 'merge',
        held: [
          { ...A, id: 8 },
          { ...B, id: 9 },
        ],
      }),
    );
    const { user } = setup(<JobsHost />);
    await user.click(screen.getByRole('button', { name: 'Merge…' }));
    await waitFor(() => expect(adopt).toHaveBeenCalled());
    expect(jobs.mergeDocuments.mock.calls[0]?.[0]).toEqual([
      { type: 'document', docId: 8 },
      { type: 'document', docId: 9 },
    ]);
    expect(useJobs.getState().sheet).toBeNull();
  });

  it('blocks Merge with fewer than two files', async () => {
    act(() => openMerge());
    setup(<JobsHost />);
    expect(screen.getByRole('button', { name: 'Merge…' }).getAttribute('aria-disabled')).toBe('true');
    expect(screen.getAllByRole('option')).toHaveLength(1);
  });

  it('reorders with Alt+Arrow', async () => {
    act(() => useJobs.getState().setSheet({ kind: 'merge', held: [A, B] }));
    const { user } = setup(<JobsHost />);
    screen.getAllByRole('option')[0]?.focus();
    await user.keyboard('{Alt>}{ArrowDown}{/Alt}');
    expect(screen.getAllByRole('option')[1]?.textContent).toContain('A.pdf');
  });
});

describe('the split dialog', () => {
  it('validates, previews and runs Every N', async () => {
    jobs.splitDocument.mockResolvedValue(null);
    act(() => openSplit('every'));
    const { user } = setup(<JobsHost />);
    const field = screen.getByLabelText('Pages per file');
    await user.clear(field);
    await user.type(field, '4');
    await waitFor(() => expect(screen.getByRole('status').textContent).toContain('Creates 3 files: 1-4, 5-8, 9-10'));
    await user.click(screen.getByRole('button', { name: 'Split…' }));
    expect(jobs.splitDocument).toHaveBeenCalledWith(
      1,
      { type: 'everyN', n: 4, pattern: '{name}-{n}' },
      expect.any(Function),
    );
    await user.clear(field);
    await user.type(field, '99');
    await waitFor(() => expect(field.getAttribute('aria-invalid')).toBe('true'));
    expect(screen.getByRole('button', { name: 'Split…' }).getAttribute('aria-disabled')).toBe('true');
  });

  it('extracts pages by id', async () => {
    jobs.listPageIds.mockResolvedValue([11, 12, 13, 14, 15, 16, 17, 18, 19, 20]);
    jobs.extractPages.mockResolvedValue(null);
    act(() => openSplit('extract'));
    const { user } = setup(<JobsHost />);
    await user.type(screen.getByLabelText('Extract', { selector: 'input' }), '2-3, 5');
    await waitFor(() => expect(screen.getByRole('status').textContent).toBe('Extracts 3 pages'));
    await user.click(screen.getByRole('button', { name: 'Save As…' }));
    await waitFor(() => expect(jobs.extractPages).toHaveBeenCalled());
    expect(jobs.extractPages.mock.calls[0]?.slice(0, 2)).toEqual([1, [12, 13, 15]]);
  });
});

describe('the compress dialog', () => {
  it('says so when the result is not smaller and opens nothing', async () => {
    jobs.compressDocument.mockImplementation(reports(done(100, null)));
    act(() => openCompress());
    const { user } = setup(<JobsHost />);
    expect(screen.getAllByRole('radio').map((radio) => radio.getAttribute('aria-checked'))).toEqual([
      'false',
      'true',
      'false',
      'true',
      'false',
    ]);
    await user.click(screen.getByRole('button', { name: 'Compress' }));
    await waitFor(() => expect(screen.getByText('This file can’t be made smaller.'.replace('’', "'"))).toBeTruthy());
    expect(adopt).not.toHaveBeenCalled();
    expect(jobs.compressDocument.mock.calls[0]?.[1]).toBe('ebook');
  });

  it('opens a smaller result as a new document', async () => {
    jobs.compressDocument.mockImplementation(reports(done(50, { ...A, id: 3 })));
    act(() => openCompress());
    const { user } = setup(<JobsHost />);
    await user.click(screen.getByRole('button', { name: 'Compress' }));
    await waitFor(() => expect(adopt).toHaveBeenCalled());
    expect(useUi.getState().toast?.message).toBe('Compressed to 50 B');
  });
});
