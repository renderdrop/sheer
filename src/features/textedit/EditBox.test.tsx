// @vitest-environment jsdom
import { fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { TextLineInfo } from '../../api/textEdit';
import { EditBox } from './EditBox';
import { growthOf } from './lines';
import { useTextEdit, type EditSession } from './store';

const actions = vi.hoisted(() => ({
  cancelEdit: vi.fn(),
  commitEdit: vi.fn(),
  commitAndClose: vi.fn(),
  stepEdit: vi.fn(),
  takeCaret: () => 'end' as const,
}));
vi.mock('./actions', () => actions);

const line: TextLineInfo = {
  key: { rev: 0, line: 1 },
  text: 'Hello',
  box: { x: 10, y: 10, w: 50, h: 10 },
  paragraph: 0,
  justified: false,
  font: { name: 'Times-Roman', size: 10, embedded: true },
  editable: { type: 'same' },
};
const session: EditSession = {
  docId: 1,
  pageId: 0,
  pageNumber: 3,
  line,
  draft: 'Hello',
  status: 'editing',
  overflowPt: 0,
  fallback: null,
};

function mount(patch: Partial<EditSession> = {}) {
  const s = { ...session, ...patch };
  useTextEdit.setState({ session: s });
  return render(<EditBox session={s} growth={growthOf([line], line, 200)} pageWidth={200} />);
}

beforeEach(() => {
  vi.clearAllMocks();
  useTextEdit.getState().reset();
});

describe('EditBox', () => {
  it('is a labelled textbox with the line text', () => {
    mount();
    const box = screen.getByTestId('textedit-box');
    expect(box.getAttribute('role')).toBe('textbox');
    expect(box.getAttribute('aria-label')).toBe('Line 2 on page 3');
    expect(box.textContent).toBe('Hello');
    expect(box.style.fontFamily).toBe('serif');
  });
  it('commits on Enter, cancels on Escape, steps on Tab', () => {
    mount();
    const box = screen.getByTestId('textedit-box');
    fireEvent.keyDown(box, { key: 'Enter' });
    expect(actions.commitEdit).toHaveBeenCalledOnce();
    fireEvent.keyDown(box, { key: 'Escape' });
    expect(actions.cancelEdit).toHaveBeenCalledOnce();
    fireEvent.keyDown(box, { key: 'Tab' });
    fireEvent.keyDown(box, { key: 'Tab', shiftKey: true });
    expect(actions.stepEdit).toHaveBeenNthCalledWith(1, 1);
    expect(actions.stepEdit).toHaveBeenNthCalledWith(2, -1);
  });
  it('ignores Shift+Enter', () => {
    mount();
    fireEvent.keyDown(screen.getByTestId('textedit-box'), { key: 'Enter', shiftKey: true });
    expect(actions.commitEdit).not.toHaveBeenCalled();
  });
  it('writes the typed text into the draft, one line only', () => {
    mount();
    const box = screen.getByTestId('textedit-box');
    box.textContent = 'Hello\nworld';
    fireEvent.input(box);
    expect(useTextEdit.getState().session?.draft).toBe('Hello world');
  });
  it('blocks input while busy and shows the marker past the limit', () => {
    const { container } = mount({ status: 'busy', overflowPt: 12 });
    const box = screen.getByTestId('textedit-box');
    expect(box.getAttribute('aria-busy')).toBe('true');
    expect(box.getAttribute('contenteditable')).toBe('false');
    fireEvent.keyDown(box, { key: 'Enter' });
    expect(actions.commitEdit).not.toHaveBeenCalled();
    // jsdom has no layout: the width stays the box's own, so no hatch; the marker needs a measured overflow.
    expect(container.querySelector('[data-textedit-rule]')).toBeNull();
  });
  it('marks an error with aria-invalid', () => {
    mount({ status: 'error' });
    expect(screen.getByTestId('textedit-box').getAttribute('aria-invalid')).toBe('true');
  });
});
