import { invoke } from '@tauri-apps/api/core';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { parseTextPreview, textEditPreview, type TextPreviewRequest } from './textPreview';

vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn() }));

const invokeMock = vi.mocked(invoke);

beforeEach(() => {
  invokeMock.mockReset();
});

function wire(meta: unknown, png: number[] = [137, 80, 78, 71]): ArrayBuffer {
  const json = new TextEncoder().encode(JSON.stringify(meta));
  const out = new Uint8Array(4 + json.length + png.length);
  new DataView(out.buffer).setUint32(0, json.length, true);
  out.set(json, 4);
  out.set(png, 4 + json.length);
  return out.buffer;
}

const META = {
  generation: 7,
  rect: { x: 10, y: 20, w: 100, h: 16 },
  pxPerPt: 2,
  overflowPt: 0,
  fallback: null,
};

const REQUEST: TextPreviewRequest = {
  docId: 3,
  pageId: 1,
  key: { rev: 0, line: 2 },
  text: 'Hello',
  fit: 'keepStart',
  scope: 'line',
  generation: 7,
  scale: 2,
};

describe('text preview wrapper', () => {
  it('sends ids and the draft only and parses the answer', async () => {
    invokeMock.mockResolvedValueOnce(wire({ ...META, fallback: { face: 'serif', chars: ['Ω'] }, overflowPt: 4.5 }));
    const preview = await textEditPreview(REQUEST);
    expect(invokeMock).toHaveBeenCalledWith('text_edit_preview', {
      docId: 3,
      pageId: 1,
      key: { rev: 0, line: 2 },
      text: 'Hello',
      fit: 'keepStart',
      scope: 'line',
      generation: 7,
      scale: 2,
    });
    expect(preview.generation).toBe(7);
    expect(preview.rect).toEqual({ x: 10, y: 20, w: 100, h: 16 });
    expect(preview.overflowPt).toBe(4.5);
    expect(preview.fallback).toEqual({ face: 'serif', chars: ['Ω'] });
    expect([...preview.png]).toEqual([137, 80, 78, 71]);
  });

  it('keeps the png and a null fallback for text that fits', () => {
    const preview = parseTextPreview(wire(META));
    expect(preview?.fallback).toBeNull();
    expect(preview?.pxPerPt).toBe(2);
  });

  it('rejects answers of another shape as internal errors', async () => {
    invokeMock.mockResolvedValueOnce(new ArrayBuffer(2));
    await expect(textEditPreview(REQUEST)).rejects.toMatchObject({ code: 'internal' });
  });

  it('refuses malformed metadata', () => {
    expect(parseTextPreview(new ArrayBuffer(0))).toBeNull();
    expect(parseTextPreview(wire({ ...META, generation: -1 }))).toBeNull();
    expect(parseTextPreview(wire({ ...META, pxPerPt: 0 }))).toBeNull();
    expect(parseTextPreview(wire({ ...META, overflowPt: -1 }))).toBeNull();
    expect(parseTextPreview(wire({ ...META, rect: { x: 0 } }))).toBeNull();
    expect(parseTextPreview(wire({ ...META, fallback: { face: 'comic', chars: [] } }))).toBeNull();
    expect(parseTextPreview(wire({ ...META, fallback: { face: 'sans', chars: [1] } }))).toBeNull();
    // A length that runs past the body, and a body without a picture.
    const lying = new Uint8Array(wire(META));
    new DataView(lying.buffer).setUint32(0, 0xffff, true);
    expect(parseTextPreview(lying.buffer)).toBeNull();
    expect(parseTextPreview(wire(META, []))).toBeNull();
  });

  it('passes the backend refusals on as app errors', async () => {
    invokeMock.mockRejectedValueOnce({ code: 'cancelled' });
    await expect(textEditPreview(REQUEST)).rejects.toMatchObject({ code: 'cancelled' });
  });
});
