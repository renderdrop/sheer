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
  it('puts the overflow on the redaction hatch and a capped marker at the limit', () => {
    const width = vi.spyOn(HTMLElement.prototype, 'offsetWidth', 'get').mockReturnValue(200);
    const { container } = mount({ overflowPt: 10 });
    width.mockRestore();
    const hatch = container.querySelector<HTMLElement>('[data-textedit-hatch]');
    expect(hatch?.style.background).toBe('var(--color-doc-redact-fill)');
    const marker = container.querySelector<HTMLElement>('[data-textedit-limit]');
    expect(marker?.style.height).not.toBe('');
    expect(marker?.querySelectorAll('[data-textedit-limit-cap]')).toHaveLength(2);
  });
  it('keeps the alignment anchor of the line while the text grows', () => {
    const right = { ...line, align: 'right' } as TextLineInfo;
    useTextEdit.setState({ session: { ...session, line: right } });
    render(<EditBox session={{ ...session, line: right }} growth={growthOf([right], right, 200)} pageWidth={200} />);
    const box = screen.getByTestId('textedit-box');
    expect(box.getAttribute('data-align')).toBe('right');
    expect(box.style.transform).toBe('translateX(-100%)');
    expect(box.style.left).toBe('60px');
  });
  it('underlines substitute text with the dotted mark', () => {
    mount({ fallback: { face: 'serif', chars: ['H', 'e'] } });
    const box = screen.getByTestId('textedit-box');
    expect(box.style.textDecorationStyle).toBe('dotted');
    expect(box.style.textUnderlineOffset).toBe('var(--focus-offset)');
  });
  it('marks single characters through the highlight API when there is one', () => {
    const set = vi.fn();
    const g = globalThis as unknown as Record<string, unknown>;
    g.CSS = { highlights: { set, delete: vi.fn() } };
    g.Highlight = class {};
    try {
      mount({ fallback: { face: 'serif', chars: ['H'] } });
      expect(set).toHaveBeenCalledWith('sheer-fallback', expect.anything());
      expect(screen.getByTestId('textedit-box').style.textDecorationStyle).toBe('');
    } finally {
      delete g.CSS;
      delete g.Highlight;
    }
  });
  it('marks an error with aria-invalid', () => {
    mount({ status: 'error' });
    expect(screen.getByTestId('textedit-box').getAttribute('aria-invalid')).toBe('true');
  });
});
