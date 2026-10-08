// @vitest-environment jsdom
import { fireEvent } from '@testing-library/react';
import { useState } from 'react';
import { describe, expect, it, vi } from 'vitest';

import { setup } from '../test/render';
import { Splitter, type SplitterProps } from './Splitter';

// The range of the v1.1 left panel: the tests pin the Splitter's own arithmetic, whatever PANEL says.
function Demo(props: Partial<SplitterProps>) {
  const [value, setValue] = useState(248);
  const [collapsed, setCollapsed] = useState(false);
  return (
    <div id="pane">
      <Splitter
        label="Resize left panel"
        controls="pane"
        value={value}
        collapsed={collapsed}
        onValueChange={setValue}
        onCollapsedChange={setCollapsed}
        min={192}
        max={400}
        defaultValue={248}
        {...props}
      />
    </div>
  );
}

const separator = () => document.querySelector<HTMLElement>('[role="separator"]') as HTMLElement;
const attr = (name: string) => separator().getAttribute(name);
const now = () => attr('aria-valuenow');

describe('Splitter semantics', () => {
  it('names the pane with aria-controls only while it is there, and keeps valid numeric values', () => {
    const { getByRole } = setup(<Demo />);
    const element = getByRole('separator', { name: 'Resize left panel' });
    expect(element.getAttribute('aria-controls')).toBe('pane');
    fireEvent.keyDown(element, { key: 'Enter' });
    expect(element.hasAttribute('aria-controls')).toBe(false);
    expect(element.getAttribute('aria-valuenow')).toBe('0');
    expect(Number(element.getAttribute('aria-valuemax'))).toBeGreaterThanOrEqual(0);
  });

  it('is a focusable vertical separator that reports its value, range and the pane it controls', () => {
    const { getByRole } = setup(<Demo />);
    const element = getByRole('separator', { name: 'Resize left panel' });
    expect(element.getAttribute('aria-orientation')).toBe('vertical');
    expect(element.getAttribute('aria-controls')).toBe('pane');
    expect(element.getAttribute('aria-valuenow')).toBe('248');
    expect(element.getAttribute('aria-valuemin')).toBe('0');
    expect(element.getAttribute('aria-valuemax')).toBe('400');
    expect(element.getAttribute('aria-valuetext')).toBe('248 pixels');
    expect(element.tabIndex).toBe(0);
  });
});

describe('Splitter keyboard', () => {
  it('resizes by 8 with the arrows and by 40 with Shift', async () => {
    const { user } = setup(<Demo />);
    separator().focus();
    await user.keyboard('{ArrowRight}');
    expect(now()).toBe('256');
    await user.keyboard('{ArrowLeft}{ArrowLeft}');
    expect(now()).toBe('240');
    await user.keyboard('{Shift>}{ArrowRight}{/Shift}');
    expect(now()).toBe('280');
    await user.keyboard('{Shift>}{ArrowLeft}{/Shift}');
    expect(now()).toBe('240');
  });

  it('stops at the ends of the range and jumps there with Home and End', async () => {
    const { user } = setup(<Demo />);
    separator().focus();
    await user.keyboard('{End}');
    expect(now()).toBe('400');
    await user.keyboard('{ArrowRight}');
    expect(now()).toBe('400');
    await user.keyboard('{Home}');
    expect(now()).toBe('192');
    await user.keyboard('{ArrowLeft}');
    expect(now()).toBe('192');
  });

  it('collapses with Enter, reports 0 and restores the previous width with Enter', async () => {
    const { user } = setup(<Demo />);
    separator().focus();
    await user.keyboard('{ArrowRight}{ArrowRight}');
    expect(now()).toBe('264');
    await user.keyboard('{Enter}');
    expect(now()).toBe('0');
    expect(attr('aria-valuetext')).toBe('Collapsed');
    await user.keyboard('{Enter}');
    expect(now()).toBe('264');
  });

  it('restores a collapsed pane with the arrow that widens it and ignores the other keys', async () => {
    const { user } = setup(<Demo />);
    separator().focus();
    await user.keyboard('{Enter}');
    await user.keyboard('{ArrowLeft}');
    expect(now()).toBe('0');
    await user.keyboard('{Home}');
    expect(now()).toBe('0');
    await user.keyboard('{ArrowRight}');
    expect(now()).toBe('248');
  });

  it('widens with the opposite arrow when the pane is after the separator', async () => {
    const { user } = setup(<Demo pane="after" />);
    separator().focus();
    await user.keyboard('{ArrowLeft}');
    expect(now()).toBe('256');
    await user.keyboard('{ArrowRight}');
    expect(now()).toBe('248');
  });

  it('uses the range it is given', async () => {
    const { user } = setup(<Demo min={100} max={200} step={10} largeStep={50} />);
    separator().focus();
    await user.keyboard('{Home}');
    expect(now()).toBe('100');
    await user.keyboard('{Shift>}{ArrowRight}{/Shift}');
    expect(now()).toBe('150');
  });
});

describe('Splitter pointer', () => {
  it('resets to the default on double click and un-collapses', async () => {
    const { user } = setup(<Demo />);
    separator().focus();
    await user.keyboard('{End}');
    expect(now()).toBe('400');
    await user.dblClick(separator());
    expect(now()).toBe('248');

    await user.keyboard('{Enter}');
    expect(now()).toBe('0');
    await user.dblClick(separator());
    expect(now()).toBe('248');
  });

  it('follows a drag in steps of 8 inside the range', () => {
    setup(<Demo />);
    fireEvent.pointerDown(separator(), { clientX: 300, button: 0, pointerId: 1 });
    fireEvent.pointerMove(separator(), { clientX: 343, pointerId: 1 }); // +43 -> 291 -> 288
    expect(now()).toBe('288');
    fireEvent.pointerMove(separator(), { clientX: 900, pointerId: 1 });
    expect(now()).toBe('400');
    fireEvent.pointerMove(separator(), { clientX: 200, pointerId: 1 }); // 248 - 100 = 148: above the collapse limit, clamped
    expect(now()).toBe('192');
    fireEvent.pointerUp(separator(), { clientX: 200, pointerId: 1 });
    expect(now()).toBe('192');
  });

  it('collapses when released narrower than 144 and keeps the width from before the drag', () => {
    setup(<Demo />);
    fireEvent.pointerDown(separator(), { clientX: 300, button: 0, pointerId: 1 });
    fireEvent.pointerMove(separator(), { clientX: 340, pointerId: 1 });
    expect(now()).toBe('288');
    fireEvent.pointerMove(separator(), { clientX: 100, pointerId: 1 }); // 248 - 200 = 48
    expect(now()).toBe('288'); // the pane waits; the release decides
    fireEvent.pointerUp(separator(), { clientX: 100, pointerId: 1 });
    expect(now()).toBe('0');
    expect(attr('aria-valuetext')).toBe('Collapsed');
    fireEvent.keyDown(separator(), { key: 'Enter' });
    expect(now()).toBe('248');
  });

  it('opens a collapsed pane by dragging it out', () => {
    setup(<Demo />);
    fireEvent.keyDown(separator(), { key: 'Enter' });
    expect(now()).toBe('0');
    fireEvent.pointerDown(separator(), { clientX: 8, button: 0, pointerId: 1 });
    fireEvent.pointerMove(separator(), { clientX: 108, pointerId: 1 }); // 0 + 100 < 144: still collapsed
    expect(now()).toBe('0');
    fireEvent.pointerMove(separator(), { clientX: 228, pointerId: 1 }); // 0 + 220
    expect(now()).toBe('224');
    fireEvent.pointerUp(separator(), { clientX: 228, pointerId: 1 });
    expect(now()).toBe('224');
  });

  it('drags the other way for a pane after the separator', () => {
    setup(<Demo pane="after" />);
    fireEvent.pointerDown(separator(), { clientX: 500, button: 0, pointerId: 1 });
    fireEvent.pointerMove(separator(), { clientX: 460, pointerId: 1 });
    expect(now()).toBe('288');
    fireEvent.pointerUp(separator(), { clientX: 460, pointerId: 1 });
  });
});

describe('Splitter range edge cases', () => {
  it('never leaves the range with a Shift step: it stops at max and at min', async () => {
    const { user } = setup(<Demo />);
    separator().focus();
    await user.keyboard('{End}{ArrowLeft}');
    expect(now()).toBe('392');
    await user.keyboard('{Shift>}{ArrowRight}{/Shift}');
    expect(now()).toBe('400');
    await user.keyboard('{Home}{ArrowRight}');
    expect(now()).toBe('200');
    await user.keyboard('{Shift>}{ArrowLeft}{/Shift}');
    expect(now()).toBe('192');
  });

  it('restores the width from before the collapse, at the ends of the range too, however often it is toggled', async () => {
    const { user } = setup(<Demo />);
    separator().focus();
    await user.keyboard('{End}{Enter}');
    expect(now()).toBe('0');
    await user.keyboard('{Enter}');
    expect(now()).toBe('400');
    await user.keyboard('{Home}{Enter}{Enter}{Enter}{Enter}');
    expect(now()).toBe('192');
    await user.keyboard('{Enter}');
    expect(now()).toBe('0');
  });

  it('restores the old width, not a bigger one, when a Shift arrow or End brings it back', async () => {
    const { user } = setup(<Demo />);
    separator().focus();
    await user.keyboard('{Enter}{Shift>}{ArrowRight}{/Shift}');
    expect(now()).toBe('248');
    await user.keyboard('{Enter}{End}');
    expect(now()).toBe('248');
  });

  it('only reports what changed: no width change at the limit, none when collapsing or restoring', async () => {
    const onValueChange = vi.fn();
    const onCollapsedChange = vi.fn();
    const { user } = setup(
      <Splitter
        label="Resize"
        controls="pane"
        min={192}
        max={400}
        defaultValue={248}
        value={400}
        collapsed={false}
        onValueChange={onValueChange}
        onCollapsedChange={onCollapsedChange}
      />,
    );
    separator().focus();
    await user.keyboard('{ArrowRight}{End}{Shift>}{ArrowRight}{/Shift}');
    expect(onValueChange).not.toHaveBeenCalled();
    await user.keyboard('{Enter}');
    expect(onCollapsedChange).toHaveBeenCalledExactlyOnceWith(true);
    expect(onValueChange).not.toHaveBeenCalled();
  });

  it('leaves a collapsed pane collapsed for keys that would not widen it', async () => {
    const onValueChange = vi.fn();
    const onCollapsedChange = vi.fn();
    const { user } = setup(
      <Splitter
        label="Resize"
        controls="pane"
        min={192}
        max={400}
        defaultValue={248}
        value={248}
        collapsed
        onValueChange={onValueChange}
        onCollapsedChange={onCollapsedChange}
      />,
    );
    separator().focus();
    await user.keyboard('{ArrowLeft}{ArrowUp}{ArrowDown}{Home}{PageUp}a');
    expect(onValueChange).not.toHaveBeenCalled();
    expect(onCollapsedChange).not.toHaveBeenCalled();
    expect(now()).toBe('0');
  });
});

describe('Splitter pointer edge cases', () => {
  it('keeps the pane open when released exactly at the collapse width, and collapses one pixel below', () => {
    setup(<Demo />);
    fireEvent.pointerDown(separator(), { clientX: 300, button: 0, pointerId: 1 });
    fireEvent.pointerMove(separator(), { clientX: 196, pointerId: 1 }); // 248 - 104 = 144: not narrower than 144
    expect(now()).toBe('192');
    fireEvent.pointerUp(separator(), { clientX: 196, pointerId: 1 });
    expect(now()).toBe('192');

    fireEvent.pointerDown(separator(), { clientX: 300, button: 0, pointerId: 2 });
    fireEvent.pointerMove(separator(), { clientX: 195, pointerId: 2 }); // 192 - 105 = 87: narrower
    fireEvent.pointerUp(separator(), { clientX: 195, pointerId: 2 });
    expect(now()).toBe('0');
  });

  it('uses the collapse width it is given', () => {
    setup(<Demo collapseBelow={100} />);
    fireEvent.pointerDown(separator(), { clientX: 300, button: 0, pointerId: 1 });
    fireEvent.pointerMove(separator(), { clientX: 200, pointerId: 1 }); // 248 - 100 = 148: above 100, clamped to min
    fireEvent.pointerUp(separator(), { clientX: 200, pointerId: 1 });
    expect(now()).toBe('192');
  });

  it('ignores a press with another button, and moves without a press', () => {
    setup(<Demo />);
    fireEvent.pointerMove(separator(), { clientX: 400, pointerId: 1 });
    expect(now()).toBe('248');
    fireEvent.pointerDown(separator(), { clientX: 300, button: 2, pointerId: 1 });
    fireEvent.pointerMove(separator(), { clientX: 400, pointerId: 1 });
    expect(now()).toBe('248');
    fireEvent.pointerUp(separator(), { clientX: 400, pointerId: 1 });
    expect(now()).toBe('248');
  });

  it('stops following the pointer after the release', () => {
    setup(<Demo />);
    fireEvent.pointerDown(separator(), { clientX: 300, button: 0, pointerId: 1 });
    fireEvent.pointerMove(separator(), { clientX: 340, pointerId: 1 });
    fireEvent.pointerUp(separator(), { clientX: 340, pointerId: 1 });
    expect(now()).toBe('288');
    fireEvent.pointerMove(separator(), { clientX: 500, pointerId: 1 });
    expect(now()).toBe('288');
  });

  it('resets to the default width on double click even when already there, and respects a custom default', async () => {
    const { user } = setup(<Demo defaultValue={200} />);
    await user.dblClick(separator());
    expect(now()).toBe('200');
    await user.dblClick(separator());
    expect(now()).toBe('200');
  });
});

describe('Splitter grip click (DESIGN 3.5 B2)', () => {
  it('a click without movement collapses and a second click restores; a drag of 4 px or more is not a click', () => {
    setup(<Demo />);
    fireEvent.pointerDown(separator(), { clientX: 300, button: 0, pointerId: 1 });
    fireEvent.pointerMove(separator(), { clientX: 302, pointerId: 1 });
    fireEvent.pointerUp(separator(), { clientX: 302, pointerId: 1 });
    expect(now()).toBe('0');
    fireEvent.pointerDown(separator(), { clientX: 8, button: 0, pointerId: 1 });
    fireEvent.pointerUp(separator(), { clientX: 8, pointerId: 1 });
    expect(Number(now())).toBeGreaterThan(0);
    fireEvent.pointerDown(separator(), { clientX: 300, button: 0, pointerId: 1 });
    fireEvent.pointerMove(separator(), { clientX: 310, pointerId: 1 });
    fireEvent.pointerUp(separator(), { clientX: 310, pointerId: 1 });
    expect(Number(now())).toBeGreaterThan(0);
  });
});
