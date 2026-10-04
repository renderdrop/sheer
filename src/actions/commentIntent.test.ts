// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';

import { hasTextSelection, onAddComment, requestAddComment } from './commentIntent';

afterEach(() => {
  window.getSelection()?.removeAllRanges();
  document.body.replaceChildren();
});

describe('the add-comment intent', () => {
  it('reaches every listener and stops after unsubscribe', () => {
    const a = vi.fn();
    const b = vi.fn();
    const offA = onAddComment(a);
    const offB = onAddComment(b);
    requestAddComment();
    expect([a.mock.calls.length, b.mock.calls.length]).toEqual([1, 1]);
    offA();
    requestAddComment();
    expect([a.mock.calls.length, b.mock.calls.length]).toEqual([1, 2]);
    offB();
  });

  it('does nothing without a listener', () => {
    expect(() => requestAddComment()).not.toThrow();
  });

  it('sees a text selection only when it holds text', () => {
    for (const [id, text] of [
      ['p', 'Hello world'],
      ['q', '   '],
    ] as const) {
      const el = document.createElement('p');
      el.id = id;
      el.textContent = text;
      document.body.append(el);
    }
    expect(hasTextSelection()).toBe(false);
    const select = (id: string) => {
      const range = document.createRange();
      range.selectNodeContents(document.getElementById(id) as Element);
      window.getSelection()?.removeAllRanges();
      window.getSelection()?.addRange(range);
    };
    select('p');
    expect(hasTextSelection()).toBe(true);
    select('q');
    expect(hasTextSelection()).toBe(false);
  });
});
