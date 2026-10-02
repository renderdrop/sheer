import { beforeEach, describe, expect, it, vi } from 'vitest';

import { invoke } from '@tauri-apps/api/core';

import { closeDocument, openDocumentDialog, parseDocumentInfo, renderPage } from './documents';
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
  it('opens through the dialog command, which takes no arguments', async () => {
    invokeMock.mockResolvedValueOnce({ id: 4, pageCount: 2, displayName: 'a.pdf' });
    await expect(openDocumentDialog()).resolves.toEqual({ id: 4, pageCount: 2, displayName: 'a.pdf' });
    expect(invokeMock).toHaveBeenCalledWith('open_document_dialog', undefined);
    invokeMock.mockResolvedValueOnce(null);
    await expect(openDocumentDialog()).resolves.toBeNull();
  });

  it('accepts a document without pages and a name that is empty', async () => {
    invokeMock.mockResolvedValueOnce({ id: 0, pageCount: 0, displayName: '' });
    await expect(openDocumentDialog()).resolves.toEqual({ id: 0, pageCount: 0, displayName: '' });
  });

  it('returns only the three known fields', async () => {
    invokeMock.mockResolvedValueOnce({ id: 1, pageCount: 3, displayName: 'a.pdf', path: '/home/user/secret/a.pdf' });
    await expect(openDocumentDialog()).resolves.toStrictEqual({ id: 1, pageCount: 3, displayName: 'a.pdf' });
  });

  it('turns an answer that is not a DocumentInfo into the generic error', async () => {
    const bad: unknown[] = [
      undefined,
      'a.pdf',
      42,
      [],
      {},
      { id: 4, pageCount: 2 },
      { id: 4, pageCount: 2, displayName: null },
      { id: 4, pageCount: 2, displayName: 7 },
      { id: 4, pageCount: 2, displayName: ['a.pdf'] },
      { id: 4, displayName: 'a.pdf' },
      { pageCount: 2, displayName: 'a.pdf' },
      { id: '4', pageCount: 2, displayName: 'a.pdf' },
      { id: -1, pageCount: 2, displayName: 'a.pdf' },
      { id: 1.5, pageCount: 2, displayName: 'a.pdf' },
      { id: 4, pageCount: -1, displayName: 'a.pdf' },
      { id: 4, pageCount: 2.5, displayName: 'a.pdf' },
      { id: 4, pageCount: '2', displayName: 'a.pdf' },
      { id: 4, pageCount: Number.NaN, displayName: 'a.pdf' },
      { id: 4, pageCount: Number.POSITIVE_INFINITY, displayName: 'a.pdf' },
      { id: 4, pageCount: Number.NEGATIVE_INFINITY, displayName: 'a.pdf' },
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
