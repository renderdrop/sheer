import { invoke } from '@tauri-apps/api/core';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { DocCommand } from './annotations';
import {
  MAX_LINES_PER_PAGE,
  parseChangeWarnings,
  parsePageTextLines,
  parseTextLineInfo,
  textEditLines,
  textEditProbe,
  type EditTextLine,
} from './textEdit';

vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn() }));

const invokeMock = vi.mocked(invoke);

beforeEach(() => {
  invokeMock.mockReset();
});

function lineOf(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    key: { rev: 0, line: 2 },
    text: 'Hello',
    box: { x: 10, y: 20, w: 30, h: 12 },
    paragraph: 1,
    justified: false,
    font: { name: 'Arial', size: 11, embedded: true },
    editable: { type: 'same' },
    ...over,
  };
}

describe('text edit wrappers', () => {
  it('probe sends ids only and parses the line', async () => {
    invokeMock.mockResolvedValueOnce(lineOf({ editable: { type: 'fallback', face: 'serif' } }));
    const info = await textEditProbe(3, 1, 42);
    expect(invokeMock).toHaveBeenCalledWith('text_edit_probe', { docId: 3, pageId: 1, unit: 42 });
    expect(info.editable).toEqual({ type: 'fallback', face: 'serif' });
    expect(info.box.w).toBe(30);
  });

  it('lines sends ids only and parses the list', async () => {
    invokeMock.mockResolvedValueOnce({ lines: [lineOf(), lineOf({ editable: { type: 'no', reason: 'type3' } })] });
    const result = await textEditLines(3, 1);
    expect(invokeMock).toHaveBeenCalledWith('text_edit_lines', { docId: 3, pageId: 1 });
    expect(result.lines).toHaveLength(2);
  });

  it('rejects an answer of another shape', async () => {
    invokeMock.mockResolvedValueOnce({ nope: true });
    await expect(textEditProbe(3, 1, 0)).rejects.toBeDefined();
  });
});

describe('parsers', () => {
  it('refuses unknown refusals, faces and oversized text', () => {
    expect(parseTextLineInfo(lineOf({ editable: { type: 'no', reason: 'bogus' } }))).toBeNull();
    expect(parseTextLineInfo(lineOf({ editable: { type: 'fallback', face: 'comic' } }))).toBeNull();
    expect(parseTextLineInfo(lineOf({ text: 'a'.repeat(2_001) }))).toBeNull();
    expect(parseTextLineInfo(lineOf({ key: { rev: -1, line: 0 } }))).toBeNull();
  });

  it('reads align and subset and defaults them for older answers', () => {
    const plain = parseTextLineInfo(lineOf());
    expect(plain?.align).toBe('left');
    expect(plain?.font.subset).toBe(false);
    const rich = parseTextLineInfo(
      lineOf({ align: 'right', font: { name: 'A', size: 9, embedded: true, subset: true } }),
    );
    expect(rich?.align).toBe('right');
    expect(rich?.font.subset).toBe(true);
    expect(parseTextLineInfo(lineOf({ align: 'bogus' }))?.align).toBe('left');
  });

  it('caps the list', () => {
    expect(parsePageTextLines({ lines: new Array(MAX_LINES_PER_PAGE + 1).fill(lineOf()) })).toBeNull();
  });

  it('keeps known warnings only', () => {
    expect(parseChangeWarnings(['textOverflow', 'x', 'fontFallback'])).toEqual(['textOverflow', 'fontFallback']);
    expect(parseChangeWarnings(undefined)).toEqual([]);
  });

  it('editTextLine is a DocCommand with the wire shape of the backend', () => {
    const command: EditTextLine = {
      type: 'editTextLine',
      pageId: 1,
      key: { rev: 2, line: 5 },
      text: 'x',
      fit: 'keepStart',
      scope: 'line',
    };
    const asCommand: DocCommand = command;
    expect(JSON.parse(JSON.stringify(asCommand))).toEqual(command);
  });
});
