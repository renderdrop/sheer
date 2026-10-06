// @vitest-environment jsdom
import { beforeEach, describe, expect, it } from 'vitest';

import { useDocuments } from '../../stores/documents';
import { resetDocuments } from '../../stores/documents.testutil';
import { useUi } from '../../stores/ui';
import { historyButton, historyKey } from './keys';

const press = (init: KeyboardEventInit, target?: Element): KeyboardEvent => {
  const event = new KeyboardEvent('keydown', { bubbles: true, cancelable: true, ...init });
  if (target !== undefined) Object.defineProperty(event, 'target', { value: target });
  return event;
};

beforeEach(() => {
  resetDocuments();
  useDocuments.getState().add({ id: 1, pageCount: 3, displayName: 'a.pdf' });
  useUi.setState({ mode: 'read' });
});

describe('history keys', () => {
  it('Alt+Left and Alt+Right on Windows', () => {
    expect(historyKey(press({ key: 'ArrowLeft', code: 'ArrowLeft', altKey: true }), 'windows')).toBe('back');
    expect(historyKey(press({ key: 'ArrowRight', code: 'ArrowRight', altKey: true }), 'windows')).toBe('forward');
    expect(historyKey(press({ key: 'ArrowLeft', code: 'ArrowLeft' }), 'windows')).toBeNull();
    expect(
      historyKey(press({ key: 'ArrowLeft', code: 'ArrowLeft', altKey: true, shiftKey: true }), 'windows'),
    ).toBeNull();
  });

  it('Cmd+[ and Cmd+] on macOS, not with Shift (tab keys)', () => {
    expect(historyKey(press({ key: '[', code: 'BracketLeft', metaKey: true }), 'macos')).toBe('back');
    expect(historyKey(press({ key: ']', code: 'BracketRight', metaKey: true }), 'macos')).toBe('forward');
    expect(historyKey(press({ key: '{', code: 'BracketLeft', metaKey: true, shiftKey: true }), 'macos')).toBeNull();
    expect(historyKey(press({ key: 'ArrowLeft', code: 'ArrowLeft', altKey: true }), 'macos')).toBeNull();
  });

  it('leaves inputs, crop handles and the organize grid their own Alt+arrows', () => {
    const left = { key: 'ArrowLeft', code: 'ArrowLeft', altKey: true };
    const input = document.createElement('input');
    const handle = document.createElement('div');
    handle.setAttribute('data-crop-rect', '');
    expect(historyKey(press(left, input), 'windows')).toBeNull();
    expect(historyKey(press(left, handle), 'windows')).toBeNull();
    useUi.setState({ mode: 'pages' });
    expect(historyKey(press(left), 'windows')).toBeNull();
  });

  it('does nothing without a document or on a handled event', () => {
    const left = { key: 'ArrowLeft', code: 'ArrowLeft', altKey: true };
    const handled = press(left);
    handled.preventDefault();
    expect(historyKey(handled, 'windows')).toBeNull();
    resetDocuments();
    expect(historyKey(press(left), 'windows')).toBeNull();
  });

  it('mouse buttons 4 and 5', () => {
    expect(historyButton({ button: 3, target: document.body })).toBe('back');
    expect(historyButton({ button: 4, target: document.body })).toBe('forward');
    expect(historyButton({ button: 0, target: document.body })).toBeNull();
  });
});
