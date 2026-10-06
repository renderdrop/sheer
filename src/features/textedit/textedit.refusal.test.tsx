// @vitest-environment jsdom
import { act, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { TextEditRefusal, TextLineInfo } from '../../api/textEdit';
import { announcementsFor, freshMemory, type Snapshot } from './announce';
import { refusalKey } from './refusalKey';
import { RefusalTip } from './RefusalTip';
import { TextEditAnnouncer } from './TextEditAnnouncer';
import { useTextEdit, type EditSession, type Refusal } from './store';

const RECT = { x: 100, y: 200, w: 120, h: 16 };

const line = (n: number): TextLineInfo => ({
  key: { rev: 1, line: n },
  text: 'Hello',
  box: { x: 0, y: 0, w: 10, h: 10 },
  paragraph: 0,
  justified: false,
  font: { name: 'Arial', size: 12, embedded: true },
  editable: { type: 'same' },
});

const session = (patch: Partial<EditSession> = {}): EditSession => ({
  docId: 1,
  pageId: 1,
  pageNumber: 1,
  line: line(0),
  draft: 'Hello',
  status: 'editing',
  overflowPt: 0,
  fallback: null,
  ...patch,
});

describe('refusalKey', () => {
  const all: TextEditRefusal[] = [
    'signed',
    'permission',
    'type3',
    'invisible',
    'clip',
    'vertical',
    'cmap',
    'inForm',
    'actualText',
    'script',
    'notFileSource',
    'unmapped',
    'tooComplex',
  ];
  it('maps every reason and noText to a key', () => {
    for (const reason of [...all, 'noText' as const]) expect(refusalKey(reason)).toMatch(/^[a-zA-Z0-9.]+$/);
  });
  it('uses the keys of the spec', () => {
    expect(refusalKey('invisible')).toBe('editText.refuse.ocr');
    expect(refusalKey('vertical')).toBe('editText.refuse.rotated');
    expect(refusalKey('cmap')).toBe('editText.refuse.encoding');
    expect(refusalKey('unmapped')).toBe('editText.refuse.encoding');
    expect(refusalKey('signed')).toBe('cert.locked.tool');
    expect(refusalKey('permission')).toBe('tool.readOnly');
    expect(refusalKey('noText')).toBe('editText.noText');
  });
});

describe('announcementsFor', () => {
  const none: Snapshot = { session: null, refusal: null };
  it('says start, then cancelled or committed', () => {
    const memory = freshMemory();
    const open: Snapshot = { session: session(), refusal: null };
    expect(announcementsFor(none, open, memory).map((a) => a.key)).toEqual(['editText.announce.start']);
    expect(announcementsFor(open, none, memory).map((a) => a.key)).toEqual(['editText.announce.cancelled']);
    const busy: Snapshot = { session: session({ status: 'busy' }), refusal: null };
    expect(announcementsFor(busy, none, memory).map((a) => a.key)).toEqual(['editText.announce.committed']);
  });
  it('says the substitute with its count and the overflow once', () => {
    const memory = freshMemory();
    const open: Snapshot = { session: session(), refusal: null };
    announcementsFor(none, open, memory);
    const over: Snapshot = {
      session: session({ overflowPt: 3.2, fallback: { face: 'sans', chars: ['a', 'b'] } }),
      refusal: null,
    };
    const first = announcementsFor(open, over, memory);
    expect(first.map((a) => a.key)).toEqual(['editText.announce.fallback', 'editText.overflow']);
    expect(first[0]?.params).toEqual({ n: 2 });
    expect(first[1]?.params).toEqual({ n: 4 });
    const again: Snapshot = {
      session: session({ overflowPt: 5, fallback: { face: 'sans', chars: ['a', 'b'] } }),
      refusal: null,
    };
    expect(announcementsFor(over, again, memory)).toEqual([]);
  });
  it('says an error assertively, once', () => {
    const memory = freshMemory();
    const open: Snapshot = { session: session(), refusal: null };
    announcementsFor(none, open, memory);
    const failed: Snapshot = { session: session({ status: 'error' }), refusal: null };
    expect(announcementsFor(open, failed, memory)).toEqual([{ key: 'editText.error', level: 'assertive' }]);
    expect(
      announcementsFor(failed, { session: session({ status: 'error', draft: 'x' }), refusal: null }, memory),
    ).toEqual([]);
  });
  it('says a clicked refusal, not a hovered one', () => {
    const memory = freshMemory();
    const hover: Refusal = { reason: 'type3', rect: RECT, via: 'hover' };
    const click: Refusal = { ...hover, via: 'click' };
    expect(announcementsFor(none, { session: null, refusal: hover }, memory)).toEqual([]);
    expect(announcementsFor(none, { session: null, refusal: click }, memory)).toEqual([
      { key: 'editText.refuse.type3', level: 'polite' },
    ]);
  });
});

describe('RefusalTip and TextEditAnnouncer', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    useTextEdit.getState().reset();
  });
  afterEach(() => {
    useTextEdit.getState().reset();
    vi.useRealTimers();
  });

  it('shows a hover refusal after the delay and a click at once', () => {
    render(<RefusalTip />);
    act(() => useTextEdit.getState().set({ refusal: { reason: 'invisible', rect: RECT, via: 'hover' } }));
    expect(document.querySelector('[data-surface="textedit-refusal"]')).toBeNull();
    act(() => void vi.advanceTimersByTime(1000));
    expect(document.querySelector('[data-surface="textedit-refusal"]')?.textContent).toContain('scan');
    act(() => useTextEdit.getState().set({ refusal: null }));
    act(() => void vi.advanceTimersByTime(1000));
    act(() => useTextEdit.getState().set({ refusal: { reason: 'type3', rect: RECT, via: 'click' } }));
    expect(document.querySelector('[data-surface="textedit-refusal"]')?.textContent).toContain('drawn font');
  });

  it('announces a clicked refusal and the start of an edit', () => {
    render(<TextEditAnnouncer />);
    expect(screen.getByTestId('textedit-live').textContent).toBe('');
    act(() => useTextEdit.getState().set({ session: session() }));
    expect(screen.getByTestId('textedit-live').textContent).toContain('Editing');
    act(() => useTextEdit.getState().patchSession({ status: 'error' }));
    expect(screen.getByTestId('textedit-alert').textContent).toContain('Couldn');
  });
});
