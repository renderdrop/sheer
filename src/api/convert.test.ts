import { invoke } from '@tauri-apps/api/core';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { exportImages, parseExportStart, resolveExportConflicts, type ImageExportOptions } from './exportImages';
import { exportPdf } from './exportPdf';
import { imagesToPdf, releaseImageBatch, type ImagesToPdfOptions } from './imagesToPdf';
import { parseJobEvent } from './jobs';
import { getPrintPage, openPrintDialog, parsePrintFrame, preparePrint, releasePrint, type PrintOptions } from './print';

vi.mock('@tauri-apps/api/core', () => ({
  invoke: vi.fn(),
  Channel: class {
    constructor(readonly onmessage: (message: unknown) => void) {}
  },
}));
const invokeMock = vi.mocked(invoke);
beforeEach(() => invokeMock.mockReset());

const INTERNAL = { code: 'internal', key: 'error.internal', retryable: false };
const lastArgs = (): Record<string, unknown> => (invokeMock.mock.calls.at(-1)?.[1] ?? {}) as Record<string, unknown>;
const channelOf = (): { onmessage: (message: unknown) => void } =>
  lastArgs().onEvent as { onmessage: (message: unknown) => void };
const noop = (): void => undefined;

describe('job events of the output jobs', () => {
  it('knows the new phases, warnings and done fields', () => {
    for (const phase of ['snapshot', 'render', 'encode']) {
      expect(parseJobEvent({ type: 'progress', phase, done: 1, total: 2 })).toMatchObject({ phase });
    }
    const done = parseJobEvent({
      type: 'done',
      outputs: 3,
      bytesBefore: 0,
      bytesAfter: 9,
      warnings: ['dpiLowered', 'imagesSkipped', 'unknown'],
      opened: null,
      skipped: 2,
      print: { printId: 4, pages: 7 },
    });
    expect(done).toMatchObject({
      type: 'done',
      warnings: ['dpiLowered', 'imagesSkipped'],
      skipped: 2,
      print: { printId: 4, pages: 7 },
    });
  });

  it('leaves skipped and print out when the message has none, and drops bad values', () => {
    const base = { type: 'done', outputs: 1, bytesBefore: 1, bytesAfter: 1, warnings: [], opened: null };
    expect(parseJobEvent(base)).toEqual({ ...base });
    const bad = parseJobEvent({ ...base, skipped: -1, print: { printId: 1 } });
    expect(bad).toMatchObject({ print: null });
    expect(bad).not.toHaveProperty('skipped');
  });
});

describe('exportImages', () => {
  const opts: ImageExportOptions = {
    pages: { type: 'ranges', text: '1-3' },
    dpi: 150,
    format: 'jpeg',
    jpegQuality: 85,
    annotations: true,
  };

  it('sends docId, opts and a channel, and parses the three answers', async () => {
    invokeMock.mockResolvedValueOnce({ type: 'started', jobId: 5 });
    await expect(exportImages(2, opts, noop)).resolves.toEqual({ type: 'started', jobId: 5 });
    expect(invokeMock.mock.calls[0]?.[0]).toBe('export_images');
    expect(lastArgs()).toMatchObject({ docId: 2, opts });
    invokeMock.mockResolvedValueOnce({ type: 'cancelled' });
    await expect(exportImages(2, opts, noop)).resolves.toEqual({ type: 'cancelled' });
    invokeMock.mockResolvedValueOnce({ type: 'conflicts', ticket: 9, count: 12, names: ['a-p01.png', 'a-p02.png'] });
    await expect(exportImages(2, opts, noop)).resolves.toEqual({
      type: 'conflicts',
      ticket: 9,
      count: 12,
      names: ['a-p01.png', 'a-p02.png'],
    });
  });

  it('routes the job events of its channel through the shared parser', async () => {
    invokeMock.mockResolvedValueOnce({ type: 'cancelled' });
    const onEvent = vi.fn();
    await exportImages(2, opts, onEvent);
    channelOf().onmessage({ type: 'progress', phase: 'render', done: 1, total: 3 });
    channelOf().onmessage({ type: 'progress', phase: 'upload', done: 1, total: 3 });
    expect(onEvent.mock.calls).toEqual([[{ type: 'progress', phase: 'render', done: 1, total: 3 }]]);
  });

  it('treats a wrong shape as internal', async () => {
    for (const bad of [
      null,
      'started',
      { type: 'started' },
      { type: 'started', jobId: -1 },
      { type: 'conflicts', ticket: 1, count: 2, names: ['1', '2', '3', '4', '5', '6'] },
      { type: 'conflicts', ticket: 1, count: 2, names: [1] },
      { type: 'other' },
    ]) {
      expect(parseExportStart(bad)).toBeNull();
      invokeMock.mockResolvedValueOnce(bad);
      await expect(exportImages(2, opts, noop)).rejects.toEqual(INTERNAL);
    }
  });

  it('keeps the page of an exportPixels error', async () => {
    invokeMock.mockRejectedValueOnce({
      code: 'limit_exceeded',
      key: 'error.limit_exceeded',
      retryable: false,
      params: { what: 'exportPixels', page: 4 },
    });
    await expect(exportImages(2, opts, noop)).rejects.toMatchObject({ params: { what: 'exportPixels', page: 4 } });
  });

  it('resolves conflicts with the ticket and the choice; null is a cancel', async () => {
    invokeMock.mockResolvedValueOnce(8);
    await expect(resolveExportConflicts(9, 'keepBoth', noop)).resolves.toBe(8);
    expect(invokeMock.mock.calls[0]?.[0]).toBe('resolve_export_conflicts');
    expect(lastArgs()).toMatchObject({ ticket: 9, choice: 'keepBoth' });
    invokeMock.mockResolvedValueOnce(null);
    await expect(resolveExportConflicts(9, 'cancel', noop)).resolves.toBeNull();
    invokeMock.mockResolvedValueOnce('8');
    await expect(resolveExportConflicts(9, 'replace', noop)).rejects.toEqual(INTERNAL);
  });
});

describe('imagesToPdf', () => {
  const opts: ImagesToPdfOptions = {
    source: { type: 'batch', batch: 3 },
    paper: 'a4',
    orientation: 'auto',
    marginPt: 34,
  };

  it('sends opts and a channel; null is a cancelled dialog', async () => {
    invokeMock.mockResolvedValueOnce(6);
    await expect(imagesToPdf(opts, noop)).resolves.toBe(6);
    expect(invokeMock.mock.calls[0]?.[0]).toBe('images_to_pdf');
    expect(lastArgs()).toMatchObject({ opts });
    invokeMock.mockResolvedValueOnce(null);
    await expect(imagesToPdf({ ...opts, source: { type: 'dialog' } }, noop)).resolves.toBeNull();
    invokeMock.mockResolvedValueOnce('6');
    await expect(imagesToPdf(opts, noop)).rejects.toEqual(INTERNAL);
  });

  it('releases a batch by number', async () => {
    invokeMock.mockResolvedValueOnce(undefined);
    await releaseImageBatch(3);
    expect(invokeMock).toHaveBeenCalledWith('release_image_batch', { batch: 3 });
  });
});

describe('exportPdf', () => {
  it('sends docId, opts, ack and a channel', async () => {
    invokeMock.mockResolvedValueOnce(11);
    const opts = { annotations: 'remove', removeMetadata: true } as const;
    await expect(exportPdf(2, opts, { breakSignature: true }, noop)).resolves.toBe(11);
    expect(invokeMock.mock.calls[0]?.[0]).toBe('export_pdf');
    expect(lastArgs()).toMatchObject({ docId: 2, opts, ack: { breakSignature: true } });
    invokeMock.mockResolvedValueOnce(null);
    await expect(exportPdf(2, opts, {}, noop)).resolves.toBeNull();
  });

  it('passes a confirmation request on as the error it is', async () => {
    invokeMock.mockRejectedValueOnce({
      code: 'needs_confirmation',
      key: 'error.needs_confirmation',
      retryable: false,
      params: { what: 'breaksSignature' },
    });
    await expect(exportPdf(2, { annotations: 'keep', removeMetadata: false }, {}, noop)).rejects.toMatchObject({
      code: 'needs_confirmation',
      params: { what: 'breaksSignature' },
    });
  });
});

describe('print', () => {
  const opts: PrintOptions = {
    pages: { type: 'all' },
    annotations: true,
    quality: 'standard',
    autoRotate: true,
    paper: 'portrait',
  };

  /** An SHR1 frame: magic, format 3, 8 bytes reserved/size, then the payload. */
  function frame(payload: number[], format = 3, width = 2, height = 3): Uint8Array<ArrayBuffer> {
    const bytes = new Uint8Array(16 + payload.length);
    bytes.set([0x53, 0x48, 0x52, 0x31, format]);
    const view = new DataView(bytes.buffer);
    view.setUint32(8, width, true);
    view.setUint32(12, height, true);
    bytes.set(payload, 16);
    return bytes;
  }

  it('prepares a set and needs a job id back', async () => {
    invokeMock.mockResolvedValueOnce(4);
    await expect(preparePrint(2, opts, noop)).resolves.toBe(4);
    expect(invokeMock.mock.calls[0]?.[0]).toBe('prepare_print');
    expect(lastArgs()).toMatchObject({ docId: 2, opts });
    invokeMock.mockResolvedValueOnce(null);
    await expect(preparePrint(2, opts, noop)).rejects.toEqual(INTERNAL);
  });

  it('parses a JPEG frame and refuses everything else', () => {
    expect(parsePrintFrame(frame([0xff, 0xd8, 0xff, 0xe0]))).toMatchObject({ width: 2, height: 3 });
    expect(parsePrintFrame(frame([0xff, 0xd8, 0xff, 0xe0], 1))).toBeNull();
    expect(parsePrintFrame(frame([0x89, 0x50, 0x4e, 0x47]))).toBeNull();
    expect(parsePrintFrame(frame([0xff, 0xd8, 0xff], 3, 0, 3))).toBeNull();
    expect(parsePrintFrame(frame([0xff, 0xd8, 0xff], 3, 10_001, 3))).toBeNull();
    expect(parsePrintFrame(new Uint8Array(16))).toBeNull();
    const wrongMagic = frame([0xff, 0xd8, 0xff]);
    wrongMagic[0] = 0;
    expect(parsePrintFrame(wrongMagic)).toBeNull();
  });

  it('fetches a frame by print id and index', async () => {
    invokeMock.mockResolvedValueOnce(frame([0xff, 0xd8, 0xff, 0xe0]).buffer);
    const page = await getPrintPage(4, 1);
    expect(invokeMock).toHaveBeenCalledWith('get_print_page', { printId: 4, index: 1 });
    expect(page.width).toBe(2);
    invokeMock.mockResolvedValueOnce(new ArrayBuffer(3));
    await expect(getPrintPage(4, 1)).rejects.toEqual(INTERNAL);
  });

  it('opens the dialog and names the route; anything else is internal', async () => {
    invokeMock.mockResolvedValueOnce('system');
    await expect(openPrintDialog(4)).resolves.toBe('system');
    invokeMock.mockResolvedValueOnce('webview');
    await expect(openPrintDialog(4)).resolves.toBe('webview');
    invokeMock.mockResolvedValueOnce('recorded');
    await expect(openPrintDialog(4)).resolves.toBe('recorded');
    invokeMock.mockResolvedValueOnce('shell');
    await expect(openPrintDialog(4)).rejects.toEqual(INTERNAL);
    expect(invokeMock).toHaveBeenCalledWith('open_print_dialog', { printId: 4 });
  });

  it('releases a set by id', async () => {
    invokeMock.mockResolvedValueOnce(undefined);
    await releasePrint(4);
    expect(invokeMock).toHaveBeenCalledWith('release_print', { printId: 4 });
  });
});
