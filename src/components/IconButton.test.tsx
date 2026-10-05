// @vitest-environment jsdom
import { MousePointer2 } from 'lucide-react';
import { act, render } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { openTooltip, setup } from '../test/render';
import { IconButton } from './IconButton';

describe('IconButton', () => {
  it('takes its accessible name and shortcut attributes from the props', () => {
    const { getByRole } = setup(
      <IconButton label="Select" icon={MousePointer2} keyShortcuts="V" shortcut="V" onClick={() => undefined} />,
    );
    const button = getByRole('button', { name: 'Select' });
    expect(button.getAttribute('aria-label')).toBe('Select');
    expect(button.getAttribute('aria-keyshortcuts')).toBe('V');
    expect(button.hasAttribute('aria-pressed')).toBe(false);
  });

  it('exposes toggle and tool state as aria-pressed', () => {
    const { getByRole, rerender } = setup(<IconButton label="Panel" icon={MousePointer2} variant="toggle" pressed />);
    expect(getByRole('button').getAttribute('aria-pressed')).toBe('true');
    rerender(<IconButton label="Panel" icon={MousePointer2} variant="tool" pressed={false} />);
    expect(getByRole('button').getAttribute('aria-pressed')).toBe('false');
  });

  it('describes a locked tool and shows the badge', () => {
    const { getByRole, container } = setup(
      <IconButton label="Draw" icon={MousePointer2} variant="tool" pressed locked />,
    );
    expect(getByRole('button').getAttribute('aria-description')).toBe('Locked');
    expect(container.querySelectorAll('svg')).toHaveLength(2);
  });

  it('keeps a disabled button focusable on request and ignores clicks', async () => {
    const onClick = vi.fn();
    const { user, getByRole } = setup(
      <IconButton label="Zoom in" icon={MousePointer2} disabled focusableWhenDisabled onClick={onClick} />,
    );
    await user.tab();
    expect(document.activeElement).toBe(getByRole('button'));
    expect(getByRole('button').getAttribute('aria-disabled')).toBe('true');
    await user.click(getByRole('button'));
    expect(onClick).not.toHaveBeenCalled();
  });

  it('forwards ref and event props to the button, so a popover trigger can be spread onto it', async () => {
    const onKeyDown = vi.fn();
    const ref = vi.fn();
    const { user, getByRole } = setup(<IconButton label="More" icon={MousePointer2} ref={ref} onKeyDown={onKeyDown} />);
    await user.tab();
    await user.keyboard('{ArrowDown}');
    expect(onKeyDown).toHaveBeenCalledTimes(1);
    expect(ref).toHaveBeenCalledWith(getByRole('button'));
  });
});

describe('IconButton, disabled but focusable', () => {
  const soft = (props: Record<string, unknown>) => (
    <IconButton label="Draw" icon={MousePointer2} disabled focusableWhenDisabled {...props} />
  );

  it('drops every handler that acts: click, double click, keys, pointer and context menu', async () => {
    const handlers = {
      onClick: vi.fn(),
      onDoubleClick: vi.fn(),
      onAuxClick: vi.fn(),
      onKeyDown: vi.fn(),
      onKeyUp: vi.fn(),
      onPointerDown: vi.fn(),
      onPointerUp: vi.fn(),
      onMouseDown: vi.fn(),
      onMouseUp: vi.fn(),
      onContextMenu: vi.fn(),
    };
    const { user, getByRole } = setup(soft(handlers));
    const button = getByRole('button', { name: 'Draw' });
    await user.dblClick(button);
    await user.pointer({ keys: '[MouseRight]', target: button });
    button.focus();
    await user.keyboard('{Enter}{Shift>}{Enter}{/Shift}{ArrowDown}{ArrowUp} ');
    for (const [name, handler] of Object.entries(handlers)) expect(handler, name).not.toHaveBeenCalled();
  });

  it('keeps the observers: focus, blur and hover enter and leave', async () => {
    const onFocus = vi.fn();
    const onBlur = vi.fn();
    const onPointerEnter = vi.fn();
    const onPointerLeave = vi.fn();
    const { user, getByRole } = setup(soft({ onFocus, onBlur, onPointerEnter, onPointerLeave }));
    const button = getByRole('button', { name: 'Draw' });
    await user.hover(button);
    await user.unhover(button);
    await user.tab();
    await user.tab();
    expect(onPointerEnter).toHaveBeenCalledTimes(1);
    expect(onPointerLeave).toHaveBeenCalledTimes(1);
    expect(onFocus).toHaveBeenCalledTimes(1);
    expect(onBlur).toHaveBeenCalledTimes(1);
  });

  it('cancels the click, so a submit button does not submit its form', async () => {
    const onSubmit = vi.fn((event: { preventDefault: () => void }) => event.preventDefault());
    const { user, getByRole } = setup(<form onSubmit={onSubmit}>{soft({ type: 'submit' })}</form>);
    await user.click(getByRole('button', { name: 'Draw' }));
    expect(onSubmit).not.toHaveBeenCalled();
  });

  it('runs every handler again once it is enabled', async () => {
    const onClick = vi.fn();
    const onDoubleClick = vi.fn();
    const { user, getByRole } = setup(
      <IconButton
        label="Draw"
        icon={MousePointer2}
        focusableWhenDisabled
        onClick={onClick}
        onDoubleClick={onDoubleClick}
      />,
    );
    await user.dblClick(getByRole('button', { name: 'Draw' }));
    expect(onClick).toHaveBeenCalledTimes(2);
    expect(onDoubleClick).toHaveBeenCalledTimes(1);
  });
});

describe('IconButton tooltip', () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('shows the name, the shortcut chip and a locked note after keyboard focus', () => {
    const { getByRole } = render(
      <IconButton label="Draw" icon={MousePointer2} variant="tool" pressed locked shortcut="D" />,
    );
    act(() => getByRole('button').focus());
    expect(openTooltip()).toBeNull();
    act(() => {
      vi.advanceTimersByTime(400);
    });
    const tooltip = openTooltip();
    expect(tooltip?.textContent).toContain('Draw');
    expect(tooltip?.querySelector('kbd')?.textContent).toBe('D');
    expect(tooltip?.textContent).toContain('Locked · Esc to release');
  });
});

describe('IconButton disabled edge cases', () => {
  it('uses the disabled attribute by default: not focusable, no click, no key activation', async () => {
    const onClick = vi.fn();
    const { user, getByRole } = setup(<IconButton label="Zoom in" icon={MousePointer2} disabled onClick={onClick} />);
    expect(getByRole('button').hasAttribute('disabled')).toBe(true);
    expect(getByRole('button').hasAttribute('aria-disabled')).toBe(false);
    await user.tab();
    expect(document.activeElement).toBe(document.body);
    await user.click(getByRole('button'));
    expect(onClick).not.toHaveBeenCalled();
  });

  it('does nothing for Enter and Space while aria-disabled, and again works once enabled', async () => {
    const onClick = vi.fn();
    const { user, getByRole, rerender } = setup(
      <IconButton label="Zoom in" icon={MousePointer2} disabled focusableWhenDisabled onClick={onClick} />,
    );
    await user.tab();
    await user.keyboard('{Enter}');
    await user.keyboard(' ');
    expect(onClick).not.toHaveBeenCalled();
    rerender(<IconButton label="Zoom in" icon={MousePointer2} focusableWhenDisabled onClick={onClick} />);
    expect(getByRole('button').hasAttribute('aria-disabled')).toBe(false);
    await user.keyboard('{Enter}');
    expect(onClick).toHaveBeenCalledTimes(1);
  });

  it('does not toggle or lock while aria-disabled: aria-pressed stays as given', async () => {
    const onClick = vi.fn();
    const { user, getByRole } = setup(
      <IconButton
        label="Pen"
        icon={MousePointer2}
        variant="tool"
        pressed={false}
        disabled
        focusableWhenDisabled
        onClick={onClick}
      />,
    );
    await user.click(getByRole('button'));
    expect(onClick).not.toHaveBeenCalled();
    expect(getByRole('button').getAttribute('aria-pressed')).toBe('false');
  });
});
