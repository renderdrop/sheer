// @vitest-environment jsdom
import { act, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { setup } from '../../test/render';
import { ANNOUNCE_DELAY_MS, StatusBar, type StatusBarProps } from './StatusBar';

const NBSP = String.fromCharCode(0xa0);

const props = (overrides: Partial<StatusBarProps> = {}): StatusBarProps => ({
  fileName: 'Report.pdf',
  pageIndex: 2,
  pageCount: 120,
  zoom: 1.25,
  rendering: false,
  onGoToPage: vi.fn(),
  onZoom: vi.fn(),
  ...overrides,
});

afterEach(() => {
  vi.useRealTimers();
});

describe('the Edited badge (DESIGN 3.10, 3.27)', () => {
  it('shows after the name while the document has unsaved changes, and not otherwise', () => {
    const { container, rerender } = setup(<StatusBar {...props({ edited: true })} />);
    expect(container.querySelector('[data-edited]')?.textContent).toBe('Edited');
    rerender(<StatusBar {...props({ edited: false })} />);
    expect(container.querySelector('[data-edited]')).toBeNull();
    rerender(<StatusBar {...props({ fileName: null, edited: true })} />);
    expect(container.querySelector('[data-edited]')).toBeNull();
  });
});

describe('StatusBar formatting (DESIGN 3.10)', () => {
  it('shows the file name, the page as "3 / 120" and the zoom as "125 %"', () => {
    const { container } = setup(<StatusBar {...props()} />);
    expect(container.querySelector('footer')?.getAttribute('aria-label')).toBe('Status');
    // The full name is there for assistive technology, once.
    expect(screen.getAllByText('Report.pdf').length).toBeGreaterThanOrEqual(1);
    expect(screen.getByRole('button', { name: /^3 \/ 120/ }).textContent).toBe('3 / 120');
    expect(screen.getByRole('button', { name: new RegExp(`^125${NBSP}%`) }).textContent).toBe(`125${NBSP}%`);
  });

  it('the buttons say what they open, and keep their visible text in the name', () => {
    setup(<StatusBar {...props()} />);
    expect(screen.getByRole('button', { name: '3 / 120 · Go to page' })).not.toBeNull();
    expect(screen.getByRole('button', { name: `125${NBSP}% · Zoom level` })).not.toBeNull();
  });

  it('a long name keeps its end visible: the head may be cut, the tail never is', () => {
    const name = 'Quarterly report 2024 final version.pdf';
    const { container } = setup(<StatusBar {...props({ fileName: name })} />);
    const visible = [...container.querySelectorAll('footer span[aria-hidden="true"]')].map((part) => part.textContent);
    expect(visible.join('')).toBe(name);
    expect(visible[1]).toBe('sion.pdf');
    expect(visible[0]?.endsWith('final ver')).toBe(true);
  });

  it('the name takes at most 40 % of the bar, so the page and zoom buttons always fit', () => {
    const { container } = setup(<StatusBar {...props({ fileName: 'x'.repeat(255) })} />);
    const holder = container.querySelector('footer [aria-hidden="true"]')?.parentElement;
    expect(holder?.className).toContain('max-w-status-name');
    expect(holder?.className).toContain('min-w-0');
    // Only the head can be cut by CSS; the tail is shrink-0.
    const [head, tail] = [...container.querySelectorAll('footer [aria-hidden="true"]')];
    expect(head?.className).toContain('truncate');
    expect(tail?.className).toContain('shrink-0');
  });

  it('a name at the 255 character limit loses no character, and a short one is not split', () => {
    const long = `${'n'.repeat(251)}.pdf`;
    const { container, rerender } = setup(<StatusBar {...props({ fileName: long })} />);
    const visible = () =>
      [...container.querySelectorAll('footer span[aria-hidden="true"]')].map((part) => part.textContent ?? '');
    expect(visible().join('')).toBe(long);
    expect(visible()[1]).toBe('nnnn.pdf');
    rerender(<StatusBar {...props({ fileName: 'a.pdf' })} />);
    expect(visible()).toEqual(['a.pdf', '']);
  });

  it('shows the name as plain text: markup in a file name never becomes an element', () => {
    const name = '<img src=x onerror=alert(1)>.pdf';
    const { container } = setup(<StatusBar {...props({ fileName: name })} />);
    expect(container.querySelector('footer img')).toBeNull();
    expect(screen.getAllByText(name).length).toBeGreaterThanOrEqual(1);
  });

  it('page and zoom follow their props at once: first page, last page, a single page, the zoom ends', () => {
    const { rerender } = setup(<StatusBar {...props({ pageIndex: 0, pageCount: 1, zoom: 0.25 })} />);
    expect(screen.getByRole('button', { name: /Go to page/ }).textContent).toBe('1 / 1');
    expect(screen.getByRole('button', { name: /Zoom level/ }).textContent).toBe(`25${NBSP}%`);
    rerender(<StatusBar {...props({ pageIndex: 119, pageCount: 120, zoom: 4 })} />);
    expect(screen.getByRole('button', { name: /Go to page/ }).textContent).toBe('120 / 120');
    expect(screen.getByRole('button', { name: /Zoom level/ }).textContent).toBe(`400${NBSP}%`);
  });

  it('an empty name from the backend is shown as "Untitled"', () => {
    setup(<StatusBar {...props({ fileName: '' })} />);
    expect(screen.getAllByText('Untitled').length).toBeGreaterThanOrEqual(1);
  });

  it('without a document the bar is empty: no name, no page, no zoom', () => {
    const { container } = setup(<StatusBar {...props({ fileName: null })} />);
    expect(screen.queryByRole('button')).toBeNull();
    expect(container.querySelector('footer')?.textContent).toBe('');
  });

  it('a document without pages has a zoom but no page button', () => {
    setup(<StatusBar {...props({ pageCount: 0, pageIndex: 0 })} />);
    expect(screen.queryByRole('button', { name: /Go to page/ })).toBeNull();
    expect(screen.getByRole('button', { name: /Zoom level/ })).not.toBeNull();
  });

  it('shows what the viewer is doing while it renders', () => {
    const { rerender } = setup(<StatusBar {...props()} />);
    expect(screen.queryByText('Rendering…')).toBeNull();
    rerender(<StatusBar {...props({ rendering: true })} />);
    expect(screen.getByText('Rendering…').getAttribute('role')).toBe('status');
  });
});

describe('the page announcement', () => {
  it('says "Page 3 of 120" in a polite live region only after the page has been still for 500 ms', () => {
    vi.useFakeTimers();
    const { rerender } = setup(<StatusBar {...props({ pageIndex: 0 })} />);
    const announcement = () =>
      screen
        .getAllByRole('status')
        .map((region) => region.textContent)
        .find((text) => text?.startsWith('Page'));
    expect(announcement()).toBe('Page 1 of 120');

    // Scrolling through pages: nothing is announced until it settles.
    for (const pageIndex of [1, 2, 3, 4]) {
      rerender(<StatusBar {...props({ pageIndex })} />);
      act(() => {
        vi.advanceTimersByTime(ANNOUNCE_DELAY_MS - 100);
      });
      expect(announcement()).toBe('Page 1 of 120');
    }
    act(() => {
      vi.advanceTimersByTime(100);
    });
    expect(announcement()).toBe('Page 5 of 120');
  });

  it('is announced politely and visually hidden, apart from the visible page number', () => {
    setup(<StatusBar {...props()} />);
    const region = screen.getAllByRole('status').find((element) => element.textContent?.startsWith('Page'));
    expect(region?.className).toContain('sr-only');
  });
});

describe('Go to page', () => {
  it('opens a popover with the current page, and Go reports the zero-based page and closes it', async () => {
    const onGoToPage = vi.fn();
    const { user } = setup(<StatusBar {...props({ onGoToPage })} />);
    await user.click(screen.getByRole('button', { name: /Go to page/ }));
    const dialog = screen.getByRole('dialog', { name: 'Go to page' });
    const field = within(dialog).getByLabelText('Page number') as HTMLInputElement;
    expect(field.value).toBe('3');
    expect(document.activeElement).toBe(field);

    await user.clear(field);
    await user.type(field, '42');
    await user.keyboard('{Enter}');
    expect(onGoToPage).toHaveBeenCalledWith(41);
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('Esc closes it without going anywhere, and gives the focus back to the page button', async () => {
    const onGoToPage = vi.fn();
    const { user } = setup(<StatusBar {...props({ onGoToPage })} />);
    const button = screen.getByRole('button', { name: /Go to page/ });
    await user.click(button);
    await user.keyboard('{Escape}');
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(onGoToPage).not.toHaveBeenCalled();
    expect(document.activeElement).toBe(button);
  });

  it('a field that is not a number goes nowhere', async () => {
    const onGoToPage = vi.fn();
    const { user } = setup(<StatusBar {...props({ onGoToPage })} />);
    await user.click(screen.getByRole('button', { name: /Go to page/ }));
    await user.clear(screen.getByLabelText('Page number'));
    await user.keyboard('{Enter}');
    expect(onGoToPage).not.toHaveBeenCalled();
  });
});

describe('the zoom menu', () => {
  it('lists the presets, checks the current one and sets the one that is chosen', async () => {
    const onZoom = vi.fn();
    const { user } = setup(<StatusBar {...props({ onZoom, zoom: 1.25 })} />);
    await user.click(screen.getByRole('button', { name: /Zoom level/ }));
    const menu = screen.getByRole('menu', { name: 'Zoom' });
    const checked = within(menu).getAllByRole('menuitemcheckbox', { checked: true });
    expect(checked.map((item) => item.textContent)).toEqual([`125${NBSP}%`]);
    await user.click(within(menu).getByRole('menuitemcheckbox', { name: `200${NBSP}%` }));
    expect(onZoom).toHaveBeenCalledWith(2);
  });
});

describe('Go to page: input outside the document and the rotation chip (DESIGN 3.20)', () => {
  it('shows "of n" and keeps the popover open with a message for a number outside 1 to n', async () => {
    const onGoToPage = vi.fn();
    const { user } = setup(<StatusBar {...props({ onGoToPage })} />);
    await user.click(screen.getByRole('button', { name: /Go to page/ }));
    const dialog = screen.getByRole('dialog', { name: 'Go to page' });
    expect(within(dialog).getByText('of 120')).not.toBeNull();
    const field = within(dialog).getByLabelText('Page number');
    for (const typed of ['0', '121', 'abc', '']) {
      await user.clear(field);
      if (typed !== '') await user.type(field, typed);
      await user.keyboard('{Enter}');
      expect(field.getAttribute('aria-invalid'), typed).toBe('true');
      expect(within(dialog).getByRole('alert').textContent).toBe('Enter a number from 1 to 120.');
    }
    expect(onGoToPage).not.toHaveBeenCalled();
    // Typing again clears the message; a good number goes there and closes.
    await user.clear(field);
    await user.type(field, '120');
    expect(field.getAttribute('aria-invalid')).toBeNull();
    await user.click(within(dialog).getByRole('button', { name: 'Go' }));
    expect(onGoToPage).toHaveBeenCalledWith(119);
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('can be opened from outside (the go-to-page action) and tells the owner when it closes', async () => {
    const onGoToOpenChange = vi.fn();
    const { rerender, user } = setup(<StatusBar {...props({ goToOpen: false, onGoToOpenChange })} />);
    expect(screen.queryByRole('dialog')).toBeNull();
    rerender(<StatusBar {...props({ goToOpen: true, onGoToOpenChange })} />);
    const field = within(screen.getByRole('dialog', { name: 'Go to page' })).getByLabelText('Page number');
    expect((field as HTMLInputElement).value).toBe('3');
    await user.keyboard('{Escape}');
    expect(onGoToOpenChange).toHaveBeenCalledWith(false);
  });

  it('shows a reset button with the angle only while the view is turned', async () => {
    const onResetRotation = vi.fn();
    const { rerender, user } = setup(<StatusBar {...props({ rotation: 0, onResetRotation })} />);
    expect(screen.queryByRole('button', { name: 'Reset rotation' })).toBeNull();
    rerender(<StatusBar {...props({ rotation: 90, onResetRotation })} />);
    const reset = screen.getByRole('button', { name: 'Reset rotation' });
    expect(reset.textContent).toBe('90°');
    await user.click(reset);
    expect(onResetRotation).toHaveBeenCalledTimes(1);
  });
});

describe('the save hints', () => {
  it('say Saving… and Saved in the live region, ahead of the render activity', () => {
    const { rerender } = setup(<StatusBar {...props({ rendering: true, saveHint: 'saving' })} />);
    expect(screen.getByText('Saving…').getAttribute('role')).toBe('status');
    expect(screen.queryByText('Rendering…')).toBeNull();
    rerender(<StatusBar {...props({ rendering: true, saveHint: 'saved' })} />);
    expect(screen.getByText('Saved')).toBeTruthy();
    rerender(<StatusBar {...props({ rendering: true, saveHint: null })} />);
    expect(screen.getByText('Rendering…')).toBeTruthy();
  });
});

describe('the zoom buttons beside the readout (DESIGN 3.55)', () => {
  it('step the zoom out and in, and are disabled at the limits', async () => {
    const onZoomStep = vi.fn();
    const { user } = setup(<StatusBar {...props({ onZoomStep })} />);
    await user.click(screen.getByRole('button', { name: 'Zoom out' }));
    await user.click(screen.getByRole('button', { name: 'Zoom in' }));
    expect(onZoomStep.mock.calls).toEqual([[-1], [1]]);
  });

  it('disable the button that cannot go on', () => {
    setup(<StatusBar {...props({ zoom: 0.25 })} />);
    expect(screen.getByRole('button', { name: 'Zoom out' }).getAttribute('aria-disabled')).toBe('true');
    expect(screen.getByRole('button', { name: 'Zoom in' }).getAttribute('aria-disabled')).toBeNull();
  });
});
