// @vitest-environment jsdom
import { act, fireEvent, render, screen } from '@testing-library/react';
import { MotionGlobalConfig } from 'motion/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { useUi } from '../../stores/ui';
import { SelectionBar, POINTER_SETTLE_MS } from './SelectionBar';

const mark = vi.hoisted(() => vi.fn().mockResolvedValue(true));
const comment = vi.hoisted(() => vi.fn().mockResolvedValue(undefined));
vi.mock('../annotations/create/fromSelection', () => ({ markSelection: mark }));
vi.mock('./comment', () => ({ addCommentFromSelection: comment }));
const cite = vi.hoisted(() => vi.fn().mockResolvedValue(41));
const readOnly = vi.hoisted(() => ({ on: false }));
vi.mock('../citations/store', () => ({
  createCitationFromSelection: cite,
  isReadOnlyDocument: () => readOnly.on,
}));
vi.mock('./selection', () => ({ hasTextSelection: () => true }));

MotionGlobalConfig.skipAnimations = true;

beforeEach(() => {
  vi.useFakeTimers();
  mark.mockClear();
  comment.mockClear();
  cite.mockClear();
  readOnly.on = false;
  useUi.setState({ activeTool: 'select' });
  const rect = { top: 200, bottom: 220, left: 50, right: 150, width: 100, height: 20 } as DOMRect;
  vi.spyOn(window, 'getSelection').mockReturnValue({
    rangeCount: 1,
    getRangeAt: () => ({ getClientRects: () => [rect] }),
    toString: () => 'text',
  } as unknown as Selection);
});

async function open() {
  const el = document.createElement('div');
  el.getBoundingClientRect = () => ({ top: 0, bottom: 600, left: 0, right: 800 }) as DOMRect;
  const region = { current: el };
  render(<SelectionBar docId={1} region={region} />);
  act(() => {
    document.dispatchEvent(new Event('selectionchange'));
    vi.advanceTimersByTime(POINTER_SETTLE_MS + 400);
  });
}

describe('the selection popover', () => {
  it('offers Highlight, Cite, Comment and Copy; Highlight marks the selection', async () => {
    await open();
    const bar = screen.getByRole('toolbar');
    expect([...bar.querySelectorAll('button')].map((b) => b.textContent)).toEqual([
      'Highlight',
      'Cite',
      'Comment',
      'Copy',
    ]);
    fireEvent.click(screen.getByRole('button', { name: 'Highlight' }));
    expect(mark).toHaveBeenCalledWith(1, 'highlight');
    expect(screen.queryByRole('toolbar')).toBeNull();
  });

  it('Cite makes a citation of the selection, names its shortcut, and closes the bar', async () => {
    await open();
    const button = screen.getByRole('button', { name: 'Cite' });
    expect(button.getAttribute('aria-keyshortcuts')).toBe('Control+Shift+C Meta+Shift+C');
    fireEvent.click(button);
    expect(cite).toHaveBeenCalledWith(1);
    expect(screen.queryByRole('toolbar')).toBeNull();
  });

  it('Cite is disabled on a read-only document and does nothing', async () => {
    readOnly.on = true;
    await open();
    const button = screen.getByRole('button', { name: 'Cite' });
    expect(button.getAttribute('aria-disabled')).toBe('true');
    fireEvent.click(button);
    expect(cite).not.toHaveBeenCalled();
  });

  it('Comment starts the comment flow and Esc closes the popover', async () => {
    await open();
    fireEvent.click(screen.getByRole('button', { name: 'Comment' }));
    expect(comment).toHaveBeenCalledWith(1);
    await open();
    act(() => {
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
    });
    expect(screen.queryByRole('toolbar')).toBeNull();
  });

  it('is the first Tab stop from the canvas, though it sits at the end of the body', async () => {
    await open();
    const tab = new KeyboardEvent('keydown', { key: 'Tab', bubbles: true, cancelable: true });
    act(() => {
      document.body.dispatchEvent(tab);
    });
    expect(tab.defaultPrevented).toBe(true);
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Highlight' }));
    // Inside the bar, Tab moves on by itself.
    const inside = new KeyboardEvent('keydown', { key: 'Tab', bubbles: true, cancelable: true });
    act(() => {
      document.activeElement?.dispatchEvent(inside);
    });
    expect(inside.defaultPrevented).toBe(false);
  });

  it('flips below a selection at the top of the canvas and grows from its top edge', async () => {
    const rect = { top: 10, bottom: 30, left: 50, right: 150, width: 100, height: 20 } as DOMRect;
    vi.spyOn(window, 'getSelection').mockReturnValue({
      rangeCount: 1,
      getRangeAt: () => ({ getClientRects: () => [rect] }),
      toString: () => 'text',
    } as unknown as Selection);
    await open();
    const bar = screen.getByRole('toolbar');
    expect(bar.style.transformOrigin).toBe('top left');
    // 8 below the last line (the gap is the overlay offset).
    expect(Number.parseFloat(bar.style.top)).toBeGreaterThan(30);
  });
});
