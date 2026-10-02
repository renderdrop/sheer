import { beforeEach, describe, expect, it, vi } from 'vitest';

import { invoke } from '@tauri-apps/api/core';

import { closeDocument, openDocumentDialog, parseDocumentInfo, parseOpenOutcome, renderPage } from './documents';
import { makeFrame } from './frame.testutil';

vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn() }));

const invokeMock = vi.mocked(invoke);

/** What the backend rejects with when a frame would be too large (`UiError` of `limit_exceeded`). */
const TOO_LARGE = {
  code: 'limit_exceeded',
  key: 'error.limit_exceeded',
  retryable: false,
  params: { what: 'dimension', limit: 4096 },
};

/** The ArrayBuffer Tauri hands back for a raw response. */
function body(frame: Uint8Array<ArrayBuffer>): ArrayBuffer {
  return frame.buffer.slice(frame.byteOffset, frame.byteOffset + frame.byteLength);
}

const scalesRequested = () => invokeMock.mock.calls.map(([, args]) => (args as { scale: number }).scale);

beforeEach(() => {
  invokeMock.mockReset();
});

describe('renderPage', () => {
  it('calls render_page with document id, page id and scale and returns the parsed frame', async () => {
    invokeMock.mockResolvedValueOnce(body(makeFrame({ width: 612, height: 792 })));
    const page = await renderPage(3, 1, 2);
    expect(invokeMock).toHaveBeenCalledWith('render_page', { docId: 3, pageId: 1, scale: 2 });
    expect(page).toMatchObject({ width: 612, height: 792, scale: 2 });
    expect(page.data.length).toBeGreaterThan(24);
  });

  it('retries at a smaller scale while the frame is too large and reports the scale it used', async () => {
    invokeMock
      .mockRejectedValueOnce(TOO_LARGE)
      .mockRejectedValueOnce({ ...TOO_LARGE, params: { what: 'pixels', limit: 16_777_216 } })
      .mockResolvedValueOnce(body(makeFrame({ width: 100, height: 100 })));
    const page = await renderPage(0, 0, 5);
    const scales = scalesRequested();
    expect(scales).toHaveLength(3);
    expect(scales[0]).toBe(5);
    expect(scales[1]).toBeCloseTo(3.5);
    expect(scales[2]).toBeCloseTo(2.45);
    expect(page.scale).toBeCloseTo(2.45);
  });

  it('gives up after a few retries instead of looping', async () => {
    invokeMock.mockRejectedValue(TOO_LARGE);
    await expect(renderPage(0, 0, 8)).rejects.toMatchObject({ code: 'limit_exceeded' });
    expect(invokeMock).toHaveBeenCalledTimes(5);
  });

  it('never retries below the smallest scale the backend accepts', async () => {
    invokeMock.mockRejectedValue(TOO_LARGE);
    await expect(renderPage(0, 0, 0.12)).rejects.toMatchObject({ code: 'limit_exceeded' });
    expect(scalesRequested()).toEqual([0.12]);
  });

  it('does not retry other errors', async () => {
    invokeMock.mockRejectedValue({ code: 'invalid_argument', key: 'error.invalid_argument', params: { what: 'page' } });
    await expect(renderPage(0, 9, 1)).rejects.toMatchObject({ code: 'invalid_argument', params: { what: 'page' } });
    expect(invokeMock).toHaveBeenCalledTimes(1);

    invokeMock.mockReset();
    invokeMock.mockRejectedValue({ code: 'limit_exceeded', params: { what: 'documents', limit: 32 } });
    await expect(renderPage(0, 0, 1)).rejects.toMatchObject({ code: 'limit_exceeded' });
    expect(invokeMock).toHaveBeenCalledTimes(1);
  });

  it('turns a body that is not a valid frame into the generic error', async () => {
    invokeMock.mockResolvedValueOnce(new ArrayBuffer(10));
    await expect(renderPage(0, 0, 1)).rejects.toMatchObject({ code: 'internal' });
    invokeMock.mockResolvedValueOnce(body(makeFrame({ format: 2 })));
    await expect(renderPage(0, 0, 1)).rejects.toMatchObject({ code: 'internal' });
  });

  it('normalizes rejections that are not backend errors', async () => {
    invokeMock.mockRejectedValueOnce('C:\\Users\\user\\secret.pdf was not found');
    const error: unknown = await renderPage(0, 0, 1).catch((caught: unknown) => caught);
    expect(error).toEqual({ code: 'internal', key: 'error.internal', retryable: false });
  });
});

describe('document commands', () => {
  const REPORT = { id: 4, pageCount: 2, displayName: 'a.pdf' };
  const opened = (document: unknown) => ({ type: 'opened', document });
  const NOT_A_PDF = { type: 'openFailed', code: 'not_a_pdf', key: 'error.not_a_pdf', retryable: false };

  it('opens through the dialog command, which takes no arguments, and answers with how each file went', async () => {
    invokeMock.mockResolvedValueOnce([opened(REPORT)]);
    await expect(openDocumentDialog()).resolves.toEqual([{ type: 'opened', document: REPORT }]);
    expect(invokeMock).toHaveBeenCalledWith('open_document_dialog', undefined);
  });

  it('answers with an empty list when the dialog is cancelled', async () => {
    invokeMock.mockResolvedValueOnce([]);
    await expect(openDocumentDialog()).resolves.toEqual([]);
  });

  it('keeps the order of the files and tells a failure from a document', async () => {
    invokeMock.mockResolvedValueOnce([
      opened(REPORT),
      NOT_A_PDF,
      opened({ id: 5, pageCount: 1, displayName: 'b.pdf' }),
    ]);
    await expect(openDocumentDialog()).resolves.toEqual([
      { type: 'opened', document: REPORT },
      { type: 'openFailed', error: { code: 'not_a_pdf', key: 'error.not_a_pdf', retryable: false } },
      { type: 'opened', document: { id: 5, pageCount: 1, displayName: 'b.pdf' } },
    ]);
  });

  it('accepts a document without pages and a name that is empty', async () => {
    invokeMock.mockResolvedValueOnce([opened({ id: 0, pageCount: 0, displayName: '' })]);
    await expect(openDocumentDialog()).resolves.toEqual([
      { type: 'opened', document: { id: 0, pageCount: 0, displayName: '' } },
    ]);
  });

  it('returns only the three known fields of a document', async () => {
    invokeMock.mockResolvedValueOnce([opened({ ...REPORT, path: '/home/user/secret/a.pdf' })]);
    await expect(openDocumentDialog()).resolves.toStrictEqual([{ type: 'opened', document: REPORT }]);
  });

  it('carries the error of a failed open the way a rejected command does: code, key, retryable and the whitelisted params', async () => {
    invokeMock.mockResolvedValueOnce([
      {
        type: 'openFailed',
        code: 'limit_exceeded',
        key: 'error.limit_exceeded',
        retryable: false,
        params: { what: 'documents', limit: 32 },
        path: 'C:\\Users\\user\\secret.pdf',
      },
    ]);
    await expect(openDocumentDialog()).resolves.toStrictEqual([
      {
        type: 'openFailed',
        error: {
          code: 'limit_exceeded',
          key: 'error.limit_exceeded',
          retryable: false,
          params: { what: 'documents', limit: 32 },
        },
      },
    ]);
  });

  it('turns an answer that is not a list of open outcomes into the generic error', async () => {
    const bad: unknown[] = [
      undefined,
      null,
      'a.pdf',
      42,
      {},
      REPORT,
      [REPORT],
      [{ type: 'opened' }],
      [{ type: 'opened', document: null }],
      [{ type: 'dropHover', active: true }],
      [{ type: 'unknown' }],
      ['opened'],
      [null],
      [opened({ id: 4, pageCount: 2 })],
      [opened({ id: 4, pageCount: 2, displayName: null })],
      [opened({ id: 4, pageCount: 2, displayName: 7 })],
      [opened({ id: 4, pageCount: 2, displayName: ['a.pdf'] })],
      [opened({ id: 4, displayName: 'a.pdf' })],
      [opened({ pageCount: 2, displayName: 'a.pdf' })],
      [opened({ id: '4', pageCount: 2, displayName: 'a.pdf' })],
      [opened({ id: -1, pageCount: 2, displayName: 'a.pdf' })],
      [opened({ id: 1.5, pageCount: 2, displayName: 'a.pdf' })],
      [opened({ id: 4, pageCount: -1, displayName: 'a.pdf' })],
      [opened({ id: 4, pageCount: 2.5, displayName: 'a.pdf' })],
      [opened({ id: 4, pageCount: '2', displayName: 'a.pdf' })],
      [opened({ id: 4, pageCount: Number.NaN, displayName: 'a.pdf' })],
      [opened({ id: 4, pageCount: Number.POSITIVE_INFINITY, displayName: 'a.pdf' })],
      [opened(REPORT), 'junk'],
    ];
    for (const answer of bad) {
      invokeMock.mockResolvedValueOnce(answer);
      await expect(openDocumentDialog(), JSON.stringify(answer)).rejects.toEqual({
        code: 'internal',
        key: 'error.internal',
        retryable: false,
      });
    }
  });

  it('refuses a list longer than the backend ever sends: 32 files and one entry for the rest', async () => {
    invokeMock.mockResolvedValueOnce(Array.from({ length: 33 }, (_, id) => opened({ ...REPORT, id })));
    await expect(openDocumentDialog()).resolves.toHaveLength(33);
    invokeMock.mockResolvedValueOnce(Array.from({ length: 34 }, (_, id) => opened({ ...REPORT, id })));
    await expect(openDocumentDialog()).rejects.toMatchObject({ code: 'internal' });
  });

  it('closes by document id', async () => {
    invokeMock.mockResolvedValueOnce(undefined);
    await closeDocument(4);
    expect(invokeMock).toHaveBeenCalledWith('close_document', { docId: 4 });
  });

  it('rejects with an AppError', async () => {
    invokeMock.mockRejectedValueOnce({ code: 'too_large', key: 'error.too_large', retryable: false });
    await expect(openDocumentDialog()).rejects.toMatchObject({ code: 'too_large', key: 'error.too_large' });
  });
});

describe('parseDocumentInfo', () => {
  it('reads the documented shape and nothing else', () => {
    expect(parseDocumentInfo({ id: 2, pageCount: 9, displayName: 'Q3.pdf' })).toEqual({
      id: 2,
      pageCount: 9,
      displayName: 'Q3.pdf',
    });
    expect(parseDocumentInfo(null)).toBeNull();
    expect(parseDocumentInfo({ id: 2, pageCount: 9 })).toBeNull();
    expect(parseDocumentInfo({ id: 2, pageCount: 9.5, displayName: '' })).toBeNull();
  });
});

describe('parseOpenOutcome', () => {
  it('reads an opened document and a failed open, and nothing else', () => {
    expect(parseOpenOutcome({ type: 'opened', document: { id: 2, pageCount: 9, displayName: 'Q3.pdf' } })).toEqual({
      type: 'opened',
      document: { id: 2, pageCount: 9, displayName: 'Q3.pdf' },
    });
    expect(
      parseOpenOutcome({ type: 'openFailed', code: 'too_large', key: 'error.too_large', retryable: false }),
    ).toEqual({
      type: 'openFailed',
      error: { code: 'too_large', key: 'error.too_large', retryable: false },
    });
    for (const other of [null, undefined, 'opened', 7, [], {}, { type: 'dropHover', active: true }, { type: 'x' }]) {
      expect(parseOpenOutcome(other), JSON.stringify(other)).toBeNull();
    }
  });

  it('turns a failed open with a code it does not know into the generic error, never into a different text', () => {
    expect(parseOpenOutcome({ type: 'openFailed', code: 'C:\\Users\\secret.pdf', key: 'x' })).toEqual({
      type: 'openFailed',
      error: { code: 'internal', key: 'error.internal', retryable: false },
    });
  });
});
