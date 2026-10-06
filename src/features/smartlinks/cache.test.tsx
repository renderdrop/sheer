// @vitest-environment jsdom
import { act, cleanup, renderHook, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { SmartLink } from '../../api/smartLinks';
import { useDocuments } from '../../stores/documents';
import { resetDocuments } from '../../stores/documents.testutil';
import { READY_RETRY_MS, clearSmartLinkCache, usePageSmartLinks } from './cache';
import { useSmartLinks } from './store';

const api = vi.hoisted(() => ({ getSmartLinks: vi.fn() }));
vi.mock('../../api/smartLinks', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../api/smartLinks')>()),
  getSmartLinks: api.getSmartLinks,
}));

const footnote = (marker: string): SmartLink => ({
  kind: 'footnote',
  rects: [{ x: 1, y: 2, w: 3, h: 4 }],
  marker,
  target: { pageId: 1 },
  preview: '',
});
const answer = (rev: number, links: SmartLink[] = [footnote('1')], ready = true) =>
  Promise.resolve({ rev, ready, links });

beforeEach(() => {
  clearSmartLinkCache();
  resetDocuments();
  useDocuments.getState().add({ id: 1, pageCount: 5, displayName: 'a.pdf' });
  useSmartLinks.setState({ enabled: true, overrides: {}, visited: {} });
  api.getSmartLinks.mockReset().mockImplementation(() => answer(1));
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  resetDocuments();
});

describe('fetching smart links lazily (L10)', () => {
  it('asks for a page that is active, once, and answers its links', async () => {
    const { result, rerender } = renderHook(() => usePageSmartLinks(1, 0, 's1', true));
    expect(result.current).toBeNull();
    await waitFor(() => expect(result.current).toHaveLength(1));
    rerender();
    expect(api.getSmartLinks).toHaveBeenCalledTimes(1);
    expect(api.getSmartLinks).toHaveBeenCalledWith(1, 0);
  });

  it('asks for nothing while off or hidden, and answers nothing', async () => {
    const { result } = renderHook(() => usePageSmartLinks(1, 0, 's1', false));
    await act(() => new Promise((done) => setTimeout(done, 30)));
    expect(api.getSmartLinks).not.toHaveBeenCalled();
    expect(result.current).toBeNull();
  });

  it('keeps the links per page and stamp: a second reader does not ask again', async () => {
    const first = renderHook(() => usePageSmartLinks(1, 0, 's1', true));
    await waitFor(() => expect(first.result.current).toHaveLength(1));
    const second = renderHook(() => usePageSmartLinks(1, 0, 's1', true));
    expect(second.result.current).toBe(first.result.current);
    expect(api.getSmartLinks).toHaveBeenCalledTimes(1);
  });

  it('never answers the links of an older stamp: a change hides them and asks again', async () => {
    api.getSmartLinks
      .mockImplementationOnce(() => answer(1, [footnote('old')]))
      .mockImplementationOnce(() => answer(2, [footnote('new')]));
    const { result, rerender } = renderHook(({ stamp }) => usePageSmartLinks(1, 0, stamp, true), {
      initialProps: { stamp: 's1' },
    });
    await waitFor(() => expect(result.current?.[0]?.marker).toBe('old'));
    rerender({ stamp: 's2' });
    expect(result.current).toBeNull();
    await waitFor(() => expect(result.current?.[0]?.marker).toBe('new'));
    expect(api.getSmartLinks).toHaveBeenCalledTimes(2);
  });

  it('an answer for a stamp that was replaced meanwhile is dropped', async () => {
    let release: (() => void) | undefined;
    api.getSmartLinks
      .mockImplementationOnce(
        () => new Promise((done) => (release = () => done({ rev: 1, ready: true, links: [footnote('old')] }))),
      )
      .mockImplementationOnce(() => answer(2, [footnote('new')]));
    const { result, rerender } = renderHook(({ stamp }) => usePageSmartLinks(1, 0, stamp, true), {
      initialProps: { stamp: 's1' },
    });
    await waitFor(() => expect(api.getSmartLinks).toHaveBeenCalledTimes(1));
    rerender({ stamp: 's2' });
    await waitFor(() => expect(result.current?.[0]?.marker).toBe('new'));
    await act(async () => release?.());
    expect(result.current?.[0]?.marker).toBe('new');
  });

  it('a newer revision drops the links other pages hold for an older one, which are asked for again', async () => {
    api.getSmartLinks
      .mockImplementationOnce(() => answer(1, [footnote('a')]))
      .mockImplementationOnce(() => answer(2, [footnote('b')]))
      .mockImplementationOnce(() => answer(2, [footnote('c')]));
    const zero = renderHook(() => usePageSmartLinks(1, 0, 's1', true));
    await waitFor(() => expect(zero.result.current?.[0]?.marker).toBe('a'));
    const one = renderHook(() => usePageSmartLinks(1, 1, 's1', true));
    await waitFor(() => expect(one.result.current?.[0]?.marker).toBe('b'));
    await waitFor(() => expect(zero.result.current?.[0]?.marker).toBe('c'));
    expect(api.getSmartLinks).toHaveBeenCalledTimes(3);
  });

  it('asks again while the document index is not ready, and stops when nobody wants the page any more', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    api.getSmartLinks.mockImplementationOnce(() => answer(1, [], false)).mockImplementation(() => answer(1));
    const { result, unmount } = renderHook(() => usePageSmartLinks(1, 0, 's1', true));
    await act(() => vi.advanceTimersByTimeAsync(10));
    expect(result.current).toBeNull();
    expect(api.getSmartLinks).toHaveBeenCalledTimes(1);
    await act(() => vi.advanceTimersByTimeAsync(READY_RETRY_MS + 10));
    expect(api.getSmartLinks).toHaveBeenCalledTimes(2);
    expect(result.current).toHaveLength(1);
    unmount();
  });

  it('a page that cannot be answered has no links and is not asked again for that stamp', async () => {
    api.getSmartLinks.mockImplementation(() => Promise.reject(new Error('no')));
    const { result } = renderHook(() => usePageSmartLinks(1, 0, 's1', true));
    await waitFor(() => expect(result.current).toEqual([]));
    expect(api.getSmartLinks).toHaveBeenCalledTimes(1);
  });

  it('forgets the links of a closed document', async () => {
    const { result } = renderHook(() => usePageSmartLinks(1, 0, 's1', true));
    await waitFor(() => expect(result.current).toHaveLength(1));
    act(() => useDocuments.getState().remove(1));
    expect(result.current).toBeNull();
  });
});
