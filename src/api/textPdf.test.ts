import { invoke } from '@tauri-apps/api/core';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { exportTextPdf, type TextPdfOptions } from './textPdf';

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
const OPTS: TextPdfOptions = { font: 'tinos', keepImages: true, lang: 'de' };

describe('exportTextPdf', () => {
  it('sends the document id and the options only, and answers the job id', async () => {
    invokeMock.mockResolvedValueOnce(5);
    await expect(exportTextPdf(2, OPTS, noop)).resolves.toBe(5);
    expect(invokeMock).toHaveBeenCalledWith('export_text_pdf', expect.objectContaining({ docId: 2, opts: OPTS }));
    expect(Object.keys(lastArgs()).sort()).toEqual(['docId', 'onEvent', 'opts']);
  });

  it('answers null when the save dialog was cancelled', async () => {
    invokeMock.mockResolvedValueOnce(null);
    await expect(exportTextPdf(1, OPTS, noop)).resolves.toBeNull();
  });

  it('treats a wrong answer as internal and maps a rejection to an AppError', async () => {
    invokeMock.mockResolvedValueOnce({ id: 1 });
    await expect(exportTextPdf(1, OPTS, noop)).rejects.toMatchObject({ code: 'internal' });
    invokeMock.mockRejectedValueOnce({ code: 'read_only', key: 'error.read_only', retryable: false });
    await expect(exportTextPdf(1, OPTS, noop)).rejects.toMatchObject({ code: 'read_only' });
  });
});
