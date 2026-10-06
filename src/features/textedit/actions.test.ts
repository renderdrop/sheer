import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { TextLineInfo } from '../../api/textEdit';
import { useAnnotations } from '../../stores/annotations';
import {
  canStepParagraph,
  cancelEdit,
  commitEdit,
  openEdit,
  retryEdit,
  stepEdit,
  stepParagraph,
  takeCaret,
} from './actions';
import { loadLines, resetLines } from './lines';
import { useTextEdit } from './store';

const api = vi.hoisted(() => ({ textEditLines: vi.fn() }));
vi.mock('../../api/textEdit', async (original) => ({
  ...(await original<object>()),
  textEditLines: api.textEditLines,
}));
vi.mock('../search/jump', () => ({ jumpToHit: vi.fn() }));

function line(i: number, text: string, patch: Partial<TextLineInfo> = {}): TextLineInfo {
  return {
    key: { rev: 0, line: i },
    text,
    box: { x: 10, y: 10 + i * 14, w: 100, h: 10 },
    paragraph: i,
    justified: false,
    font: { name: 'Helvetica', size: 10, embedded: true },
    editable: { type: 'same' },
    ...patch,
  };
}

const apply = vi.fn();

beforeEach(() => {
  vi.clearAllMocks();
  resetLines();
  useTextEdit.getState().reset();
  apply.mockResolvedValue({ rev: 1, upserted: [], removed: [], pages: null, history: {} });
  useAnnotations.setState({ apply });
  api.textEditLines.mockResolvedValue({
    lines: [line(0, 'one'), line(1, 'two'), line(2, 'three', { editable: { type: 'no', reason: 'type3' } })],
  });
});

describe('openEdit', () => {
  it('opens a session with the line as draft and the caret request', async () => {
    expect(await openEdit({ docId: 1, pageId: 0, line: line(0, 'one'), caret: { x: 3, y: 4 } })).toBe(true);
    const session = useTextEdit.getState().session;
    expect(session?.draft).toBe('one');
    expect(session?.status).toBe('editing');
    expect(takeCaret()).toEqual({ x: 3, y: 4 });
    expect(takeCaret()).toBe('end');
  });
  it('refuses a refused line', async () => {
    const refused = line(0, 'x', { editable: { type: 'no', reason: 'signed' } });
    expect(await openEdit({ docId: 1, pageId: 0, line: refused })).toBe(false);
    expect(useTextEdit.getState().session).toBeNull();
  });
  it('sets the not-embedded notice and the substitute for a fallback line', async () => {
    await openEdit({ docId: 1, pageId: 0, line: line(0, 'a b', { editable: { type: 'fallback', face: 'serif' } }) });
    const { session, notice } = useTextEdit.getState();
    expect(session?.fallback).toEqual({ face: 'serif', chars: ['a', 'b'] });
    expect(notice).toMatchObject({ kind: 'notEmbedded', face: 'serif' });
  });
});

describe('commitEdit', () => {
  it('sends one editTextLine and closes', async () => {
    await openEdit({ docId: 1, pageId: 7, line: line(0, 'one') });
    useTextEdit.getState().patchSession({ draft: 'one!' });
    await commitEdit();
    expect(apply).toHaveBeenCalledOnce();
    expect(apply).toHaveBeenCalledWith(1, {
      type: 'editTextLine',
      pageId: 7,
      key: { rev: 0, line: 0 },
      text: 'one!',
      fit: 'keepStart',
      scope: 'line',
    });
    expect(useTextEdit.getState().session).toBeNull();
  });
  it('sends nothing for an unchanged draft', async () => {
    await openEdit({ docId: 1, pageId: 0, line: line(0, 'one') });
    await commitEdit();
    expect(apply).not.toHaveBeenCalled();
    expect(useTextEdit.getState().session).toBeNull();
  });
  it('names the inserted characters when the font falls back', async () => {
    apply.mockResolvedValue({
      rev: 1,
      warnings: ['fontFallback'],
      upserted: [],
      removed: [],
      pages: null,
      history: {},
    });
    await openEdit({ docId: 1, pageId: 0, line: line(0, 'ab') });
    useTextEdit.getState().patchSession({ draft: 'ab€€' });
    await commitEdit();
    expect(useTextEdit.getState().notice).toMatchObject({ kind: 'missingGlyphs', chars: ['€'] });
  });
  it('keeps the text editable after an error, and retry sends it again', async () => {
    apply.mockRejectedValueOnce(new Error('no'));
    await openEdit({ docId: 1, pageId: 0, line: line(0, 'one') });
    useTextEdit.getState().patchSession({ draft: 'uno' });
    await commitEdit();
    expect(useTextEdit.getState().session).toMatchObject({ status: 'error', draft: 'uno' });
    await retryEdit();
    expect(apply).toHaveBeenCalledTimes(2);
    expect(useTextEdit.getState().session).toBeNull();
  });
});

describe('cancelEdit', () => {
  it('discards the draft without a command', async () => {
    await openEdit({ docId: 1, pageId: 0, line: line(0, 'one') });
    useTextEdit.getState().patchSession({ draft: 'x' });
    cancelEdit();
    expect(useTextEdit.getState().session).toBeNull();
    expect(apply).not.toHaveBeenCalled();
  });
});

describe('stepEdit', () => {
  it('commits and opens the next editable line, skipping refused ones', async () => {
    await openEdit({ docId: 1, pageId: 0, line: line(0, 'one') });
    useTextEdit.getState().patchSession({ draft: 'ONE' });
    await stepEdit(1);
    expect(apply).toHaveBeenCalledOnce();
    expect(useTextEdit.getState().session?.line.key.line).toBe(1);
    await stepEdit(1);
    // line 2 is refused and there is no further page: the line stays open
    expect(useTextEdit.getState().session?.line.key.line).toBe(1);
  });
  it('goes back with -1', async () => {
    await openEdit({ docId: 1, pageId: 0, line: line(1, 'two') });
    await stepEdit(-1);
    expect(useTextEdit.getState().session?.line.key.line).toBe(0);
  });
});

describe('Umbrechen', () => {
  it('applies with scope paragraph when reflow is on', async () => {
    useTextEdit.getState().set({ reflow: true });
    await openEdit({ docId: 1, pageId: 0, line: line(0, 'one') });
    useTextEdit.getState().patchSession({ draft: 'one!' });
    await commitEdit();
    expect(apply).toHaveBeenCalledWith(1, expect.objectContaining({ scope: 'paragraph' }));
    useTextEdit.getState().set({ reflow: false });
  });

  it('Up and Down commit and open the neighbour in the same paragraph', async () => {
    const lines = [line(0, 'a', { paragraph: 5 }), line(1, 'b', { paragraph: 5 }), line(2, 'c', { paragraph: 6 })];
    api.textEditLines.mockResolvedValue({ lines });
    await loadLines(1, 0);
    await openEdit({ docId: 1, pageId: 0, line: lines[0] as TextLineInfo });
    expect(canStepParagraph(-1)).toBe(false);
    expect(canStepParagraph(1)).toBe(true);
    useTextEdit.getState().patchSession({ draft: 'a!' });
    expect(await stepParagraph(1)).toBe(true);
    expect(apply).toHaveBeenCalledOnce();
    expect(useTextEdit.getState().session?.line.text).toBe('b');
    expect(canStepParagraph(1)).toBe(false);
  });
});
