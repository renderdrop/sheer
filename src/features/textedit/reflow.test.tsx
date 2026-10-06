// @vitest-environment jsdom
import { screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { TextLineInfo } from '../../api/textEdit';
import { setup } from '../../test/render';
import { announcementsFor, freshMemory } from './announce';
import { TextEditBar } from './TextEditBar';
import { REFLOW_KEY, setReflow, useTextEdit, type EditSession } from './store';

vi.mock('./actions', () => ({ commitEdit: vi.fn(), cancelEdit: vi.fn(), retryEdit: vi.fn() }));
const lines = vi.hoisted(() => ({ value: [] as unknown[] }));
vi.mock('./lines', async (original) => ({
  ...(await original<typeof import('./lines')>()),
  useLines: () => lines.value,
}));

const line = (n: number, paragraph: number): TextLineInfo => ({
  key: { rev: 0, line: n },
  text: 'Hello',
  box: { x: 0, y: n * 12, w: 10, h: 10 },
  paragraph,
  justified: false,
  font: { name: 'Helvetica', size: 11, embedded: true },
  editable: { type: 'same' },
});

function session(): EditSession {
  return {
    docId: 1,
    pageId: 0,
    pageNumber: 1,
    line: line(0, 0),
    draft: 'Hello',
    status: 'editing',
    overflowPt: 0,
    fallback: null,
  };
}

beforeEach(() => {
  localStorage.clear();
  useTextEdit.getState().reset();
  useTextEdit.setState({ reflow: false, session: session() });
});
afterEach(() => useTextEdit.getState().reset());

describe('Umbrechen toggle', () => {
  it('is shown for a paragraph of two lines and hidden for a single line', () => {
    lines.value = [line(0, 0), line(1, 0)];
    const { unmount } = setup(<TextEditBar />);
    expect(screen.getByRole('switch', { name: 'Wrap in paragraph' })).toBeTruthy();
    unmount();
    lines.value = [line(0, 0), line(1, 1)];
    setup(<TextEditBar />);
    expect(screen.queryByRole('switch')).toBeNull();
  });

  it('writes the store and is remembered across edits', async () => {
    lines.value = [line(0, 0), line(1, 0)];
    const { user } = setup(<TextEditBar />);
    await user.click(screen.getByRole('switch'));
    expect(useTextEdit.getState().reflow).toBe(true);
    expect(localStorage.getItem(REFLOW_KEY)).toBe('1');
    useTextEdit.getState().reset();
    expect(useTextEdit.getState().reflow).toBe(true);
    setReflow(false);
    expect(localStorage.getItem(REFLOW_KEY)).toBe('0');
  });

  it('is announced politely', () => {
    const s = session();
    const out = announcementsFor(
      { session: s, refusal: null, reflow: false },
      { session: s, refusal: null, reflow: true },
      freshMemory(),
    );
    expect(out).toEqual([{ key: 'editText.announce.reflowOn', level: 'polite' }]);
  });
});
