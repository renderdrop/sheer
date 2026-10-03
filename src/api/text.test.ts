import { invoke } from '@tauri-apps/api/core';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { MAX_TEXT_CHARS, getTextLayer, parseTextLayer } from './text';

vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn() }));

const invokeMock = vi.mocked(invoke);

beforeEach(() => {
  invokeMock.mockReset();
});

/** A layer of `text` with four boxes (x, y, w, h) for each code unit. */
function layerOf(text: string, truncated = false): { text: string; boxes: number[]; truncated: boolean } {
  const boxes: number[] = [];
  for (let i = 0; i < text.length; i += 1) boxes.push(10 + (i % 500), 20, 5, 12);
  return { text, boxes, truncated };
}

describe('getTextLayer', () => {
  it('calls get_text_layer with the document and the page and returns the text and the boxes', async () => {
    invokeMock.mockResolvedValueOnce(layerOf('Gr\u00fc\u00dfe'));
    const layer = await getTextLayer(3, 1);
    expect(invokeMock).toHaveBeenCalledWith('get_text_layer', { docId: 3, pageId: 1 });
    expect(layer.text).toBe('Gr\u00fc\u00dfe');
    expect(layer.truncated).toBe(false);
    expect(layer.boxes).toBeInstanceOf(Float32Array);
    expect(layer.boxes).toHaveLength(20);
    // The box of the third code unit.
    expect(Array.from(layer.boxes.subarray(8, 12))).toEqual([12, 20, 5, 12]);
  });

  it('has a box for every code unit as JavaScript counts: an emoji is two', async () => {
    const answer = layerOf('a\u{1f600}b');
    expect(answer.text).toHaveLength(4);
    invokeMock.mockResolvedValueOnce(answer);
    const layer = await getTextLayer(0, 0);
    expect(layer.boxes).toHaveLength(16);
  });

  it('keeps the values the backend rounded to a hundredth of a point to within what a Float32Array holds', async () => {
    invokeMock.mockResolvedValueOnce({ text: 'a', boxes: [72.37, 79.33, 10.89, 15.62], truncated: true });
    const layer = await getTextLayer(0, 0);
    expect(layer.truncated).toBe(true);
    const [x, y, w, h] = Array.from(layer.boxes);
    expect(x).toBeCloseTo(72.37, 4);
    expect(y).toBeCloseTo(79.33, 4);
    expect(w).toBeCloseTo(10.89, 4);
    expect(h).toBeCloseTo(15.62, 4);
  });

  it('answers with an empty layer for a page without text', async () => {
    invokeMock.mockResolvedValueOnce({ text: '', boxes: [], truncated: false });
    await expect(getTextLayer(0, 0)).resolves.toMatchObject({ text: '', truncated: false });
  });

  it('drops keys that are not part of a layer', async () => {
    invokeMock.mockResolvedValueOnce({ ...layerOf('a'), path: 'C:\\secret.pdf' });
    const layer = await getTextLayer(0, 0);
    expect(Object.keys(layer).sort()).toEqual(['boxes', 'text', 'truncated']);
  });

  it('rejects with the backend error', async () => {
    invokeMock.mockRejectedValue({
      code: 'invalid_argument',
      key: 'error.invalid_argument',
      retryable: false,
      params: { what: 'page' },
    });
    await expect(getTextLayer(0, 99)).rejects.toMatchObject({ code: 'invalid_argument', params: { what: 'page' } });
  });

  it('turns an answer that is not a text layer into the generic error', async () => {
    const ok = layerOf('ab');
    for (const bad of [
      null,
      [],
      'text',
      { ...ok, text: 7 },
      { ...ok, truncated: 'no' },
      { ...ok, boxes: ok.boxes.slice(0, 7) },
      { ...ok, boxes: [...ok.boxes, 0, 0, 0, 0] },
      { ...ok, boxes: 'boxes' },
      { ...ok, boxes: ok.boxes.map((value, i) => (i === 3 ? '12' : value)) },
      { ...ok, boxes: ok.boxes.map((value, i) => (i === 3 ? Number.NaN : value)) },
      { ...ok, boxes: ok.boxes.map((value, i) => (i === 0 ? 20_000 : value)) },
      { ...ok, boxes: ok.boxes.map((value, i) => (i === 2 ? -1 : value)) },
      { ...ok, boxes: ok.boxes.map((value, i) => (i === 7 ? -0.5 : value)) },
    ]) {
      invokeMock.mockResolvedValueOnce(bad);
      await expect(getTextLayer(0, 0), JSON.stringify(bad)).rejects.toMatchObject({ code: 'internal' });
    }
  });
});

describe('parseTextLayer', () => {
  it('takes 200 000 code units and not one more', () => {
    expect(parseTextLayer(layerOf('x'.repeat(MAX_TEXT_CHARS), true))?.text).toHaveLength(MAX_TEXT_CHARS);
    expect(parseTextLayer(layerOf('x'.repeat(MAX_TEXT_CHARS + 1)))).toBeNull();
  });

  it('takes a position that is negative (text outside the page) and a size that is zero (a line break)', () => {
    expect(parseTextLayer({ text: '\n', boxes: [-5, -3, 0, 0], truncated: false })).not.toBeNull();
  });
});
