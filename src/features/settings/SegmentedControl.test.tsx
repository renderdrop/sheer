// @vitest-environment jsdom
import { fireEvent, screen } from '@testing-library/react';
import { useState } from 'react';
import { describe, expect, it, vi } from 'vitest';

import { setup } from '../../test/render';
import { SegmentedControl, type SegmentOption } from './SegmentedControl';

type Mode = 'system' | 'light' | 'dark';

const OPTIONS: readonly SegmentOption<Mode>[] = [
  { value: 'system', label: 'System' },
  { value: 'light', label: 'Light' },
  { value: 'dark', label: 'Dark' },
];

/** The control with its own state, the way the settings store drives it, and a spy on what it reports. */
function Demo({ initial = 'system', onChange = vi.fn() }: { initial?: Mode; onChange?: (value: Mode) => void }) {
  const [value, setValue] = useState<Mode>(initial);
  return (
    <>
      <span id="label">Theme</span>
      <button type="button">before</button>
      <SegmentedControl
        labelledBy="label"
        value={value}
        options={OPTIONS}
        onChange={(next) => {
          onChange(next);
          setValue(next);
        }}
      />
      <button type="button">after</button>
    </>
  );
}

const radio = (name: string) => screen.getByRole('radio', { name });

describe('SegmentedControl', () => {
  it('is a radio group named by its label, with one radio per option and the value checked', () => {
    setup(<Demo initial="light" />);
    expect(screen.getByRole('radiogroup', { name: 'Theme' })).not.toBeNull();
    expect(screen.getAllByRole('radio').map((item) => item.textContent)).toEqual(['System', 'Light', 'Dark']);
    expect(screen.getAllByRole('radio').map((item) => item.getAttribute('aria-checked'))).toEqual([
      'false',
      'true',
      'false',
    ]);
  });

  it('has one tab stop, the checked radio; Tab goes in once and out again', async () => {
    const { user } = setup(<Demo initial="light" />);
    expect(screen.getAllByRole('radio').map((item) => item.tabIndex)).toEqual([-1, 0, -1]);
    screen.getByRole('button', { name: 'before' }).focus();
    await user.tab();
    expect(document.activeElement).toBe(radio('Light'));
    await user.tab();
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'after' }));
    await user.tab({ shift: true });
    expect(document.activeElement).toBe(radio('Light'));
  });

  it('falls back to the first radio as the tab stop when the value is not an option', () => {
    setup(<Demo initial={'sepia' as Mode} />);
    expect(screen.getAllByRole('radio').map((item) => item.tabIndex)).toEqual([0, -1, -1]);
    expect(screen.getAllByRole('radio').every((item) => item.getAttribute('aria-checked') === 'false')).toBe(true);
  });

  it('chooses a radio on click, and reports a click on the checked one as nothing', async () => {
    const onChange = vi.fn();
    const { user } = setup(<Demo onChange={onChange} />);
    await user.click(radio('Dark'));
    expect(onChange).toHaveBeenCalledExactlyOnceWith('dark');
    expect(radio('Dark').getAttribute('aria-checked')).toBe('true');
    expect(radio('Dark').tabIndex).toBe(0);
    expect(radio('System').tabIndex).toBe(-1);
    await user.click(radio('Dark'));
    expect(onChange).toHaveBeenCalledTimes(1);
  });

  it('chooses with Space and Enter on the focused radio (it is a button)', async () => {
    const onChange = vi.fn();
    const { user } = setup(<Demo onChange={onChange} />);
    radio('Light').focus();
    await user.keyboard(' ');
    expect(onChange).toHaveBeenLastCalledWith('light');
    radio('Dark').focus();
    await user.keyboard('{Enter}');
    expect(onChange).toHaveBeenLastCalledWith('dark');
  });

  it('moves focus and the choice together with the arrows, wrapping at the ends', async () => {
    const onChange = vi.fn();
    const { user } = setup(<Demo onChange={onChange} />);
    radio('System').focus();
    await user.keyboard('{ArrowRight}');
    expect(document.activeElement).toBe(radio('Light'));
    expect(radio('Light').getAttribute('aria-checked')).toBe('true');
    await user.keyboard('{ArrowRight}{ArrowRight}');
    expect(document.activeElement).toBe(radio('System'));
    expect(onChange.mock.calls.map(([value]) => value)).toEqual(['light', 'dark', 'system']);
    await user.keyboard('{ArrowLeft}');
    expect(document.activeElement).toBe(radio('Dark'));
    expect(radio('Dark').getAttribute('aria-checked')).toBe('true');
  });

  it('takes Up and Down like Left and Right, and Home and End jump', async () => {
    const { user } = setup(<Demo />);
    radio('System').focus();
    await user.keyboard('{ArrowDown}');
    expect(document.activeElement).toBe(radio('Light'));
    await user.keyboard('{ArrowUp}');
    expect(document.activeElement).toBe(radio('System'));
    await user.keyboard('{End}');
    expect(document.activeElement).toBe(radio('Dark'));
    expect(radio('Dark').getAttribute('aria-checked')).toBe('true');
    await user.keyboard('{Home}');
    expect(document.activeElement).toBe(radio('System'));
    expect(radio('System').getAttribute('aria-checked')).toBe('true');
  });

  it('claims its arrow keys, so nothing behind it scrolls, and leaves other keys and modified arrows alone', () => {
    setup(<Demo />);
    radio('System').focus();
    expect(fireEvent.keyDown(radio('System'), { key: 'ArrowRight' })).toBe(false);
    expect(fireEvent.keyDown(radio('Light'), { key: 'a' })).toBe(true);
    expect(fireEvent.keyDown(radio('Light'), { key: 'ArrowRight', ctrlKey: true })).toBe(true);
    expect(fireEvent.keyDown(radio('Light'), { key: 'ArrowRight', altKey: true })).toBe(true);
    expect(fireEvent.keyDown(radio('Light'), { key: 'ArrowRight', metaKey: true })).toBe(true);
    expect(radio('Light').getAttribute('aria-checked')).toBe('true');
  });

  it('does nothing at the end of a one-segment group and does not report the checked radio again', async () => {
    const onChange = vi.fn();
    const { user } = setup(
      <SegmentedControl labelledBy="x" value="a" options={[{ value: 'a', label: 'Only' }]} onChange={onChange} />,
    );
    radio('Only').focus();
    await user.keyboard('{ArrowRight}{ArrowLeft}{Home}{End}');
    expect(onChange).not.toHaveBeenCalled();
  });

  it('shares the press scale of every control; hover only changes the text of the segments not chosen', () => {
    setup(<Demo initial="dark" />);
    for (const name of ['System', 'Light', 'Dark']) {
      expect(radio(name).className.split(' '), name).toContain(
        'not-aria-disabled:enabled:active:scale-(--scale-press)',
      );
    }
    expect(radio('Light').className).toContain('not-aria-disabled:enabled:hover:text-text');
    expect(radio('Dark').className).not.toContain('hover:text-text');
  });

  it('carries the forced-colors cue of the selected look on the chosen segment only', () => {
    setup(<Demo initial="light" />);
    expect(radio('Light').className).toContain('forced-colors:border-accent');
    expect(radio('System').className).not.toContain('forced-colors:');
  });

  it('shows the selected look on the checked radio only, in tokens', () => {
    setup(<Demo initial="dark" />);
    expect(radio('Dark').className).toContain('bg-surface-solid');
    expect(radio('Dark').className).toContain('border-control-border');
    expect(radio('Light').className).not.toContain('bg-surface-solid');
    expect(radio('Light').className).toContain('text-text-muted');
    // DESIGN v2 §4: a Sand track (radius md, 2 px padding) around segments of radius sm.
    expect(screen.getByRole('radiogroup').className).toContain('bg-subtle');
    expect(radio('Light').className).toContain('rounded-sm');
  });
});
