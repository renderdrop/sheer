// @vitest-environment jsdom
import { act, render } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { ChangeSet } from '../../api/annotations';
import { resetNotices, useNotices } from '../../components/notices';
import { useDocuments } from '../../stores/documents';
import { emitUndoCue } from '../../stores/undoCue';
import { useUi } from '../../stores/ui';
import { clearNotice, useNoticeLifetime } from './noticeLifetime';
import { boxAnchor } from './model';
import { useTextEdit } from './store';

vi.mock('../../components/useFloatingPosition', () => ({
  useFloatingPosition: ({ onNoFit }: { onNoFit?: () => void }) => {
    (globalThis as { __noFit?: () => void }).__noFit = onNoFit;
  },
}));

function Probe() {
  useNoticeLifetime();
  return null;
}

const NOTICE = { kind: 'missingGlyphs', font: 'X', face: 'sans', chars: ['-'] } as const;

beforeEach(() => {
  resetNotices();
  useTextEdit.getState().reset();
  useUi.setState({ activeTool: 'editText' });
  useTextEdit.getState().set({ notice: NOTICE, noticeAnchor: { x: 1, y: 2, w: 3, h: 4 } });
});
afterEach(() => useTextEdit.getState().reset());

describe('notice lifetime', () => {
  it('clears on undo and redo', () => {
    render(<Probe />);
    expect(useTextEdit.getState().notice).not.toBeNull();
    act(() => emitUndoCue(1, 'undo', {} as ChangeSet));
    expect(useTextEdit.getState().notice).toBeNull();
    expect(useTextEdit.getState().noticeAnchor).toBeNull();
    useTextEdit.getState().set({ notice: NOTICE });
    act(() => emitUndoCue(1, 'redo', {} as ChangeSet));
    expect(useTextEdit.getState().notice).toBeNull();
  });
  it('clears when the active document changes', () => {
    useDocuments.setState({ activeId: 1 });
    render(<Probe />);
    act(() => useDocuments.setState({ activeId: 2 }));
    expect(useTextEdit.getState().notice).toBeNull();
  });
  it('clears when the Edit text tool is released, and keeps it while the tool is on', () => {
    render(<Probe />);
    expect(useTextEdit.getState().notice).not.toBeNull();
    act(() => useUi.setState({ activeTool: 'select' }));
    expect(useTextEdit.getState().notice).toBeNull();
  });
  it('clearNotice is idempotent', () => {
    clearNotice();
    clearNotice();
    expect(useTextEdit.getState().notice).toBeNull();
  });
});

describe('box anchor', () => {
  const box = { x: 100, y: 10, w: 80, h: 12 };
  it('left grows rightwards from the start', () => {
    expect(boxAnchor('left', box, null)).toMatchObject({ left: 100, transform: '', origin: 'left center' });
  });
  it('right grows leftwards from the end', () => {
    expect(boxAnchor('right', box, null)).toMatchObject({ left: 180, transform: 'translateX(-100%)' });
  });
  it('centre grows both ways from the middle', () => {
    expect(boxAnchor('center', box, null)).toMatchObject({ left: 140, transform: 'translateX(-50%)' });
  });
  it('clamps the width to the paragraph window', () => {
    const win = { left: 90, right: 200 };
    expect(boxAnchor('left', box, win).maxWidth).toBe(100);
    expect(boxAnchor('right', box, win).maxWidth).toBe(90);
    expect(boxAnchor('center', box, win).maxWidth).toBe(2 * Math.min(50, 60));
    expect(boxAnchor('left', box, { left: 100, right: 120 }).maxWidth).toBe(80);
  });
});

describe('queue slot', () => {
  it('releases the slot when the notice does not fit', async () => {
    const { FallbackNotice } = await import('./FallbackNotice');
    useTextEdit.getState().set({ session: null, notice: NOTICE, noticeAnchor: { x: 1, y: 2, w: 3, h: 4 } });
    render(<FallbackNotice />);
    expect(useNotices.getState().visible?.id).toBe('textedit-notice');
    act(() => (globalThis as { __noFit?: () => void }).__noFit?.());
    expect(useNotices.getState().visible).toBeNull();
    expect(useTextEdit.getState().notice).not.toBeNull();
  });
});
