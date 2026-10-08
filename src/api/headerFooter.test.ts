import { invoke } from '@tauri-apps/api/core';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { toAppError } from './errors';
import {
  detectHeaderFooter,
  getHeaderFooter,
  parseHfSpec,
  parseHeaderFooterInfo,
  resolveHeaderFooter,
  setHeaderFooter,
  type HfSpec,
} from './headerFooter';

vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn(), Channel: class {} }));

const invokeMock = vi.mocked(invoke);
beforeEach(() => invokeMock.mockReset());

const SPEC: HfSpec = {
  slots: {
    headerLeft: '',
    headerCenter: '{file}',
    headerRight: '',
    footerLeft: '{date}',
    footerCenter: '',
    footerRight: '{page}',
  },
  pages: { type: 'ranges', text: '2-' },
  fontSize: 9,
  margin: 28,
  color: [15, 15, 15],
  date: '07.10.2026',
  background: false,
};

const INFO = { spec: SPEC, defaults: SPEC, pending: true, fileLayers: 2, refusal: null };

const RUN = { text: '7', origin: { x: 500, y: 760 }, angle: 90, size: 9, width: 5 };

describe('header and footer api', () => {
  it('reads the info', async () => {
    invokeMock.mockResolvedValueOnce(INFO);
    expect(await getHeaderFooter(3)).toEqual(INFO);
    expect(invokeMock).toHaveBeenCalledWith('get_header_footer', { docId: 3 });
    expect(parseHeaderFooterInfo({ ...INFO, spec: null, refusal: 'signed' }).refusal).toBe('signed');
  });

  it('rejects an info of another shape as an internal error', async () => {
    for (const bad of [
      'nope',
      { ...INFO, refusal: 'cloud' },
      { ...INFO, fileLayers: -1 },
      { ...INFO, spec: { ...SPEC, fontSize: 'big' } },
      { ...INFO, spec: { ...SPEC, slots: { headerLeft: '' } } },
      { ...INFO, spec: { ...SPEC, pages: { type: 'some' } } },
      { ...INFO, spec: { ...SPEC, color: [1, 2, 300] } },
    ]) {
      invokeMock.mockResolvedValueOnce(bad);
      expect(toAppError(await getHeaderFooter(1).catch((e: unknown) => e)).code).toBe('internal');
    }
  });

  it('resolves the runs of pages and sends null for the current spec', async () => {
    invokeMock.mockResolvedValueOnce([{ pageId: 4, runs: [RUN], underFileLayer: false }]);
    expect(await resolveHeaderFooter(2, null, [4])).toEqual([{ pageId: 4, runs: [RUN], underFileLayer: false }]);
    expect(invokeMock).toHaveBeenCalledWith('resolve_header_footer', { docId: 2, spec: null, pages: [4] });
    invokeMock.mockResolvedValueOnce([{ pageId: 4, runs: [{ ...RUN, angle: 450 }], underFileLayer: false }]);
    expect(toAppError(await resolveHeaderFooter(2, SPEC, [4]).catch((e: unknown) => e)).code).toBe('internal');
  });

  it('stages a spec and a removal as one command each', async () => {
    const changes = {
      rev: 2,
      upserted: [],
      removed: [],
      pages: null,
      fields: [],
      history: { canUndo: true, canRedo: false, undoLabel: 'headerFooter.set', redoLabel: null, dirty: true },
      doc: ['headerFooter'],
    };
    invokeMock.mockResolvedValue(changes);
    expect((await setHeaderFooter(7, SPEC)).doc).toEqual(['headerFooter']);
    expect(invokeMock).toHaveBeenLastCalledWith('apply_command', {
      docId: 7,
      command: { type: 'setHeaderFooter', spec: SPEC },
    });
    await setHeaderFooter(7, null);
    expect(invokeMock).toHaveBeenLastCalledWith('apply_command', {
      docId: 7,
      command: { type: 'setHeaderFooter', spec: null },
    });
  });

  it('reads a spec without a background key as one without a background', () => {
    const old: Record<string, unknown> = { ...SPEC };
    delete old.background;
    expect(parseHfSpec(old)?.background).toBe(false);
    expect(parseHfSpec({ ...SPEC, background: true })?.background).toBe(true);
    expect(parseHfSpec({ ...SPEC, background: 'yes' })).toBeNull();
  });

  it('reads the detected headers and footers and refuses other shapes', async () => {
    const item = {
      edge: 'footer',
      slot: 'center',
      kind: 'pageNumber',
      text: 'Page 1 of 9',
      rect: { x: 280, y: 750, w: 50, h: 9 },
      pages: 4,
    };
    invokeMock.mockResolvedValueOnce({ items: [item], sampled: 4, pageCount: 9 });
    expect(await detectHeaderFooter(3)).toEqual({ items: [item], sampled: 4, pageCount: 9 });
    expect(invokeMock).toHaveBeenCalledWith('detect_header_footer', { docId: 3 });
    for (const bad of [
      'nope',
      { items: [{ ...item, edge: 'side' }], sampled: 1, pageCount: 1 },
      { items: [{ ...item, rect: { x: 1 } }], sampled: 1, pageCount: 1 },
      { items: Array.from({ length: 13 }, () => item), sampled: 1, pageCount: 1 },
      { items: [], sampled: -1, pageCount: 1 },
    ]) {
      invokeMock.mockResolvedValueOnce(bad);
      expect(toAppError(await detectHeaderFooter(1).catch((e: unknown) => e)).code).toBe('internal');
    }
  });

  it('passes a refusal of the backend on', async () => {
    invokeMock.mockRejectedValueOnce({
      code: 'read_only',
      key: 'error.read_only',
      retryable: false,
      params: { what: 'signed' },
    });
    const error = toAppError(await setHeaderFooter(1, SPEC).catch((e: unknown) => e));
    expect(error.code).toBe('read_only');
    expect(error.params?.what).toBe('signed');
  });
});
