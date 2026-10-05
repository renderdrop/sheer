// @vitest-environment jsdom
import { act, renderHook, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { emptyBibRecord, type BibliographyInfo } from '../../api/citations';
import { fetchBibliography, invalidateBibliography, useBibliography } from './bibliography';

const api = vi.hoisted(() => ({ getBibliography: vi.fn() }));
vi.mock('../../api/citations', async (original) => ({
  ...(await original<typeof import('../../api/citations')>()),
  getBibliography: api.getBibliography,
}));

const info = (title: string): BibliographyInfo => ({
  record: { ...emptyBibRecord(), title },
  sources: {},
  pending: false,
  droppedByStrip: false,
});

beforeEach(() => {
  invalidateBibliography(1);
  invalidateBibliography(2);
  api.getBibliography.mockReset().mockResolvedValue(info('First'));
});

describe('bibliography cache', () => {
  it('fetches once per document and shares the answer', async () => {
    const a = renderHook(() => useBibliography(1));
    const b = renderHook(() => useBibliography(1));
    await waitFor(() => expect(a.result.current.info?.record.title).toBe('First'));
    expect(b.result.current.info?.record.title).toBe('First');
    expect(await fetchBibliography(1)).toBe(a.result.current.info);
    expect(api.getBibliography).toHaveBeenCalledTimes(1);
  });

  it('starts as loading and keeps documents apart', async () => {
    const { result } = renderHook(() => useBibliography(2));
    expect(result.current).toEqual({ info: undefined, loading: true });
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(api.getBibliography).toHaveBeenCalledWith(2);
  });

  it('fetches again after an invalidation', async () => {
    const { result } = renderHook(() => useBibliography(1));
    await waitFor(() => expect(result.current.info?.record.title).toBe('First'));
    api.getBibliography.mockResolvedValue(info('Second'));
    act(() => invalidateBibliography(1));
    await waitFor(() => expect(result.current.info?.record.title).toBe('Second'));
    expect(api.getBibliography).toHaveBeenCalledTimes(2);
  });

  it('reports a failure and does not loop', async () => {
    api.getBibliography.mockRejectedValue({ code: 'internal' });
    const { result } = renderHook(() => useBibliography(1));
    await waitFor(() => expect(result.current.error).toBeDefined());
    expect(result.current.loading).toBe(false);
    expect(api.getBibliography).toHaveBeenCalledTimes(1);
  });

  it('drops an answer that an invalidation overtook', async () => {
    let resolve: (value: BibliographyInfo) => void = () => undefined;
    api.getBibliography.mockReturnValueOnce(new Promise<BibliographyInfo>((r) => (resolve = r)));
    const stale = fetchBibliography(1);
    invalidateBibliography(1);
    api.getBibliography.mockResolvedValue(info('Fresh'));
    expect((await fetchBibliography(1)).record.title).toBe('Fresh');
    resolve(info('Stale'));
    await stale;
    expect((await fetchBibliography(1)).record.title).toBe('Fresh');
  });
});
