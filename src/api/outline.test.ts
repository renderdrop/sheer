import { invoke } from '@tauri-apps/api/core';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import {
  MAX_OUTLINE_DEPTH,
  MAX_OUTLINE_NODES,
  MAX_OUTLINE_TITLE_CHARS,
  getOutline,
  parseOutline,
  type OutlineNode,
} from './outline';

vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn() }));

const invokeMock = vi.mocked(invoke);

beforeEach(() => {
  invokeMock.mockReset();
});

const leaf = (title: string, target: unknown = null): unknown => ({ title, target, children: [] });

/** A ladder `levels` deep, one node per level. */
function ladder(levels: number): unknown {
  let node: unknown = leaf(`Level ${levels}`);
  for (let level = levels - 1; level >= 1; level -= 1) {
    node = { title: `Level ${level}`, target: null, children: [node] };
  }
  return node;
}

describe('getOutline', () => {
  it('calls get_outline with the document id and returns the tree', async () => {
    const answer = [
      {
        title: 'Chapter 1',
        target: { pageId: 0, y: 92 },
        children: [leaf('Section 1.1', { pageId: 1, y: 292.5 })],
      },
      leaf('Website'),
    ];
    invokeMock.mockResolvedValueOnce(answer);
    const outline = await getOutline(7);
    expect(invokeMock).toHaveBeenCalledWith('get_outline', { docId: 7 });
    expect(outline).toStrictEqual(answer);
    expect(outline[0]?.children[0]?.target).toStrictEqual({ pageId: 1, y: 292.5 });
  });

  it('answers with an empty list for a document without an outline', async () => {
    invokeMock.mockResolvedValueOnce([]);
    await expect(getOutline(0)).resolves.toEqual([]);
  });

  it('drops keys that are not part of a node', async () => {
    invokeMock.mockResolvedValueOnce([
      { title: 'a', target: { pageId: 3, y: 1, path: 'C:\\x' }, children: [], path: 'C:\\secret.pdf' },
    ]);
    await expect(getOutline(0)).resolves.toStrictEqual([{ title: 'a', target: { pageId: 3, y: 1 }, children: [] }]);
  });

  it('keeps unicode titles as they are and does not read them as markup', async () => {
    const title = '\u00dcbersicht \u2013 Gr\u00f6\u00dfe <img src=x onerror=alert(1)>';
    invokeMock.mockResolvedValueOnce([leaf(title)]);
    await expect(getOutline(0)).resolves.toStrictEqual([{ title, target: null, children: [] }]);
  });

  it('rejects with the backend error', async () => {
    invokeMock.mockRejectedValue({
      code: 'not_found',
      key: 'error.not_found',
      retryable: false,
      params: { what: 'document' },
    });
    await expect(getOutline(9)).rejects.toMatchObject({ code: 'not_found', params: { what: 'document' } });
  });

  it('turns an answer that is not an outline into the generic error', async () => {
    for (const bad of [
      null,
      {},
      'outline',
      [null],
      [leaf('a'), 7],
      [{ title: 1, target: null, children: [] }],
      [{ title: 'a', target: null }],
      [{ title: 'a', target: null, children: {} }],
      [{ title: 'a', target: 'page 3', children: [] }],
      [{ title: 'a', target: { pageId: -1, y: 0 }, children: [] }],
      [{ title: 'a', target: { pageId: 1.5, y: 0 }, children: [] }],
      [{ title: 'a', target: { pageId: 1, y: -1 }, children: [] }],
      [{ title: 'a', target: { pageId: 1, y: 20_000 }, children: [] }],
      [{ title: 'a', target: { pageId: 1, y: Number.NaN }, children: [] }],
      [{ title: 'a', target: { pageId: 1 }, children: [] }],
    ]) {
      invokeMock.mockResolvedValueOnce(bad);
      await expect(getOutline(0), JSON.stringify(bad)).rejects.toMatchObject({ code: 'internal' });
    }
  });
});

describe('the bounds of an outline', () => {
  it('takes 32 levels and not a 33rd', () => {
    expect(parseOutline([ladder(MAX_OUTLINE_DEPTH)])).not.toBeNull();
    expect(parseOutline([ladder(MAX_OUTLINE_DEPTH + 1)])).toBeNull();
    expect(parseOutline([ladder(500)])).toBeNull();
  });

  it('takes 10 000 nodes and not one more, however they are arranged', () => {
    const flat = (count: number): unknown[] => Array.from({ length: count }, (_, n) => leaf(`Item ${n}`));
    expect(parseOutline(flat(MAX_OUTLINE_NODES))).toHaveLength(MAX_OUTLINE_NODES);
    expect(parseOutline(flat(MAX_OUTLINE_NODES + 1))).toBeNull();
    // Children count against the same budget.
    const nested = [{ title: 'p', target: null, children: flat(MAX_OUTLINE_NODES - 1) }];
    expect(parseOutline(nested)).not.toBeNull();
    const tooMany = [{ title: 'p', target: null, children: flat(MAX_OUTLINE_NODES) }];
    expect(parseOutline(tooMany)).toBeNull();
  });

  it('counts a title in characters, not in UTF-16 code units', () => {
    expect(parseOutline([leaf('x'.repeat(MAX_OUTLINE_TITLE_CHARS))])).not.toBeNull();
    expect(parseOutline([leaf('x'.repeat(MAX_OUTLINE_TITLE_CHARS + 1))])).toBeNull();
    // 512 emoji are 1024 code units and 512 characters: fine. 513 are not.
    expect(parseOutline([leaf('\u{1f600}'.repeat(MAX_OUTLINE_TITLE_CHARS))])).not.toBeNull();
    expect(parseOutline([leaf('\u{1f600}'.repeat(MAX_OUTLINE_TITLE_CHARS + 1))])).toBeNull();
    expect(parseOutline([leaf('')])).not.toBeNull();
  });

  it('reads the first node of a long outline as the first', () => {
    const outline: OutlineNode[] | null = parseOutline([leaf('first'), leaf('second')]);
    expect(outline?.map((node) => node.title)).toEqual(['first', 'second']);
  });
});
