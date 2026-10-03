import { invoke } from '@tauri-apps/api/core';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import {
  cancelJob,
  compressDocument,
  estimateCompression,
  extractPages,
  mergeDocuments,
  parseJobEvent,
  splitDocument,
  type JobEvent,
} from './jobs';

/** A `Channel` that keeps its handler, so a test can play the backend by calling `onmessage`. */
vi.mock('@tauri-apps/api/core', () => ({
  invoke: vi.fn(),
  Channel: class {
    constructor(readonly onmessage: (message: unknown) => void) {}
  },
}));

const invokeMock = vi.mocked(invoke);

beforeEach(() => {
  invokeMock.mockReset();
});

function channelOf(): { onmessage: (message: unknown) => void } {
  const [, args] = invokeMock.mock.calls.at(-1) ?? [];
  return (args as { onEvent: { onmessage: (message: unknown) => void } }).onEvent;
}

describe('parseJobEvent', () => {
  it('reads progress, with the phases the backend names', () => {
    for (const phase of ['read', 'images', 'write', 'validate']) {
      expect(parseJobEvent({ type: 'progress', phase, done: 1, total: 4 })).toEqual({
        type: 'progress',
        phase,
        done: 1,
        total: 4,
      });
    }
    expect(parseJobEvent({ type: 'progress', phase: 'upload', done: 1, total: 4 })).toBeNull();
    expect(parseJobEvent({ type: 'progress', phase: 'read', done: -1, total: 4 })).toBeNull();
    expect(parseJobEvent({ type: 'progress', phase: 'read', done: 1 })).toBeNull();
  });

  it('reads done with its warnings and the document it opened', () => {
    const event = parseJobEvent({
      type: 'done',
      outputs: 1,
      bytesBefore: 100,
      bytesAfter: 40,
      warnings: ['signaturesRemoved', 'formsDropped', 'something else'],
      opened: { id: 3, pageCount: 2, displayName: 'out.pdf', kind: 'user' },
    });
    expect(event).toMatchObject({ type: 'done', outputs: 1, bytesBefore: 100, bytesAfter: 40 });
    expect((event as Extract<JobEvent, { type: 'done' }>).warnings).toEqual(['signaturesRemoved', 'formsDropped']);
    expect((event as Extract<JobEvent, { type: 'done' }>).opened?.id).toBe(3);
  });

  it('reads a compress that was not smaller: nothing written, nothing opened', () => {
    const event = parseJobEvent({
      type: 'done',
      outputs: 0,
      bytesBefore: 100,
      bytesAfter: 120,
      warnings: [],
      opened: null,
    });
    expect(event).toEqual({ type: 'done', outputs: 0, bytesBefore: 100, bytesAfter: 120, warnings: [], opened: null });
  });

  it('reads cancelled and failed (the error sits flat next to the type)', () => {
    expect(parseJobEvent({ type: 'cancelled' })).toEqual({ type: 'cancelled' });
    const failed = parseJobEvent({ type: 'failed', code: 'save_failed', key: 'error.save_failed', retryable: true });
    expect(failed).toMatchObject({ type: 'failed', error: { code: 'save_failed', retryable: true } });
  });

  it('refuses what is not a job event', () => {
    for (const bad of [
      null,
      5,
      'done',
      [],
      {},
      { type: 'nope' },
      { type: 'done', outputs: 'x', bytesBefore: 1, bytesAfter: 1 },
    ]) {
      expect(parseJobEvent(bad)).toBeNull();
    }
  });
});

describe('the job commands', () => {
  it('extract passes the pages and a channel, and resolves to the job id or null', async () => {
    invokeMock.mockResolvedValueOnce(7);
    expect(await extractPages(2, [3, 1], vi.fn())).toBe(7);
    const [name, args] = invokeMock.mock.calls[0] ?? [];
    expect(name).toBe('extract_pages');
    expect(args).toMatchObject({ docId: 2, pages: [3, 1] });
    expect(Object.keys(args as object).sort()).toEqual(['docId', 'onEvent', 'pages']);
    invokeMock.mockResolvedValueOnce(null);
    expect(await extractPages(2, [3], vi.fn())).toBeNull();
  });

  it('delivers the backend messages in order as validated events and drops the unreadable ones', async () => {
    invokeMock.mockResolvedValueOnce(1);
    const events: JobEvent[] = [];
    await extractPages(2, [0], (event) => events.push(event));
    const channel = channelOf();
    channel.onmessage({ type: 'progress', phase: 'write', done: 1, total: 2 });
    channel.onmessage({ type: 'garbage' });
    channel.onmessage({ type: 'cancelled' });
    expect(events.map((e) => e.type)).toEqual(['progress', 'cancelled']);
  });

  it('split, merge and compress send their plan', async () => {
    invokeMock.mockResolvedValue(1);
    await splitDocument(1, { type: 'ranges', text: '1-3, 5, 8-' }, vi.fn());
    expect(invokeMock.mock.calls.at(-1)).toMatchObject([
      'split_document',
      { docId: 1, plan: { type: 'ranges', text: '1-3, 5, 8-' } },
    ]);
    await splitDocument(1, { type: 'everyN', n: 5 }, vi.fn());
    expect(invokeMock.mock.calls.at(-1)).toMatchObject(['split_document', { plan: { type: 'everyN', n: 5 } }]);
    await mergeDocuments(
      [
        { type: 'document', docId: 1 },
        { type: 'source', sourceId: 4 },
      ],
      vi.fn(),
    );
    expect(invokeMock.mock.calls.at(-1)).toMatchObject([
      'merge_documents',
      {
        inputs: [
          { type: 'document', docId: 1 },
          { type: 'source', sourceId: 4 },
        ],
      },
    ]);
    await compressDocument(1, 'ebook', vi.fn());
    expect(invokeMock.mock.calls.at(-1)).toMatchObject(['compress_document', { docId: 1, preset: 'ebook' }]);
  });

  it('rejects when the backend answers with something that is not a job id', async () => {
    invokeMock.mockResolvedValueOnce('seven');
    await expect(extractPages(1, [0], vi.fn())).rejects.toMatchObject({ code: 'internal' });
  });

  it('cancels by job id', async () => {
    invokeMock.mockResolvedValueOnce(undefined);
    await cancelJob(9);
    expect(invokeMock).toHaveBeenCalledWith('cancel_job', { jobId: 9 });
  });

  it('reads the estimate per preset and refuses a damaged answer', async () => {
    invokeMock.mockResolvedValueOnce({
      current: 1000,
      presets: { lossless: 900, print: 700, ebook: 500, screen: 300 },
    });
    expect(await estimateCompression(1)).toEqual({
      current: 1000,
      presets: { lossless: 900, print: 700, ebook: 500, screen: 300 },
    });
    invokeMock.mockResolvedValueOnce({ current: 1000, presets: { print: 700 } });
    await expect(estimateCompression(1)).rejects.toMatchObject({ code: 'internal' });
  });
});
