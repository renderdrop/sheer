import { describe, expect, it } from 'vitest';

import { editKeyOf, isFocused, type KeyLike } from './keyboard';

const key = (k: string, patch: Partial<KeyLike> = {}): KeyLike => ({
  key: k,
  shiftKey: false,
  ctrlKey: false,
  metaKey: false,
  altKey: false,
  ...patch,
});

describe('editKeyOf', () => {
  it('maps the commit, cancel and navigation keys', () => {
    expect(editKeyOf(key('Enter'))).toBe('commit');
    expect(editKeyOf(key('Escape'))).toBe('cancel');
    expect(editKeyOf(key('Tab'))).toBe('next');
    expect(editKeyOf(key('Tab', { shiftKey: true }))).toBe('previous');
  });
  it('ignores Shift+Enter (no new paragraphs)', () => {
    expect(editKeyOf(key('Enter', { shiftKey: true }))).toBe('ignore');
  });
  it('keeps undo and redo in the box', () => {
    expect(editKeyOf(key('z', { ctrlKey: true }))).toBe('undoTyping');
    expect(editKeyOf(key('Z', { metaKey: true, shiftKey: true }))).toBe('undoTyping');
    expect(editKeyOf(key('y', { ctrlKey: true }))).toBe('undoTyping');
  });
  it('commits before saving', () => {
    expect(editKeyOf(key('s', { ctrlKey: true }))).toBe('save');
  });
  it('leaves typing, arrows and selection to the browser', () => {
    expect(editKeyOf(key('a'))).toBeNull();
    expect(editKeyOf(key('ArrowLeft', { shiftKey: true }))).toBeNull();
    expect(editKeyOf(key('a', { ctrlKey: true }))).toBeNull();
    expect(editKeyOf(key('1'))).toBeNull();
  });
  it('is not ours during composition', () => {
    expect(editKeyOf(key('Enter', { isComposing: true }))).toBeNull();
    expect(editKeyOf(key('Enter', { keyCode: 229 }))).toBeNull();
  });
});

describe('isFocused', () => {
  it('matches document, page and key', () => {
    const focus = { docId: 1, pageId: 2, key: { rev: 0, line: 3 } };
    expect(isFocused(focus, 1, 2, { rev: 0, line: 3 })).toBe(true);
    expect(isFocused(focus, 1, 2, { rev: 0, line: 4 })).toBe(false);
    expect(isFocused(null, 1, 2, { rev: 0, line: 3 })).toBe(false);
  });
});
