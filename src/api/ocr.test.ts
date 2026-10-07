import { invoke } from '@tauri-apps/api/core';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { parseAppEvent } from './app';
import {
  handleOcrEvent,
  ocrCancel,
  ocrCapabilities,
  ocrClassifyPages,
  ocrStart,
  parseOcrEvent,
  type OcrFinished,
  type OcrProgress,
} from './ocr';

vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn() }));

const invokeMock = vi.mocked(invoke);

beforeEach(() => {
  invokeMock.mockReset();
});

const PROGRESS: OcrProgress = { type: 'ocrProgress', doc: 1, job: 2, done: 1, total: 4, failed: 0 };
const FINISHED: OcrFinished = { type: 'ocrFinished', doc: 1, job: 2, applied: 3, skipped: 1, failed: 0 };

describe('ocr commands', () => {
  it('reads the capabilities', async () => {
    const caps = {
      backend: 'windows',
      languages: [
        { tag: 'de-DE', available: false },
        { tag: 'en-US', available: true },
      ],
      maxImageDimension: 8000,
    };
    invokeMock.mockResolvedValueOnce(caps);
    expect(await ocrCapabilities()).toEqual(caps);
    expect(invokeMock).toHaveBeenCalledWith('ocr_capabilities', undefined);
  });

  it('rejects a capabilities answer of another shape', async () => {
    invokeMock.mockResolvedValueOnce({ backend: 'cloud', languages: [], maxImageDimension: null });
    await expect(ocrCapabilities()).rejects.toBeDefined();
    invokeMock.mockResolvedValueOnce({
      backend: 'none',
      languages: [{ tag: 'fr-FR', available: true }],
      maxImageDimension: null,
    });
    await expect(ocrCapabilities()).rejects.toBeDefined();
  });

  it('classifies with ids only and checks the classes', async () => {
    invokeMock.mockResolvedValueOnce([
      { page: 0, class: 'scan' },
      { page: 1, class: 'hasTextLayer' },
    ]);
    expect(await ocrClassifyPages(5, [0, 1])).toEqual([
      { page: 0, class: 'scan' },
      { page: 1, class: 'hasTextLayer' },
    ]);
    expect(invokeMock).toHaveBeenCalledWith('ocr_classify_pages', { docId: 5, pages: [0, 1] });
    invokeMock.mockResolvedValueOnce([]);
    await ocrClassifyPages(5);
    expect(invokeMock).toHaveBeenLastCalledWith('ocr_classify_pages', { docId: 5 });
    invokeMock.mockResolvedValueOnce([{ page: 0, class: 'magic' }]);
    await expect(ocrClassifyPages(5)).rejects.toBeDefined();
  });

  it('starts a job and cancels it', async () => {
    invokeMock.mockResolvedValueOnce({ job: 9, langUsed: 'en-US', notice: 'languageFallback' });
    const started = await ocrStart(5, { type: 'all' }, 'de-DE', false);
    expect(started).toEqual({ job: 9, langUsed: 'en-US', notice: 'languageFallback' });
    expect(invokeMock).toHaveBeenCalledWith('ocr_start', {
      docId: 5,
      pages: { type: 'all' },
      lang: 'de-DE',
      redo: false,
    });
    invokeMock.mockResolvedValueOnce(undefined);
    await ocrCancel(9);
    expect(invokeMock).toHaveBeenLastCalledWith('ocr_cancel', { job: 9 });
  });

  it('turns a refusal into an AppError', async () => {
    invokeMock.mockRejectedValueOnce({
      code: 'unsupported_feature',
      key: 'error.unsupported_feature',
      retryable: false,
      params: { what: 'ocrUnavailable' },
    });
    await expect(ocrStart(5, { type: 'all' }, 'de-DE', false)).rejects.toMatchObject({
      code: 'unsupported_feature',
    });
  });

  it('accepts a start answer with no notice and refuses a wrong language', async () => {
    invokeMock.mockResolvedValueOnce({ job: 1, langUsed: 'de-DE', notice: null });
    expect((await ocrStart(5, { type: 'all' }, 'de-DE', true)).notice).toBeNull();
    invokeMock.mockResolvedValueOnce({ job: 1, langUsed: 'xx', notice: null });
    await expect(ocrStart(5, { type: 'all' }, 'de-DE', true)).rejects.toBeDefined();
  });
});

describe('ocr events', () => {
  it('parses progress and finished pushes', () => {
    expect(parseOcrEvent(PROGRESS)).toEqual(PROGRESS);
    expect(parseOcrEvent(FINISHED)).toEqual(FINISHED);
  });

  it('drops pushes with counts that are not whole numbers or with another type', () => {
    expect(parseOcrEvent({ ...PROGRESS, done: -1 })).toBeNull();
    expect(parseOcrEvent({ ...PROGRESS, total: 1.5 })).toBeNull();
    expect(parseOcrEvent({ ...FINISHED, applied: '3' })).toBeNull();
    expect(parseOcrEvent({ ...FINISHED, job: undefined })).toBeNull();
    expect(parseOcrEvent({ type: 'closeRequested' })).toBeNull();
    expect(parseOcrEvent(null)).toBeNull();
  });

  it('reads the optional refused field strictly', () => {
    expect(parseOcrEvent({ ...FINISHED, refused: 'readOnly' })).toEqual({ ...FINISHED, refused: 'readOnly' });
    expect(parseOcrEvent({ ...FINISHED, refused: 'other' })).toEqual(FINISHED);
    expect(parseOcrEvent({ ...FINISHED, refused: 1 })).toEqual(FINISHED);
  });

  it('comes through the app event parser', () => {
    expect(parseAppEvent(PROGRESS)).toEqual(PROGRESS);
    expect(parseAppEvent(FINISHED)).toEqual(FINISHED);
    expect(parseAppEvent({ ...FINISHED, failed: 'x' })).toBeNull();
  });

  it('routes events to the handlers and ignores the rest', () => {
    const onProgress = vi.fn();
    const onFinished = vi.fn();
    expect(handleOcrEvent(PROGRESS, { onProgress, onFinished })).toBe(true);
    expect(handleOcrEvent(FINISHED, { onProgress, onFinished })).toBe(true);
    expect(handleOcrEvent({ type: 'closeRequested' }, { onProgress, onFinished })).toBe(false);
    expect(onProgress).toHaveBeenCalledWith(PROGRESS);
    expect(onFinished).toHaveBeenCalledWith(FINISHED);
    expect(handleOcrEvent(PROGRESS, {})).toBe(true);
  });
});
