import { invoke } from '@tauri-apps/api/core';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { exportComments, type CommentExportOptions } from './commentExport';
import { parseJobEvent, type JobEvent } from './jobs';

vi.mock('@tauri-apps/api/core', () => ({
  invoke: vi.fn(),
  Channel: class {
    constructor(readonly onmessage: (message: unknown) => void) {}
  },
}));
const invokeMock = vi.mocked(invoke);
beforeEach(() => invokeMock.mockReset());

const lastArgs = (): Record<string, unknown> => (invokeMock.mock.calls.at(-1)?.[1] ?? {}) as Record<string, unknown>;
const noop = (): void => undefined;

const OPTS: CommentExportOptions = {
  format: 'markdown',
  include: ['comments', 'citations'],
  pages: { type: 'all' },
  lang: 'de',
  authors: ['', 'Ann'],
  status: 'open',
  citationLines: [{ id: 3, text: 'Müller, S. 12.' }],
};

describe('exportComments', () => {
  it('sends the filter and the formatted lines, never bytes or paths, and answers the job id', async () => {
    invokeMock.mockResolvedValueOnce(7);
    await expect(exportComments(4, OPTS, noop)).resolves.toBe(7);
    expect(invokeMock).toHaveBeenCalledWith('export_comments', expect.objectContaining({ docId: 4, opts: OPTS }));
    expect(Object.keys(lastArgs()).sort()).toEqual(['docId', 'onEvent', 'opts']);
  });

  it('answers null when the save dialog was cancelled', async () => {
    invokeMock.mockResolvedValueOnce(null);
    await expect(exportComments(1, OPTS, noop)).resolves.toBeNull();
  });

  it('treats a wrong answer as internal and maps a rejection to an AppError', async () => {
    invokeMock.mockResolvedValueOnce('7');
    await expect(exportComments(1, OPTS, noop)).rejects.toMatchObject({ code: 'internal' });
    invokeMock.mockRejectedValueOnce({ code: 'limit_exceeded', key: 'error.limit_exceeded', retryable: false });
    await expect(exportComments(1, OPTS, noop)).rejects.toMatchObject({ code: 'limit_exceeded' });
  });

  it('parses the events on the channel, with the new warnings', async () => {
    invokeMock.mockResolvedValueOnce(1);
    const seen: JobEvent[] = [];
    await exportComments(1, OPTS, (event) => seen.push(event));
    const channel = lastArgs().onEvent as { onmessage: (message: unknown) => void };
    channel.onmessage({ type: 'progress', phase: 'read', done: 1, total: 3 });
    channel.onmessage({ type: 'progress', phase: 'write', done: 0, total: 1 });
    channel.onmessage({
      type: 'done',
      outputs: 1,
      bytesBefore: 0,
      bytesAfter: 9,
      warnings: ['quotesOmitted', 'glyphsReplaced', 'nothingToExport', 'nonsense'],
      opened: null,
    });
    channel.onmessage({ type: 'bogus' });
    expect(seen).toHaveLength(3);
    expect(seen[2]).toMatchObject({ type: 'done', warnings: ['quotesOmitted', 'glyphsReplaced', 'nothingToExport'] });
    expect(parseJobEvent({ type: 'progress', phase: 'read', done: 0, total: 0 })).not.toBeNull();
  });
});
