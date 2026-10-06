import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { TextLineInfo } from '../../api/textEdit';
import { openEdit } from './actions';
import { loadLines, resetLines } from './lines';
import { ringSpan } from './model';
import { useTextEdit } from './store';

const api = vi.hoisted(() => ({ textEditLines: vi.fn() }));
vi.mock('../../api/textEdit', async (original) => ({
  ...(await original<object>()),
  textEditLines: api.textEditLines,
}));
vi.mock('../search/jump', () => ({ jumpToHit: vi.fn() }));

const line = (i: number, paragraph: number, patch: Partial<TextLineInfo> = {}): TextLineInfo => ({
  key: { rev: 0, line: i },
  text: `line ${i}`,
  box: { x: 10, y: 10 + i * 14, w: 100, h: 10 },
  paragraph,
  justified: false,
  font: { name: 'Helvetica', size: 10, embedded: true },
  editable: { type: 'same' },
  ...patch,
});

beforeEach(() => {
  resetLines();
  useTextEdit.getState().reset();
});

describe('Umbrechen default (ADR-132)', () => {
  it('is on for a line of a multi-line paragraph, even after the user switched it off before', async () => {
    const lines = [line(0, 0), line(1, 0), line(2, 1)];
    api.textEditLines.mockResolvedValue({ lines });
    await loadLines(1, 0);
    useTextEdit.getState().set({ reflow: false });
    await openEdit({ docId: 1, pageId: 0, line: lines[1] as TextLineInfo });
    expect(useTextEdit.getState().reflow).toBe(true);
    useTextEdit.getState().set({ reflow: false });
    expect(useTextEdit.getState().reflow).toBe(false);
    await openEdit({ docId: 1, pageId: 0, line: lines[2] as TextLineInfo });
    expect(useTextEdit.getState().reflow).toBe(false);
  });

  it('never opens a box on a line the backend marks not editable', async () => {
    const lines = [line(0, 0), line(1, 0, { editable: { type: 'no', reason: 'type3' } })];
    api.textEditLines.mockResolvedValue({ lines });
    await loadLines(1, 0);
    expect(await openEdit({ docId: 1, pageId: 0, line: lines[1] as TextLineInfo })).toBe(false);
    expect(useTextEdit.getState().session).toBeNull();
  });
});

describe('ringSpan', () => {
  const box = { x: 100, y: 0, w: 50, h: 10 };
  const win = { left: 20, right: 300 };
  it('grows right from a left-aligned start', () => {
    expect(ringSpan('left', box, 120, win)).toEqual({ x: 100, w: 120 });
  });
  it('grows left from a right-aligned end', () => {
    expect(ringSpan('right', box, 120, win)).toEqual({ x: 30, w: 120 });
  });
  it('grows both ways from a centred middle', () => {
    expect(ringSpan('center', box, 150, win)).toEqual({ x: 50, w: 150 });
  });
  it('never shrinks below the line and stops at the window', () => {
    expect(ringSpan('left', box, 10, win)).toEqual({ x: 100, w: 50 });
    expect(ringSpan('left', box, 900, win)).toEqual({ x: 100, w: 200 });
    expect(ringSpan('right', box, 900, win)).toEqual({ x: 20, w: 130 });
  });
});
