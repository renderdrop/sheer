// @vitest-environment jsdom
import { fireEvent } from '@testing-library/react';
import { useState } from 'react';
import { describe, expect, it, vi } from 'vitest';

import { setup } from '../test/render';
import { Slider, snapToStep, type SliderProps } from './Slider';

function Demo({ initial = 50, ...props }: { initial?: number } & Partial<SliderProps>) {
  const [value, setValue] = useState(initial);
  return <Slider label="Opacity" unit="%" {...props} value={value} onValueChange={setValue} />;
}

const thumb = () => document.querySelector<HTMLElement>('[role="slider"]') as HTMLElement;
const now = () => thumb().getAttribute('aria-valuenow');

describe('snapToStep', () => {
  it('clamps and rounds to the step from min', () => {
    expect(snapToStep(47, 0, 100, 5)).toBe(45);
    expect(snapToStep(48, 0, 100, 5)).toBe(50);
    expect(snapToStep(-10, 0, 100, 1)).toBe(0);
    expect(snapToStep(130, 0, 100, 1)).toBe(100);
    expect(snapToStep(7, 2, 100, 5)).toBe(7);
  });

  it('does not leak floating point noise', () => {
    expect(snapToStep(0.30000000000000004, 0, 1, 0.1)).toBe(0.3);
    expect(snapToStep(0.7, 0, 1, 0.05)).toBe(0.7);
  });
});

describe('Slider semantics', () => {
  it('is a labelled slider with value, range, text and orientation', () => {
    const { getByRole } = setup(<Demo />);
    const slider = getByRole('slider', { name: 'Opacity' });
    expect(slider.getAttribute('aria-valuemin')).toBe('0');
    expect(slider.getAttribute('aria-valuemax')).toBe('100');
    expect(slider.getAttribute('aria-valuenow')).toBe('50');
    expect(slider.getAttribute('aria-valuetext')).toBe('50 %');
    expect(slider.getAttribute('aria-orientation')).toBe('horizontal');
    expect(slider.tabIndex).toBe(0);
  });

  it('pairs the slider with a numeric field of the same name', () => {
    const { getByRole } = setup(<Demo />);
    expect((getByRole('textbox', { name: 'Opacity' }) as HTMLInputElement).value).toBe('50 %');
  });

  it('formats with a custom formatter', () => {
    const { getByRole } = setup(<Demo format={(value) => `${value} percent`} />);
    expect(getByRole('slider').getAttribute('aria-valuetext')).toBe('50 percent');
  });
});

describe('Slider keyboard', () => {
  it('steps with the arrows', async () => {
    const { user } = setup(<Demo />);
    thumb().focus();
    await user.keyboard('{ArrowRight}');
    expect(now()).toBe('51');
    await user.keyboard('{ArrowUp}');
    expect(now()).toBe('52');
    await user.keyboard('{ArrowLeft}');
    expect(now()).toBe('51');
    await user.keyboard('{ArrowDown}');
    expect(now()).toBe('50');
  });

  it('moves ten steps with Shift', async () => {
    const { user } = setup(<Demo />);
    thumb().focus();
    await user.keyboard('{Shift>}{ArrowRight}{/Shift}');
    expect(now()).toBe('60');
    await user.keyboard('{Shift>}{ArrowLeft}{ArrowLeft}{/Shift}');
    expect(now()).toBe('40');
  });

  it('moves a tenth of the range with PageUp and PageDown', async () => {
    const { user } = setup(<Demo initial={100} min={0} max={200} />);
    thumb().focus();
    await user.keyboard('{PageUp}');
    expect(now()).toBe('120');
    await user.keyboard('{PageDown}{PageDown}');
    expect(now()).toBe('80');
  });

  it('jumps with Home and End and stays inside the range', async () => {
    const { user } = setup(<Demo />);
    thumb().focus();
    await user.keyboard('{End}');
    expect(now()).toBe('100');
    await user.keyboard('{ArrowRight}');
    expect(now()).toBe('100');
    await user.keyboard('{Home}');
    expect(now()).toBe('0');
    await user.keyboard('{ArrowLeft}');
    expect(now()).toBe('0');
  });

  it('keeps to the step size', async () => {
    const { user } = setup(<Demo step={5} />);
    thumb().focus();
    await user.keyboard('{ArrowRight}');
    expect(now()).toBe('55');
    await user.keyboard('{Shift>}{ArrowLeft}{/Shift}');
    expect(now()).toBe('5');
  });

  it('reports each key press as a commit', async () => {
    const onValueCommit = vi.fn();
    const { user } = setup(<Demo onValueCommit={onValueCommit} />);
    thumb().focus();
    await user.keyboard('{ArrowRight}{ArrowRight}');
    expect(onValueCommit).toHaveBeenCalledTimes(2);
    expect(onValueCommit).toHaveBeenLastCalledWith(52);
  });

  it('ignores keys when disabled and is not a tab stop', async () => {
    const { user } = setup(<Demo disabled />);
    expect(thumb().tabIndex).toBe(-1);
    expect(thumb().getAttribute('aria-disabled')).toBe('true');
    thumb().focus();
    await user.keyboard('{ArrowRight}');
    expect(now()).toBe('50');
  });
});

describe('Slider field', () => {
  const field = () => document.querySelector('input') as HTMLInputElement;

  it('commits a typed number on Enter', async () => {
    const { user } = setup(<Demo />);
    await user.clear(field());
    await user.type(field(), '75{Enter}');
    expect(now()).toBe('75');
    expect(field().value).toBe('75 %');
  });

  it('accepts a decimal comma and clamps to the range', async () => {
    const { user } = setup(<Demo max={200} step={0.5} />);
    await user.clear(field());
    await user.type(field(), '12,5{Enter}');
    expect(now()).toBe('12.5');
    await user.clear(field());
    await user.type(field(), '999{Enter}');
    expect(now()).toBe('200');
  });

  it('reverts on Esc', async () => {
    const { user } = setup(<Demo />);
    await user.clear(field());
    await user.type(field(), '80');
    await user.keyboard('{Escape}');
    expect(now()).toBe('50');
    expect(field().value).toBe('50 %');
  });

  it('reverts text that is not a number', async () => {
    const { user } = setup(<Demo />);
    await user.clear(field());
    await user.type(field(), 'abc{Enter}');
    expect(now()).toBe('50');
    expect(field().value).toBe('50 %');
  });

  it('commits when focus leaves the field', async () => {
    const { user } = setup(<Demo />);
    await user.clear(field());
    await user.type(field(), '20');
    await user.tab();
    expect(now()).toBe('20');
  });
});

describe('Slider pointer', () => {
  /** jsdom has no layout: the track is 200 px wide, starting at x = 100. */
  function layoutTrack() {
    const track = thumb().parentElement as HTMLElement;
    track.getBoundingClientRect = () => ({
      left: 100,
      top: 0,
      width: 200,
      height: 4,
      right: 300,
      bottom: 4,
      x: 100,
      y: 0,
      toJSON: () => ({}),
    });
    return track.parentElement as HTMLElement;
  }

  it('jumps to the pointer and follows a drag, committing once at the end', () => {
    const onValueCommit = vi.fn();
    setup(<Demo onValueCommit={onValueCommit} />);
    const hitArea = layoutTrack();
    fireEvent.pointerDown(hitArea, { clientX: 150, button: 0, pointerId: 1 });
    expect(now()).toBe('25');
    expect(document.activeElement).toBe(thumb());
    fireEvent.pointerMove(hitArea, { clientX: 250, pointerId: 1 });
    expect(now()).toBe('75');
    fireEvent.pointerMove(hitArea, { clientX: 900, pointerId: 1 });
    expect(now()).toBe('100');
    expect(onValueCommit).not.toHaveBeenCalled();
    fireEvent.pointerUp(hitArea, { clientX: 200, pointerId: 1 });
    expect(now()).toBe('50');
    expect(onValueCommit).toHaveBeenCalledExactlyOnceWith(50);
  });

  it('ignores moves without a press and presses when disabled', () => {
    setup(<Demo disabled />);
    const hitArea = layoutTrack();
    fireEvent.pointerMove(hitArea, { clientX: 250, pointerId: 1 });
    fireEvent.pointerDown(hitArea, { clientX: 250, button: 0, pointerId: 1 });
    expect(now()).toBe('50');
  });
});

describe('snapToStep edge cases', () => {
  it('keeps the maximum reachable when the step does not divide the range', () => {
    expect(snapToStep(100, 0, 100, 40)).toBe(100);
    expect(snapToStep(99, 0, 100, 30)).toBe(90);
    expect(snapToStep(1000, 3, 100, 7)).toBe(100);
  });

  it('works for ranges below zero and measures steps from min', () => {
    expect(snapToStep(-7, -50, 50, 10)).toBe(-10);
    expect(snapToStep(-500, -50, 50, 10)).toBe(-50);
    expect(snapToStep(3, -5, 5, 4)).toBe(3);
  });

  it('gives the same answer for a value that is already on a step', () => {
    for (const value of [0, 0.1, 0.5, 0.9, 1]) expect(snapToStep(value, 0, 1, 0.1)).toBe(value);
  });
});

describe('Slider range edge cases', () => {
  const field = () => document.querySelector('input') as HTMLInputElement;

  it('pulls a value outside the range back inside on the next key press', async () => {
    const { user } = setup(<Demo initial={150} />);
    thumb().focus();
    await user.keyboard('{ArrowLeft}');
    expect(now()).toBe('100');
  });

  it('clamps a Shift step and a page step at both ends and commits the clamped value', async () => {
    const onValueCommit = vi.fn();
    const { user } = setup(<Demo initial={95} onValueCommit={onValueCommit} />);
    thumb().focus();
    await user.keyboard('{Shift>}{ArrowRight}{/Shift}');
    expect(now()).toBe('100');
    expect(onValueCommit).toHaveBeenLastCalledWith(100);
    await user.keyboard('{Home}{PageDown}');
    expect(now()).toBe('0');
    expect(onValueCommit).toHaveBeenLastCalledWith(0);
  });

  it('does not report a change at the end of the range, but still reports the commit', async () => {
    const onValueChange = vi.fn();
    const onValueCommit = vi.fn();
    const { user } = setup(
      <Slider label="Opacity" value={100} onValueChange={onValueChange} onValueCommit={onValueCommit} />,
    );
    thumb().focus();
    await user.keyboard('{ArrowRight}{End}');
    expect(onValueChange).not.toHaveBeenCalled();
    expect(onValueCommit).toHaveBeenCalledTimes(2);
    expect(onValueCommit).toHaveBeenLastCalledWith(100);
  });

  it('keeps fractional steps free of float noise key press after key press', async () => {
    const { user } = setup(<Demo initial={0.1} min={0} max={1} step={0.1} unit={undefined} />);
    thumb().focus();
    await user.keyboard('{ArrowRight}{ArrowRight}{ArrowRight}');
    expect(now()).toBe('0.4');
    await user.keyboard('{ArrowLeft}{ArrowLeft}{ArrowLeft}{ArrowLeft}{ArrowLeft}');
    expect(now()).toBe('0');
  });

  it('works on a range below zero: Home, End and a step inside it', async () => {
    const { user } = setup(<Demo initial={0} min={-50} max={50} step={10} />);
    thumb().focus();
    await user.keyboard('{Home}');
    expect(now()).toBe('-50');
    await user.keyboard('{ArrowLeft}');
    expect(now()).toBe('-50');
    await user.keyboard('{ArrowRight}');
    expect(now()).toBe('-40');
    await user.keyboard('{End}{ArrowRight}');
    expect(now()).toBe('50');
  });

  it('survives a range of a single value', async () => {
    const { user } = setup(<Demo initial={5} min={5} max={5} />);
    thumb().focus();
    await user.keyboard('{ArrowRight}{Home}{End}{PageUp}');
    expect(now()).toBe('5');
    expect(thumb().parentElement?.firstElementChild?.getAttribute('style')).toBe('width: 0%;');
  });

  it('snaps a typed number to the step and clamps it, committing once with the final value', async () => {
    const onValueCommit = vi.fn();
    const { user } = setup(<Demo step={5} onValueCommit={onValueCommit} />);
    await user.clear(field());
    await user.type(field(), '47{Enter}');
    expect(now()).toBe('45');
    expect(field().value).toBe('45 %');
    await user.clear(field());
    await user.type(field(), '-5{Enter}');
    expect(now()).toBe('0');
    await user.clear(field());
    await user.type(field(), '1000{Enter}');
    expect(now()).toBe('100');
    expect(onValueCommit.mock.calls).toEqual([[45], [0], [100]]);
  });

  it('has a disabled field when disabled, so nothing can be typed', async () => {
    const { user } = setup(<Demo disabled />);
    expect(field().disabled).toBe(true);
    await user.type(field(), '9{Enter}');
    expect(now()).toBe('50');
  });
});

describe('Slider pointer edge cases', () => {
  /** The track is 200 px wide, starting at x = 100 (jsdom has no layout). */
  function layoutTrack() {
    const track = thumb().parentElement as HTMLElement;
    track.getBoundingClientRect = () =>
      ({
        left: 100,
        top: 0,
        width: 200,
        height: 4,
        right: 300,
        bottom: 4,
        x: 100,
        y: 0,
        toJSON: () => ({}),
      }) as DOMRect;
    return track.parentElement as HTMLElement;
  }

  it('clamps a drag past the start of the track to the minimum, and past the end to the maximum', () => {
    setup(<Demo />);
    const hitArea = layoutTrack();
    fireEvent.pointerDown(hitArea, { clientX: 200, button: 0, pointerId: 1 });
    fireEvent.pointerMove(hitArea, { clientX: -400, pointerId: 1 });
    expect(now()).toBe('0');
    fireEvent.pointerMove(hitArea, { clientX: 5000, pointerId: 1 });
    expect(now()).toBe('100');
    fireEvent.pointerUp(hitArea, { clientX: -400, pointerId: 1 });
    expect(now()).toBe('0');
  });

  it('snaps the pointer position to the step', () => {
    setup(<Demo step={5} />);
    const hitArea = layoutTrack();
    fireEvent.pointerDown(hitArea, { clientX: 163, button: 0, pointerId: 1 }); // 31.5 %
    expect(now()).toBe('30');
    fireEvent.pointerMove(hitArea, { clientX: 168, pointerId: 1 }); // 34 %
    expect(now()).toBe('35');
    fireEvent.pointerUp(hitArea, { clientX: 168, pointerId: 1 });
  });

  it('ignores a press with another button than the primary one', () => {
    setup(<Demo />);
    const hitArea = layoutTrack();
    fireEvent.pointerDown(hitArea, { clientX: 250, button: 2, pointerId: 1 });
    fireEvent.pointerMove(hitArea, { clientX: 290, pointerId: 1 });
    expect(now()).toBe('50');
  });

  it('stops following the pointer after the release', () => {
    setup(<Demo />);
    const hitArea = layoutTrack();
    fireEvent.pointerDown(hitArea, { clientX: 200, button: 0, pointerId: 1 });
    fireEvent.pointerUp(hitArea, { clientX: 200, pointerId: 1 });
    fireEvent.pointerMove(hitArea, { clientX: 290, pointerId: 1 });
    expect(now()).toBe('50');
  });
});
