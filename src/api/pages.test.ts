import { invoke } from '@tauri-apps/api/core';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { getPages, MAX_PAGE_SIDE_PT, MAX_PAGES, parseSlots, pickPdfSources, releaseSource } from './pages';

vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn() }));

const invokeMock = vi.mocked(invoke);

beforeEach(() => {
  invokeMock.mockReset();
});

const slot = (id: number, extra: Record<string, unknown> = {}) => ({
  id,
  width: 612,
  height: 792,
  rotation: 0,
  rev: 0,
  label: null,
  origin: 'file',
  ...extra,
});

describe('getPages', () => {
  it('returns the slots in the order the backend sent them', async () => {
    invokeMock.mockResolvedValueOnce([slot(2), slot(0, { rotation: 90, origin: 'blank' })]);
    const pages = await getPages(4);
    expect(pages.map((p) => p.id)).toEqual([2, 0]);
    expect(pages[1]?.rotation).toBe(90);
    expect(invokeMock).toHaveBeenCalledWith('get_pages', { docId: 4 });
  });

  it('accepts a document without pages', async () => {
    invokeMock.mockResolvedValueOnce([]);
    expect(await getPages(4)).toEqual([]);
  });

  it('turns an answer that is not a page list into the generic error', async () => {
    const bad: unknown[] = [
      null,
      'pages',
      [null],
      [[612, 792]],
      [slot(0, { width: 0 })],
      [slot(0, { height: MAX_PAGE_SIDE_PT + 1 })],
      [slot(0, { width: Number.NaN })],
      [slot(0, { rotation: 45 })],
      [slot(0, { origin: 'web' })],
      [slot(-1)],
      [slot(0, { label: 3 })],
      [slot(1), slot(1)],
    ];
    for (const answer of bad) {
      invokeMock.mockResolvedValueOnce(answer);
      await expect(getPages(1), JSON.stringify(answer)).rejects.toMatchObject({ code: 'internal' });
    }
  });

  it('refuses a list longer than the backend ever opens', () => {
    expect(parseSlots(Array.from({ length: MAX_PAGES + 1 }, (_, i) => slot(i)))).toBeNull();
    expect(parseSlots(Array.from({ length: MAX_PAGES }, (_, i) => slot(i)))).toHaveLength(MAX_PAGES);
  });
});

describe('sources', () => {
  it('parses ready and failed results, and an empty list for a cancelled dialog', async () => {
    invokeMock.mockResolvedValueOnce([
      { type: 'ready', sourceId: 3, displayName: 'a.pdf', pageCount: 5 },
      { type: 'failed', code: 'not_a_pdf', key: 'error.not_a_pdf' },
    ]);
    const results = await pickPdfSources(true);
    expect(results[0]).toEqual({ type: 'ready', sourceId: 3, displayName: 'a.pdf', pageCount: 5 });
    expect(results[1]).toMatchObject({ type: 'failed', code: 'not_a_pdf' });
    expect(invokeMock).toHaveBeenCalledWith('pick_pdf_sources', { multiple: true });
    invokeMock.mockResolvedValueOnce([]);
    expect(await pickPdfSources(false)).toEqual([]);
  });

  it('refuses a result that is neither', async () => {
    invokeMock.mockResolvedValueOnce([{ type: 'ready', sourceId: -1, displayName: 'a', pageCount: 1 }]);
    await expect(pickPdfSources(true)).rejects.toMatchObject({ code: 'internal' });
  });

  it('releases by id', async () => {
    invokeMock.mockResolvedValueOnce(undefined);
    await releaseSource(7);
    expect(invokeMock).toHaveBeenCalledWith('release_source', { sourceId: 7 });
  });
});
