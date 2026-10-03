import { invoke } from '@tauri-apps/api/core';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { makeFrame } from './frame.testutil';
import { MAX_PAGES, MAX_PAGE_SIDE_PT, getPageSizes, renderPage, setViewport } from './render';

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

describe('getPageSizes', () => {
  it('returns one [width, height] per page, in order', async () => {
    invokeMock.mockResolvedValueOnce([
      [612, 792],
      [200, 100.5],
    ]);
    expect(await getPageSizes(4)).toEqual([
      [612, 792],
      [200, 100.5],
    ]);
    expect(invokeMock).toHaveBeenCalledWith('get_page_sizes', { docId: 4 });
  });

  it('accepts a document without pages', async () => {
    invokeMock.mockResolvedValueOnce([]);
    expect(await getPageSizes(4)).toEqual([]);
  });

  it('turns an answer that is not a list of sizes into the generic error', async () => {
    const bad: unknown[] = [
      null,
      'sizes',
      { 0: [1, 1] },
      [[612]],
      [[612, 792, 1]],
      [['612', 792]],
      [[0, 792]],
      [[612, -1]],
      [[Number.NaN, 792]],
      [[612, Number.POSITIVE_INFINITY]],
      [[612, MAX_PAGE_SIDE_PT + 1]],
      [null],
      [[612, 792], 'x'],
    ];
    for (const answer of bad) {
      invokeMock.mockResolvedValueOnce(answer);
      await expect(getPageSizes(1), JSON.stringify(answer)).rejects.toMatchObject({ code: 'internal' });
    }
  });

  it('refuses a list longer than the backend ever opens', async () => {
    invokeMock.mockResolvedValueOnce(Array.from({ length: MAX_PAGES + 1 }, () => [612, 792]));
    await expect(getPageSizes(1)).rejects.toMatchObject({ code: 'internal' });
    invokeMock.mockResolvedValueOnce(Array.from({ length: MAX_PAGES }, () => [612, 792]));
    expect(await getPageSizes(1)).toHaveLength(MAX_PAGES);
  });

  it('copies the sizes: nothing else of the answer is kept', async () => {
    const answer = [[612, 792]];
    invokeMock.mockResolvedValueOnce(answer);
    const sizes = await getPageSizes(1);
    expect(sizes[0]).not.toBe(answer[0]);
  });
});
