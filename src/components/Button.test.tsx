// @vitest-environment jsdom
import { Plus } from 'lucide-react';
import { describe, expect, it, vi } from 'vitest';

import { setup } from '../test/render';
import { Button } from './Button';

describe('Button, disabled but focusable', () => {
  it('stays in the tab order and drops every handler that acts', async () => {
    const onClick = vi.fn();
    const onDoubleClick = vi.fn();
    const onKeyDown = vi.fn();
    const onFocus = vi.fn();
    const { user, getByRole } = setup(
      <Button
        disabled
        focusableWhenDisabled
        onClick={onClick}
        onDoubleClick={onDoubleClick}
        onKeyDown={onKeyDown}
        onFocus={onFocus}
      >
        Open
      </Button>,
    );
    const button = getByRole('button', { name: 'Open' });
    expect(button.getAttribute('aria-disabled')).toBe('true');
    await user.tab();
    expect(document.activeElement).toBe(button);
    await user.dblClick(button);
    await user.keyboard('{Enter} {ArrowDown}');
    expect(onClick).not.toHaveBeenCalled();
    expect(onDoubleClick).not.toHaveBeenCalled();
    expect(onKeyDown).not.toHaveBeenCalled();
    expect(onFocus).toHaveBeenCalledTimes(1);
  });
});

describe('Button', () => {
  it('is a type=button with its label', () => {
    const { getByRole } = setup(<Button>Open</Button>);
    const button = getByRole('button', { name: 'Open' });
    expect(button.getAttribute('type')).toBe('button');
  });

  it('activates with click, Enter and Space', async () => {
    const onClick = vi.fn();
    const { user, getByRole } = setup(<Button onClick={onClick}>Open</Button>);
    await user.click(getByRole('button'));
    getByRole('button').focus();
    await user.keyboard('{Enter}');
    await user.keyboard(' ');
    expect(onClick).toHaveBeenCalledTimes(3);
  });

  it('hides the icon from assistive technology', () => {
    const { container } = setup(<Button icon={Plus}>Add</Button>);
    expect(container.querySelector('svg')?.getAttribute('aria-hidden')).toBe('true');
  });

  it('uses the disabled attribute and leaves the tab order when disabled', async () => {
    const onClick = vi.fn();
    const { user, getByRole } = setup(
      <Button disabled onClick={onClick}>
        Open
      </Button>,
    );
    await user.click(getByRole('button'));
    expect(onClick).not.toHaveBeenCalled();
    expect(getByRole('button').hasAttribute('disabled')).toBe(true);
    await user.tab();
    expect(document.activeElement).toBe(document.body);
  });

  it('stays focusable with aria-disabled when asked to, and does nothing', async () => {
    const onClick = vi.fn();
    const { user, getByRole } = setup(
      <Button disabled focusableWhenDisabled onClick={onClick}>
        Open
      </Button>,
    );
    const button = getByRole('button');
    expect(button.getAttribute('aria-disabled')).toBe('true');
    expect(button.hasAttribute('disabled')).toBe(false);
    await user.tab();
    expect(document.activeElement).toBe(button);
    await user.keyboard('{Enter}');
    await user.click(button);
    expect(onClick).not.toHaveBeenCalled();
  });
});

describe('Button disabled edge cases', () => {
  const submit = (soft: boolean) => {
    const onSubmit = vi.fn((event: { preventDefault: () => void }) => event.preventDefault());
    const onClick = vi.fn();
    const utils = setup(
      <form onSubmit={onSubmit}>
        <Button type="submit" disabled focusableWhenDisabled={soft} onClick={onClick}>
          Save
        </Button>
      </form>,
    );
    return { ...utils, onSubmit, onClick };
  };

  it('does not submit a form while disabled, with the disabled attribute', async () => {
    const { user, getByRole, onSubmit, onClick } = submit(false);
    await user.click(getByRole('button'));
    expect(onSubmit).not.toHaveBeenCalled();
    expect(onClick).not.toHaveBeenCalled();
  });

  it('does not submit a form while aria-disabled, with a click, Enter or Space', async () => {
    const { user, getByRole, onSubmit, onClick } = submit(true);
    await user.click(getByRole('button'));
    await user.tab();
    await user.keyboard('{Enter}');
    await user.keyboard(' ');
    expect(onSubmit).not.toHaveBeenCalled();
    expect(onClick).not.toHaveBeenCalled();
  });

  it('does nothing with Space while aria-disabled, and works again when enabled', async () => {
    const onClick = vi.fn();
    const { user, getByRole, rerender } = setup(
      <Button disabled focusableWhenDisabled onClick={onClick}>
        Open
      </Button>,
    );
    await user.tab();
    await user.keyboard(' ');
    expect(onClick).not.toHaveBeenCalled();
    rerender(
      <Button focusableWhenDisabled onClick={onClick}>
        Open
      </Button>,
    );
    expect(getByRole('button').hasAttribute('aria-disabled')).toBe(false);
    await user.keyboard(' ');
    expect(onClick).toHaveBeenCalledTimes(1);
  });

  it('ignores focusableWhenDisabled while enabled: a normal button without aria-disabled', () => {
    const { getByRole } = setup(<Button focusableWhenDisabled>Open</Button>);
    expect(getByRole('button').hasAttribute('aria-disabled')).toBe(false);
    expect(getByRole('button').hasAttribute('disabled')).toBe(false);
  });
});
