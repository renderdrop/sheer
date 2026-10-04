import { invoke } from '@tauri-apps/api/core';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { makeFrame } from './frame.testutil';
import { getImageBatchPreview, imagesToPdf, listImageBatch, pickImages } from './imagesToPdf';

vi.mock('@tauri-apps/api/core', () => ({
  invoke: vi.fn(),
  Channel: class {
    constructor(readonly onmessage: (message: unknown) => void) {}
  },
}));
const invokeMock = vi.mocked(invoke);
beforeEach(() => invokeMock.mockReset());
const noop = () => undefined;
const lastArgs = (): Record<string, unknown> => (invokeMock.mock.calls.at(-1)?.[1] ?? {}) as Record<string, unknown>;
const opts = {
  source: { type: 'batch', batch: 3 },
  paper: 'a4',
  orientation: 'auto',
  marginPt: 34,
} as const;

describe('images to pdf batch commands', () => {
  it('sends the order only when given', async () => {
    invokeMock.mockResolvedValue(6);
    await imagesToPdf(opts, noop, [2, 0]);
    expect(lastArgs().order).toEqual([2, 0]);
    await imagesToPdf(opts, noop);
    expect('order' in lastArgs()).toBe(false);
  });

  it('picks into a batch and validates the answer', async () => {
    invokeMock.mockResolvedValueOnce({ batch: 4, count: 5, added: 2, skipped: 1 });
    await expect(pickImages(4)).resolves.toEqual({ batch: 4, count: 5, added: 2, skipped: 1 });
    expect(invokeMock).toHaveBeenCalledWith('pick_images', { batch: 4 });
    invokeMock.mockResolvedValueOnce(null);
    await expect(pickImages()).resolves.toBeNull();
    expect(invokeMock).toHaveBeenLastCalledWith('pick_images', {});
    invokeMock.mockResolvedValueOnce({ batch: 'x' });
    await expect(pickImages()).rejects.toMatchObject({ code: 'internal' });
  });

  it('lists the items and rejects malformed rows', async () => {
    invokeMock.mockResolvedValueOnce([{ index: 0, name: 'a.png', width: 10, height: 20 }]);
    await expect(listImageBatch(4)).resolves.toEqual([{ index: 0, name: 'a.png', width: 10, height: 20 }]);
    invokeMock.mockResolvedValueOnce([{ index: 0, name: 1, width: 10, height: 20 }]);
    await expect(listImageBatch(4)).rejects.toMatchObject({ code: 'internal' });
    invokeMock.mockResolvedValueOnce('no');
    await expect(listImageBatch(4)).rejects.toMatchObject({ code: 'internal' });
  });

  it('parses a preview frame and rejects a bad one', async () => {
    invokeMock.mockResolvedValueOnce(makeFrame({ width: 40, height: 30 }).buffer);
    const frame = await getImageBatchPreview(4, 1, 64);
    expect([frame.width, frame.height]).toEqual([40, 30]);
    expect(invokeMock).toHaveBeenLastCalledWith('get_image_batch_preview', { batch: 4, index: 1, maxPx: 64 });
    invokeMock.mockResolvedValueOnce(new Uint8Array(4).buffer);
    await expect(getImageBatchPreview(4, 1, 64)).rejects.toMatchObject({ code: 'internal' });
  });
});
