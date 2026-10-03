import { beforeEach, describe, expect, it, vi } from 'vitest';

import { invoke } from '@tauri-apps/api/core';

import { closeDocument, openDocumentDialog, parseDocFlags, parseDocumentInfo, parseOpenOutcome } from './documents';

vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn() }));

const invokeMock = vi.mocked(invoke);

beforeEach(() => {
  invokeMock.mockReset();
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

describe('document flags', () => {
  const FLAGS = { encrypted: true, xfa: false, hasForms: true, signed: false };

  it('reads four booleans and drops everything else', () => {
    expect(parseDocFlags(FLAGS)).toStrictEqual(FLAGS);
    expect(parseDocFlags({ ...FLAGS, certified: true, path: 'C:\\x' })).toStrictEqual(FLAGS);
    for (const bad of [
      null,
      [],
      'flags',
      {},
      { ...FLAGS, encrypted: 1 },
      { ...FLAGS, xfa: 'false' },
      { encrypted: true, xfa: false, hasForms: true },
      { encrypted: true, xfa: false, has_forms: true, signed: false },
    ]) {
      expect(parseDocFlags(bad), JSON.stringify(bad)).toBeNull();
    }
  });

  it('are part of the document the backend reports, when they are there', () => {
    expect(parseDocumentInfo({ id: 2, pageCount: 9, displayName: 'Q3.pdf', flags: FLAGS })).toStrictEqual({
      id: 2,
      pageCount: 9,
      displayName: 'Q3.pdf',
      flags: FLAGS,
    });
    // A document without flags is still a document, and does not get a key with nothing in it.
    expect(parseDocumentInfo({ id: 2, pageCount: 9, displayName: 'Q3.pdf' })).toStrictEqual({
      id: 2,
      pageCount: 9,
      displayName: 'Q3.pdf',
    });
  });

  it('make a document that has them wrong not a document', () => {
    for (const flags of [null, 'encrypted', { encrypted: true }, { ...FLAGS, signed: null }]) {
      expect(
        parseDocumentInfo({ id: 2, pageCount: 9, displayName: 'Q3.pdf', flags }),
        JSON.stringify(flags),
      ).toBeNull();
    }
  });

  it('come with an opened document through the dialog', async () => {
    invokeMock.mockResolvedValueOnce([
      { type: 'opened', document: { id: 1, pageCount: 3, displayName: 'a.pdf', flags: FLAGS } },
    ]);
    await expect(openDocumentDialog()).resolves.toStrictEqual([
      { type: 'opened', document: { id: 1, pageCount: 3, displayName: 'a.pdf', flags: FLAGS } },
    ]);
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
