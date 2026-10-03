import { invoke } from '@tauri-apps/api/core';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { MAX_PAGE_LINKS, MAX_URL_LEN, getPageLinks, openLink, parsePageLinks } from './links';

vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn() }));

const invokeMock = vi.mocked(invoke);

beforeEach(() => {
  invokeMock.mockReset();
});

const RECT = { x: 72, y: 72, w: 200, h: 20 };
const link = (index: number, target: unknown, rect: unknown = RECT): unknown => ({ index, rect, target });
const url = (address: string) => ({ type: 'url', url: address });

describe('getPageLinks', () => {
  it('calls get_page_links with the document and the page and returns the links', async () => {
    const answer = [
      link(0, url('https://example.com/docs')),
      link(1, { type: 'page', pageId: 2, y: 100 }),
      link(2, { type: 'blocked' }),
      link(3, url('mailto:team@example.com?subject=Hello')),
    ];
    invokeMock.mockResolvedValueOnce(answer);
    const links = await getPageLinks(4, 0);
    expect(invokeMock).toHaveBeenCalledWith('get_page_links', { docId: 4, pageId: 0 });
    expect(links).toStrictEqual(answer);
  });

  it('answers with an empty list for a page without links', async () => {
    invokeMock.mockResolvedValueOnce([]);
    await expect(getPageLinks(0, 0)).resolves.toEqual([]);
  });

  it('drops keys that are not part of a link', async () => {
    invokeMock.mockResolvedValueOnce([
      { index: 0, rect: { ...RECT, z: 1 }, target: { type: 'blocked', action: 'Launch', file: 'calc.exe' }, path: 'x' },
    ]);
    await expect(getPageLinks(0, 0)).resolves.toStrictEqual([{ index: 0, rect: RECT, target: { type: 'blocked' } }]);
  });

  it('rejects with the backend error', async () => {
    invokeMock.mockRejectedValue({
      code: 'invalid_argument',
      key: 'error.invalid_argument',
      retryable: false,
      params: { what: 'page' },
    });
    await expect(getPageLinks(0, 9)).rejects.toMatchObject({ code: 'invalid_argument' });
  });

  it('turns an answer that is not a list of links into the generic error', async () => {
    for (const bad of [
      null,
      {},
      [null],
      // The indices are the position in the list.
      [link(1, { type: 'blocked' })],
      [link(0, { type: 'blocked' }), link(0, { type: 'blocked' })],
      [link(0, { type: 'blocked' }), link(2, { type: 'blocked' })],
      [link(0, { type: 'blocked' }, { x: 1, y: 1, w: -1, h: 1 })],
      [link(0, { type: 'blocked' }, null)],
      [link(0, null)],
      [link(0, { type: 'launch', file: 'calc.exe' })],
      [link(0, { type: 'page', pageId: -1, y: 0 })],
      [link(0, { type: 'page', pageId: 1 })],
      [link(0, { type: 'url' })],
      [link(0, { type: 'url', url: 7 })],
    ]) {
      invokeMock.mockResolvedValueOnce(bad);
      await expect(getPageLinks(0, 0), JSON.stringify(bad)).rejects.toMatchObject({ code: 'internal' });
    }
  });

  it('does not take a URL that the backend would not have let through: another scheme, a space, anything that is not printable ASCII', () => {
    for (const address of [
      'javascript:alert(1)',
      'file:///C:/Windows/System32/calc.exe',
      'ftp://example.com/',
      'example.com',
      'https://example.com/a b',
      'https://example.com/\u202etxt.exe',
      'https://example.com/\n',
      'https://exаmple.com/',
      '',
    ]) {
      expect(parsePageLinks([link(0, url(address))]), address).toBeNull();
    }
    for (const address of ['http://example.com', 'HTTPS://EXAMPLE.COM/UP', 'mailto:a@b.c?subject=x%20y']) {
      expect(parsePageLinks([link(0, url(address))]), address).not.toBeNull();
    }
  });
});

describe('the bounds of a list of links', () => {
  it('takes 1 000 links and not one more', () => {
    const links = (count: number) => Array.from({ length: count }, (_, n) => link(n, { type: 'blocked' }));
    expect(parsePageLinks(links(MAX_PAGE_LINKS))).toHaveLength(MAX_PAGE_LINKS);
    expect(parsePageLinks(links(MAX_PAGE_LINKS + 1))).toBeNull();
  });

  it('takes a URL of 2048 bytes and not one more', () => {
    const prefix = 'https://example.com/';
    const address = (length: number) => prefix + 'a'.repeat(length - prefix.length);
    expect(parsePageLinks([link(0, url(address(MAX_URL_LEN)))])).not.toBeNull();
    expect(parsePageLinks([link(0, url(address(MAX_URL_LEN + 1)))])).toBeNull();
  });
});

describe('openLink', () => {
  it('names the link by document, page and index and passes no URL', async () => {
    invokeMock.mockResolvedValueOnce(undefined);
    await openLink(3, 1, 7);
    expect(invokeMock).toHaveBeenCalledWith('open_link', { docId: 3, pageId: 1, linkIndex: 7 });
  });

  it('resolves when the user has decided, whichever way', async () => {
    invokeMock.mockResolvedValueOnce(undefined);
    await expect(openLink(0, 0, 0)).resolves.toBeUndefined();
  });

  it('rejects with the backend error for a link that cannot be opened', async () => {
    invokeMock.mockRejectedValue({
      code: 'invalid_argument',
      key: 'error.invalid_argument',
      retryable: false,
      params: { what: 'link' },
    });
    await expect(openLink(0, 0, 3)).rejects.toMatchObject({ code: 'invalid_argument', params: { what: 'link' } });
  });
});
