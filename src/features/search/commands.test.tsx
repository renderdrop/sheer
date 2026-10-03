// @vitest-environment jsdom
import { fireEvent, render } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { useSettings } from '../../stores/settings';
import { FIND_KEYS_ATTRIBUTE, f3FindsNext, useFindKeys } from './commands';

const jump = vi.hoisted(() => ({ stepHit: vi.fn() }));
vi.mock('./jump', () => jump);

function Host() {
  useFindKeys();
  return (
    <div>
      <input aria-label="plain" />
      <input aria-label="page" {...{ [FIND_KEYS_ATTRIBUTE]: '' }} />
    </div>
  );
}

beforeEach(() => {
  jump.stepHit.mockReset();
  useSettings.setState({ platform: 'windows' });
});
afterEach(() => {
  useSettings.setState({ platform: null });
});

describe('F3 and Shift+F3 (DESIGN 3.16)', () => {
  it('step through the hits on Windows, from anywhere that is not a text field', () => {
    render(<Host />);
    fireEvent.keyDown(document.body, { key: 'F3' });
    fireEvent.keyDown(document.body, { key: 'F3', shiftKey: true });
    expect(jump.stepHit.mock.calls).toEqual([[1], [-1]]);
  });

  it('do nothing on macOS, which has primary+G', () => {
    useSettings.setState({ platform: 'macos' });
    expect(f3FindsNext()).toBe(false);
    render(<Host />);
    fireEvent.keyDown(document.body, { key: 'F3' });
    expect(jump.stepHit).not.toHaveBeenCalled();
  });

  it('work from the page field of the status bar, and not from other text fields', () => {
    const { getByLabelText } = render(<Host />);
    fireEvent.keyDown(getByLabelText('plain'), { key: 'F3' });
    expect(jump.stepHit).not.toHaveBeenCalled();
    fireEvent.keyDown(getByLabelText('page'), { key: 'F3', shiftKey: true });
    expect(jump.stepHit).toHaveBeenCalledWith(-1);
  });

  it('leave a modal dialog its keyboard', () => {
    render(
      <>
        <Host />
        <div aria-modal="true" />
      </>,
    );
    fireEvent.keyDown(document.body, { key: 'F3' });
    expect(jump.stepHit).not.toHaveBeenCalled();
  });
});
