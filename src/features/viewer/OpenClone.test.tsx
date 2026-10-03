// @vitest-environment jsdom
import { render } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { CLONE_WAIT_MS, OpenClone } from './OpenClone';
import type { OpenSource } from './openTransition';

const SOURCE: OpenSource = { kind: 'card', rect: { left: 0, top: 0, width: 160, height: 208 } };
const TARGET = { left: 100, top: 50, width: 400, height: 500 };

afterEach(() => vi.useRealTimers());

describe('the open clone', () => {
  it('is given up CLONE_WAIT_MS after its target arrived, not after it mounted', () => {
    vi.useFakeTimers();
    const done = vi.fn();
    const view = render(<OpenClone source={SOURCE} target={null} onDone={done} />);
    vi.advanceTimersByTime(CLONE_WAIT_MS - 100);
    view.rerender(<OpenClone source={SOURCE} target={TARGET} onDone={done} />);
    vi.advanceTimersByTime(CLONE_WAIT_MS - 100);
    expect(done).not.toHaveBeenCalled();
  });

  it('removes itself from the document when it unmounts and no longer reports', () => {
    vi.useFakeTimers();
    const done = vi.fn();
    const view = render(<OpenClone source={SOURCE} target={null} onDone={done} />);
    expect(document.querySelector('[data-open-clone]')).not.toBeNull();
    view.unmount();
    expect(document.querySelector('[data-open-clone]')).toBeNull();
    vi.advanceTimersByTime(CLONE_WAIT_MS * 2);
    expect(done).not.toHaveBeenCalled();
  });
});
