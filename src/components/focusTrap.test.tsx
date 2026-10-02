// @vitest-environment jsdom
import { fireEvent, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import { setup } from '../test/render';
import { cycleTab, TAB_STOPS } from './focusTrap';

/** Two roving groups (one tab stop each, the rest tabindex -1) and a plain button between them, the way the settings popover is built. */
function Box({ withStops = true }: { withStops?: boolean }) {
  return (
    <>
      <button type="button">outside before</button>
      <div tabIndex={-1} data-testid="box" onKeyDown={(event) => cycleTab(event, event.currentTarget)}>
        {withStops && (
          <>
            <button type="button" tabIndex={-1}>
              a1
            </button>
            <button type="button" tabIndex={0}>
              a2
            </button>
            <button type="button" tabIndex={-1}>
              a3
            </button>
            <button type="button">plain</button>
            <button type="button" disabled>
              disabled
            </button>
            <button type="button" tabIndex={-1}>
              b1
            </button>
            <button type="button" tabIndex={0}>
              b2
            </button>
            <button type="button" tabIndex={-1}>
              b3
            </button>
          </>
        )}
      </div>
      <button type="button">outside after</button>
    </>
  );
}

const button = (name: string) => screen.getByRole('button', { name });

describe('cycleTab', () => {
  it('goes from the last tab stop to the first, skipping tabindex -1 buttons at the ends, and never leaves the box', async () => {
    const { user } = setup(<Box />);
    button('b2').focus();
    await user.tab();
    expect(document.activeElement).toBe(button('a2'));
  });

  it('goes from the first tab stop back to the last with Shift+Tab', async () => {
    const { user } = setup(<Box />);
    button('a2').focus();
    await user.tab({ shift: true });
    expect(document.activeElement).toBe(button('b2'));
  });

  it('also takes Shift+Tab from the box itself to the last stop', async () => {
    const { user } = setup(<Box />);
    screen.getByTestId('box').focus();
    await user.tab({ shift: true });
    expect(document.activeElement).toBe(button('b2'));
  });

  it('leaves the moves inside the box to the browser: the next stop is a plain Tab away', async () => {
    const { user } = setup(<Box />);
    button('a2').focus();
    await user.tab();
    expect(document.activeElement).toBe(button('plain'));
    await user.tab();
    // The disabled button is no stop.
    expect(document.activeElement).toBe(button('b2'));
  });

  it('does nothing for other keys and for Tab with Ctrl, Alt or Cmd (a browser or window command)', () => {
    setup(<Box />);
    button('b2').focus();
    for (const init of [
      { key: 'a' },
      { key: 'Tab', ctrlKey: true },
      { key: 'Tab', altKey: true },
      { key: 'Tab', metaKey: true },
    ]) {
      // `fireEvent` answers whether the event was left uncancelled.
      expect(fireEvent.keyDown(button('b2'), init), JSON.stringify(init)).toBe(true);
    }
    expect(document.activeElement).toBe(button('b2'));
  });

  it('keeps focus where it is when the box has nothing to land on', async () => {
    const { user } = setup(<Box withStops={false} />);
    const box = screen.getByTestId('box');
    box.focus();
    await user.tab();
    expect(document.activeElement).toBe(box);
  });
});

describe('TAB_STOPS', () => {
  it('matches what Tab stops on and nothing that is disabled or at tabindex -1', () => {
    const { container } = setup(
      <div>
        <a href="#x">link</a>
        <a>anchor without href</a>
        <a href="#y" tabIndex={-1}>
          link out of the order
        </a>
        <button type="button">button</button>
        <button type="button" disabled>
          disabled
        </button>
        <button type="button" tabIndex={-1}>
          out of the order
        </button>
        <input aria-label="field" />
        <input aria-label="skipped" tabIndex={-1} />
        <input aria-label="disabled field" disabled />
        <select aria-label="select" />
        <textarea aria-label="text" />
        <textarea aria-label="skipped text" tabIndex={-1} />
        <div tabIndex={0} aria-label="focusable div" />
        <div tabIndex={-1} aria-label="script-focusable div" />
        <span>plain text</span>
      </div>,
    );
    const names = Array.from(
      container.querySelectorAll(TAB_STOPS),
      (element) => element.textContent || element.getAttribute('aria-label'),
    );
    expect(names).toEqual(['link', 'button', 'field', 'select', 'text', 'focusable div']);
  });
});
