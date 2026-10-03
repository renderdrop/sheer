import { invoke } from '@tauri-apps/api/core';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { makeFrame } from './frame.testutil';
import { renderPage, setViewport } from './render';

vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn() }));

const invokeMock = vi.mocked(invoke);

/** The ArrayBuffer Tauri hands back for a raw response. */
function body(frame: Uint8Array<ArrayBuffer>): ArrayBuffer {
  return frame.buffer.slice(frame.byteOffset, frame.byteOffset + frame.byteLength);
}

beforeEach(() => {
  invokeMock.mockReset();
});

describe('renderPage', () => {
  it('calls render_page with one request object and returns the parsed frame', async () => {
    invokeMock.mockResolvedValueOnce(body(makeFrame({ width: 612, height: 792 })));
    const frame = await renderPage({ docId: 3, pageId: 1, bucket: 4, priority: 'visible', generation: 7 });
    expect(invokeMock).toHaveBeenCalledWith('render_page', {
      req: { docId: 3, pageId: 1, bucket: 4, tile: null, priority: 'visible', generation: 7 },
    });
    expect(frame).toMatchObject({ width: 612, height: 792 });
    expect(frame.data.length).toBeGreaterThan(24);
  });

  it('passes a tile as [column, row] and nothing else about the scale', async () => {
    invokeMock.mockResolvedValueOnce(body(makeFrame({ width: 1024, height: 1024 })));
    await renderPage({ docId: 0, pageId: 0, bucket: 14, tile: [2, 5], priority: 'near', generation: 0 });
    const [, args] = invokeMock.mock.calls[0] ?? [];
    expect(args).toEqual({ req: { docId: 0, pageId: 0, bucket: 14, tile: [2, 5], priority: 'near', generation: 0 } });
  });

  it('does not retry a frame that is too large: asking for tiles is the caller\u2019s job', async () => {
    invokeMock.mockRejectedValue({
      code: 'limit_exceeded',
      key: 'error.limit_exceeded',
      retryable: false,
      params: { what: 'dimension', limit: 4096 },
    });
    await expect(
      renderPage({ docId: 0, pageId: 0, bucket: 12, priority: 'visible', generation: 1 }),
    ).rejects.toMatchObject({ code: 'limit_exceeded', params: { what: 'dimension' } });
    expect(invokeMock).toHaveBeenCalledTimes(1);
  });

  it('rejects with the backend error, including `cancelled`', async () => {
    invokeMock.mockRejectedValue({ code: 'cancelled', key: 'error.cancelled', retryable: false });
    await expect(
      renderPage({ docId: 0, pageId: 0, bucket: 0, priority: 'visible', generation: 1 }),
    ).rejects.toMatchObject({ code: 'cancelled' });
  });

  it('turns a body that is not a valid frame into the generic error', async () => {
    invokeMock.mockResolvedValueOnce(new ArrayBuffer(10));
    await expect(
      renderPage({ docId: 0, pageId: 0, bucket: 0, priority: 'visible', generation: 1 }),
    ).rejects.toMatchObject({ code: 'internal' });
    invokeMock.mockResolvedValueOnce(body(makeFrame({ format: 2 })));
    await expect(
      renderPage({ docId: 0, pageId: 0, bucket: 0, priority: 'visible', generation: 1 }),
    ).rejects.toMatchObject({ code: 'internal' });
  });

  it('normalizes rejections that are not backend errors', async () => {
    invokeMock.mockRejectedValueOnce('C:\\Users\\user\\secret.pdf was not found');
    const error: unknown = await renderPage({
      docId: 0,
      pageId: 0,
      bucket: 0,
      priority: 'visible',
      generation: 1,
    }).catch((caught: unknown) => caught);
    expect(error).toEqual({ code: 'internal', key: 'error.internal', retryable: false });
  });
});

describe('setViewport', () => {
  it('sends the document id and the hint', async () => {
    invokeMock.mockResolvedValueOnce(undefined);
    await setViewport(2, { generation: 9, visible: [3, 4], near: [2, 5] });
    expect(invokeMock).toHaveBeenCalledWith('set_viewport', {
      docId: 2,
      hint: { generation: 9, visible: [3, 4], near: [2, 5] },
    });
  });

  it('rejects with an AppError', async () => {
    invokeMock.mockRejectedValueOnce({ code: 'not_found', key: 'error.not_found', params: { what: 'document' } });
    await expect(setViewport(2, { generation: 1, visible: [], near: [] })).rejects.toMatchObject({ code: 'not_found' });
  });
});
