// @vitest-environment jsdom
import { act, fireEvent, render } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { openTooltip } from '../test/render';
import { Tooltip } from './Tooltip';

/** Fake clock for timers and Date only: animation frames stay real so exit animations can finish. */
let run = 0;
beforeEach(() => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
  // Tooltips share "when did the last one close"; every test starts far from the previous one.
  run += 1;
  vi.setSystemTime(new Date(2_000_000_000_000 + run * 1_000_000));
});
afterEach(() => {
  vi.useRealTimers();
});

const advance = (ms: number) =>
  act(() => {
    vi.advanceTimersByTime(ms);
  });
const gone = () => vi.waitFor(() => expect(openTooltip()).toBeNull());

function Anchor({ onClick }: { onClick?: () => void }) {
  return (
    <Tooltip label="Highlight" shortcut="H">
      <button type="button" onClick={onClick}>
        Anchor
      </button>
    </Tooltip>
  );
}

describe('Tooltip opening', () => {
  it('opens after 400 ms of hover, as role=tooltip hidden from the accessibility tree', () => {
    const { getByRole } = render(<Anchor />);
    fireEvent.pointerEnter(getByRole('button'));
    advance(399);
    expect(openTooltip()).toBeNull();
    advance(1);
    const tooltip = openTooltip();
    expect(tooltip).not.toBeNull();
    expect(tooltip?.getAttribute('aria-hidden')).toBe('true');
    expect(tooltip?.textContent).toContain('Highlight');
    expect(tooltip?.querySelector('kbd')?.textContent).toBe('H');
  });

  it('opens after 400 ms on keyboard focus', () => {
    const { getByRole } = render(<Anchor />);
    act(() => getByRole('button').focus());
    advance(399);
    expect(openTooltip()).toBeNull();
    advance(1);
    expect(openTooltip()).not.toBeNull();
  });

  it('does not open when the pointer leaves before the delay', () => {
    const { getByRole } = render(<Anchor />);
    fireEvent.pointerEnter(getByRole('button'));
    advance(300);
    fireEvent.pointerLeave(getByRole('button'));
    advance(1000);
    expect(openTooltip()).toBeNull();
  });

  it('opens at once when a neighbour in the same toolbar is open or closed less than 300 ms ago', async () => {
    const { getAllByRole } = render(
      <div role="toolbar" aria-label="Group">
        <Tooltip label="First">
          <button type="button">A</button>
        </Tooltip>
        <Tooltip label="Second">
          <button type="button">B</button>
        </Tooltip>
      </div>,
    );
    const [first, second] = getAllByRole('button');
    if (first === undefined || second === undefined) throw new Error('buttons missing');

    fireEvent.pointerEnter(first);
    advance(400);
    fireEvent.pointerLeave(first);
    advance(50); // first is still in its grace period
    fireEvent.pointerEnter(second);
    // The first one closes (its exit animation may still be running) and the second is there without a delay.
    await vi.waitFor(() => expect(document.querySelectorAll('[role="tooltip"]')).toHaveLength(1));
    expect(openTooltip()?.textContent).toContain('Second');

    // Closed 100 ms ago: still warm.
    fireEvent.pointerLeave(second);
    advance(100);
    await gone();
    advance(100);
    fireEvent.pointerEnter(first);
    expect(openTooltip()?.textContent).toContain('First');

    // Closed 400 ms ago: cold again.
    fireEvent.pointerLeave(first);
    advance(100);
    await gone();
    advance(400);
    fireEvent.pointerEnter(second);
    expect(openTooltip()).toBeNull();
    advance(400);
    expect(openTooltip()).not.toBeNull();
  });

  it('never opens for touch or when disabled', () => {
    const { getByRole, rerender } = render(<Anchor />);
    fireEvent.pointerEnter(getByRole('button'), { pointerType: 'touch' });
    advance(1000);
    expect(openTooltip()).toBeNull();

    rerender(
      <Tooltip label="Off" disabled>
        <button type="button">Anchor</button>
      </Tooltip>,
    );
    fireEvent.pointerEnter(getByRole('button'));
    advance(1000);
    expect(openTooltip()).toBeNull();
  });
});

describe('Tooltip closing', () => {
  it('hides 100 ms after the pointer leaves the anchor', async () => {
    const { getByRole } = render(<Anchor />);
    fireEvent.pointerEnter(getByRole('button'));
    advance(400);
    fireEvent.pointerLeave(getByRole('button'));
    advance(99);
    expect(openTooltip()).not.toBeNull();
    advance(1);
    await gone();
  });

  it('stays while the pointer is on the tooltip itself (hoverable) and hides when it leaves', async () => {
    const { getByRole } = render(<Anchor />);
    fireEvent.pointerEnter(getByRole('button'));
    advance(400);
    fireEvent.pointerLeave(getByRole('button'));
    advance(50);
    const tooltip = openTooltip();
    if (tooltip === null) throw new Error('tooltip missing');
    fireEvent.pointerEnter(tooltip);
    advance(2000);
    expect(openTooltip()).not.toBeNull();
    fireEvent.pointerLeave(tooltip);
    advance(100);
    await gone();
  });

  it('hides on blur', async () => {
    const { getByRole } = render(<Anchor />);
    act(() => getByRole('button').focus());
    advance(400);
    expect(openTooltip()).not.toBeNull();
    act(() => getByRole('button').blur());
    await gone();
  });

  it('hides on click and still runs the anchor handler', async () => {
    const onClick = vi.fn();
    const { getByRole } = render(<Anchor onClick={onClick} />);
    fireEvent.pointerEnter(getByRole('button'));
    advance(400);
    fireEvent.pointerDown(getByRole('button'));
    fireEvent.click(getByRole('button'));
    expect(onClick).toHaveBeenCalledTimes(1);
    await gone();
  });

  it('hides on Esc, and Esc is not passed on while a tooltip is shown', async () => {
    const seen = vi.fn();
    document.addEventListener('keydown', seen);
    const { getByRole } = render(<Anchor />);
    fireEvent.pointerEnter(getByRole('button'));
    advance(400);
    fireEvent.keyDown(getByRole('button'), { key: 'Escape' });
    expect(seen).not.toHaveBeenCalled();
    await gone();

    // With nothing shown, Esc reaches everyone else (the popover, the tool, the selection).
    fireEvent.keyDown(getByRole('button'), { key: 'Escape' });
    expect(seen).toHaveBeenCalledTimes(1);
    document.removeEventListener('keydown', seen);
  });

  it('does not reopen after Esc while the pointer rests on the anchor', async () => {
    const { getByRole } = render(<Anchor />);
    fireEvent.pointerEnter(getByRole('button'));
    advance(400);
    fireEvent.keyDown(document.body, { key: 'Escape' });
    await gone();
    advance(2000);
    expect(openTooltip()).toBeNull();
  });
});

describe('Tooltip groups and lingering (MOTION spell 16)', () => {
  const two = (
    <div role="toolbar" aria-label="Tools">
      <Tooltip label="First">
        <button type="button">A</button>
      </Tooltip>
      <Tooltip label="Second">
        <button type="button">B</button>
      </Tooltip>
    </div>
  );

  it('shows the neighbour at once while one is open, with the first one gone and one tooltip only', async () => {
    const { getAllByRole } = render(two);
    const [first, second] = getAllByRole('button');
    if (first === undefined || second === undefined) throw new Error('buttons missing');
    fireEvent.pointerEnter(first);
    advance(400);
    expect(openTooltip()?.textContent).toContain('First');
    fireEvent.pointerLeave(first);
    fireEvent.pointerEnter(second);
    await vi.waitFor(() => expect(document.querySelectorAll('[role="tooltip"]')).toHaveLength(1));
    expect(openTooltip()?.textContent).toContain('Second');
  });

  it('keeps the full delay across groups', () => {
    const { getAllByRole } = render(
      <>
        <div role="toolbar" aria-label="One">
          <Tooltip label="First">
            <button type="button">A</button>
          </Tooltip>
        </div>
        <div role="toolbar" aria-label="Two">
          <Tooltip label="Second">
            <button type="button">B</button>
          </Tooltip>
        </div>
      </>,
    );
    const [first, second] = getAllByRole('button');
    if (first === undefined || second === undefined) throw new Error('buttons missing');
    fireEvent.pointerEnter(first);
    advance(400);
    fireEvent.pointerLeave(first);
    fireEvent.pointerEnter(second);
    advance(399);
    expect(document.querySelector('[role="tooltip"]')?.textContent ?? '').not.toContain('Second');
    advance(1);
    expect(document.body.textContent).toContain('Second');
  });

  it('hides when the pointer is elsewhere without a leave event on the anchor (no lingering)', async () => {
    const { getAllByRole } = render(two);
    const [first] = getAllByRole('button');
    if (first === undefined) throw new Error('button missing');
    fireEvent.pointerEnter(first);
    advance(400);
    expect(openTooltip()).not.toBeNull();
    fireEvent.pointerMove(document.body);
    advance(99);
    expect(openTooltip()).not.toBeNull();
    advance(1);
    await gone();
  });

  it('hides when the window loses focus', async () => {
    const { getAllByRole } = render(two);
    const [first] = getAllByRole('button');
    if (first === undefined) throw new Error('button missing');
    fireEvent.pointerEnter(first);
    advance(400);
    fireEvent.blur(window);
    await gone();
  });

  it('keeps the same delays under reduced motion (it only fades)', () => {
    const original = window.matchMedia;
    window.matchMedia = (query: string) =>
      ({
        matches: query.includes('prefers-reduced-motion'),
        media: query,
        addEventListener: () => undefined,
        removeEventListener: () => undefined,
        addListener: () => undefined,
        removeListener: () => undefined,
      }) as unknown as MediaQueryList;
    try {
      const { getByRole } = render(<Anchor />);
      fireEvent.pointerEnter(getByRole('button'));
      advance(399);
      expect(openTooltip()).toBeNull();
      advance(1);
      expect(openTooltip()).not.toBeNull();
    } finally {
      window.matchMedia = original;
    }
  });
});
