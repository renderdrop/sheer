import { invoke } from '@tauri-apps/api/core';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { MAX_PREVIEW_CHARS, MAX_SMART_LINKS, getSmartLinks, parseSmartLinks } from './smartLinks';

vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn() }));

const invokeMock = vi.mocked(invoke);

beforeEach(() => {
  invokeMock.mockReset();
});

const RECT = { x: 72, y: 72, w: 10, h: 8 };
const link = (over: Record<string, unknown> = {}): unknown => ({
  kind: 'footnote',
  rects: [RECT],
  marker: '1',
  target: { pageId: 3, rect: { x: 72, y: 700, w: 300, h: 9 } },
  preview: 'See the source.',
  ...over,
});

describe('getSmartLinks', () => {
  it('calls smart_links with the document and the page and returns the answer', async () => {
    const answer = {
      rev: 4,
      ready: true,
      links: [link(), link({ kind: 'reference', target: { pageId: 9 }, preview: '' })],
    };
    invokeMock.mockResolvedValueOnce(answer);
    const result = await getSmartLinks(2, 5);
    expect(invokeMock).toHaveBeenCalledWith('smart_links', { docId: 2, pageId: 5 });
    expect(result).toStrictEqual(answer);
  });

  it('answers not ready with no links', async () => {
    invokeMock.mockResolvedValueOnce({ rev: 0, ready: false, links: [] });
    await expect(getSmartLinks(0, 0)).resolves.toEqual({ rev: 0, ready: false, links: [] });
  });

  it('drops keys that are not part of a link', async () => {
    invokeMock.mockResolvedValueOnce({
      rev: 1,
      ready: true,
      links: [link({ path: 'C:/x.pdf', text: 'secret' })],
      extra: 1,
    });
    const result = await getSmartLinks(0, 0);
    expect(Object.keys(result)).toEqual(['rev', 'ready', 'links']);
    expect(Object.keys(result.links[0] as object).sort()).toEqual(['kind', 'marker', 'preview', 'rects', 'target']);
  });

  it('turns a malformed answer into an internal error', async () => {
    invokeMock.mockResolvedValueOnce({ rev: 1, ready: true, links: [link({ kind: 'url' })] });
    await expect(getSmartLinks(0, 0)).rejects.toMatchObject({ code: 'internal' });
  });

  it('passes a backend error on', async () => {
    invokeMock.mockRejectedValueOnce({
      code: 'invalid_argument',
      key: 'error.invalid_argument',
      retryable: false,
      params: { what: 'page' },
    });
    await expect(getSmartLinks(0, 99)).rejects.toMatchObject({ code: 'invalid_argument', params: { what: 'page' } });
  });
});

describe('parseSmartLinks', () => {
  it('refuses answers that break the documented shape', () => {
    const ok = { rev: 1, ready: true, links: [link()] };
    expect(parseSmartLinks(ok)).not.toBeNull();
    const bad: unknown[] = [
      null,
      [],
      { ...ok, rev: -1 },
      { ...ok, rev: 1.5 },
      { ...ok, ready: 'yes' },
      { ...ok, links: 'x' },
      { ...ok, links: Array.from({ length: MAX_SMART_LINKS + 1 }, () => link()) },
      { ...ok, links: [link({ rects: [] })] },
      { ...ok, links: [link({ rects: [{ x: 0, y: 0, w: -1, h: 1 }] })] },
      { ...ok, links: [link({ rects: [{ x: Number.NaN, y: 0, w: 1, h: 1 }] })] },
      { ...ok, links: [link({ marker: 3 })] },
      { ...ok, links: [link({ preview: 'x'.repeat(MAX_PREVIEW_CHARS + 1) })] },
      { ...ok, links: [link({ target: { pageId: -1 } })] },
      { ...ok, links: [link({ target: { pageId: 1, rect: { x: 0 } } })] },
      { ...ok, links: [link({ target: null })] },
    ];
    for (const value of bad) expect(parseSmartLinks(value), JSON.stringify(value)).toBeNull();
  });

  it('accepts a target without a box', () => {
    const result = parseSmartLinks({ rev: 1, ready: true, links: [link({ target: { pageId: 2 } })] });
    expect(result?.links[0]?.target).toEqual({ pageId: 2 });
  });
});
