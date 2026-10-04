// @vitest-environment jsdom
import { act, screen, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import { setup } from '../../test/render';
import { HUB_CARDS } from '../hub/cards';
import { EmptyState, type EmptyStateProps } from './EmptyState';

const props = (overrides: Partial<EmptyStateProps> = {}): EmptyStateProps => ({
  openShortcut: 'Ctrl+O',
  openKeyShortcuts: 'Control+O Meta+O',
  opening: false,
  onOpen: vi.fn(),
  onRunCard: vi.fn(),
  ...overrides,
});

const NAMES = ['Open', 'Merge', 'Split', 'Compress', 'Images to PDF', 'Sign', 'Redact', 'Fill form'];

describe('the start page tool hub (DESIGN 3.54)', () => {
  it('shows the title and the eight cards as a group of buttons named by their titles', () => {
    setup(<EmptyState {...props()} />);
    expect(screen.getByRole('heading', { level: 1, name: 'What would you like to do?' })).not.toBeNull();
    const group = screen.getByRole('group', { name: 'Tools' });
    expect(
      within(group)
        .getAllByRole('button')
        .map((button) => button.textContent?.slice(0, 3)),
    ).toHaveLength(8);
    for (const name of NAMES) expect(within(group).getByRole('button', { name })).not.toBeNull();
    expect(HUB_CARDS).toHaveLength(8);
  });

  it('describes each card with its hint and puts the initial focus on the primary Open card', () => {
    setup(<EmptyState {...props()} />);
    const open = screen.getByRole('button', { name: 'Open' });
    expect(document.activeElement).toBe(open);
    expect(open.getAttribute('aria-keyshortcuts')).toBe('Control+O Meta+O');
    const hint = document.getElementById(open.getAttribute('aria-describedby') ?? '');
    expect(hint?.textContent).toBe('Choose a PDF or drop it anywhere in this window.');
    expect(screen.getByText('Ctrl+O')).not.toBeNull();
    expect(screen.getAllByText('Several files')).toHaveLength(2); // Merge and Images to PDF
  });

  it('has a decorative floating logo in its own slot', () => {
    const { container } = setup(<EmptyState {...props()} />);
    const slot = container.querySelector('[data-logo-slot]');
    expect(slot?.getAttribute('aria-hidden')).toBe('true');
    expect(slot?.querySelector('img')?.getAttribute('alt')).toBe('');
    expect(slot?.querySelector('img')?.className).toContain('logo-float');
    expect(slot?.contains(document.activeElement)).toBe(false);
  });

  it('pauses the float while the page is hidden', () => {
    const { container } = setup(<EmptyState {...props()} />);
    const logo = container.querySelector('[data-logo-slot] img');
    expect(logo?.hasAttribute('data-paused')).toBe(false);
    const hidden = vi.spyOn(document, 'hidden', 'get').mockReturnValue(true);
    act(() => {
      document.dispatchEvent(new Event('visibilitychange'));
    });
    expect(logo?.hasAttribute('data-paused')).toBe(true);
    hidden.mockRestore();
  });

  it('Open calls the open handler, every other card its own id: with the mouse, Enter and Space', async () => {
    const onOpen = vi.fn();
    const onRunCard = vi.fn();
    const { user } = setup(<EmptyState {...props({ onOpen, onRunCard })} />);
    await user.click(screen.getByRole('button', { name: 'Open' }));
    await user.keyboard('{Enter}');
    await user.keyboard(' ');
    expect(onOpen).toHaveBeenCalledTimes(3);
    for (const name of NAMES.slice(1)) await user.click(screen.getByRole('button', { name }));
    expect(onRunCard.mock.calls.map(([id]) => id)).toEqual([
      'merge',
      'split',
      'compress',
      'images',
      'sign',
      'redact',
      'fill',
    ]);
    await user.keyboard('{Enter}');
    expect(onRunCard).toHaveBeenLastCalledWith('fill');
  });

  it('one tab stop: Tab leaves the grid, arrows rove in the order of the cards, Home and End jump', async () => {
    const { user } = setup(<EmptyState {...props()} />);
    const buttons = screen.getAllByRole('button').filter((button) => button.hasAttribute('data-hub-card'));
    expect(buttons.filter((button) => button.tabIndex === 0)).toHaveLength(1);
    await user.keyboard('{ArrowRight}');
    expect(document.activeElement).toBe(buttons[1]);
    expect(buttons[1]?.tabIndex).toBe(0);
    expect(buttons[0]?.tabIndex).toBe(-1);
    await user.keyboard('{End}');
    expect(document.activeElement).toBe(buttons[7]);
    await user.keyboard('{ArrowRight}');
    expect(document.activeElement).toBe(buttons[7]);
    await user.keyboard('{Home}');
    expect(document.activeElement).toBe(buttons[0]);
  });

  it('a busy card is aria-busy with a spinner, the others are aria-disabled and do nothing', async () => {
    const onRunCard = vi.fn();
    const { user } = setup(<EmptyState {...props({ onRunCard, busyCard: 'split' })} />);
    const split = screen.getByRole('button', { name: 'Split' });
    expect(split.getAttribute('aria-busy')).toBe('true');
    expect(split.querySelector('.animate-spin')).not.toBeNull();
    const merge = screen.getByRole('button', { name: 'Merge' });
    expect(merge.getAttribute('aria-disabled')).toBe('true');
    expect(merge.getAttribute('aria-busy')).toBeNull();
    await user.click(merge);
    expect(onRunCard).not.toHaveBeenCalled();
  });

  it('while a document is opening Open shows busy, keeps its focus and does nothing', async () => {
    const onOpen = vi.fn();
    const { user } = setup(<EmptyState {...props({ onOpen, opening: true })} />);
    const open = screen.getByRole('button', { name: 'Open' });
    expect(document.activeElement).toBe(open);
    expect(open.getAttribute('aria-busy')).toBe('true');
    expect(open.getAttribute('aria-disabled')).toBe('true');
    await user.click(open);
    await user.keyboard('{Enter}');
    expect(onOpen).not.toHaveBeenCalled();
  });

  it('the compact rule is a height media query and hides the hint only visually', () => {
    setup(<EmptyState {...props()} />);
    const open = screen.getByRole('button', { name: 'Open' });
    expect(open.className).toContain('[@media(max-height:800px)]:h-hub-compact');
    const hint = document.getElementById(open.getAttribute('aria-describedby') ?? '');
    expect(hint?.className).toContain('[@media(max-height:800px)]:sr-only');
  });

  it('omits the recents section entirely while there are none', () => {
    setup(<EmptyState {...props()} />);
    expect(screen.queryByRole('heading', { level: 2, name: 'Recent' })).toBeNull();
    expect(screen.getAllByRole('button')).toHaveLength(8);
  });

  describe('the privacy footer (DESIGN 3.11: omitted when there are no recents)', () => {
    const FOOTER = 'Recent files and their previews are stored only on this device.';

    it('is not there while the recents are empty', () => {
      const { rerender } = setup(<EmptyState {...props()} />);
      expect(screen.queryByText(FOOTER)).toBeNull();
      rerender(<EmptyState {...props({ recents: [] })} />);
      expect(screen.queryByText(FOOTER)).toBeNull();
    });

    it('comes with the first recent file, and then the section is there', () => {
      setup(
        <EmptyState
          {...props({
            recents: [
              { id: 'a', content: 'Report.pdf' },
              { id: 'b', content: 'Invoice.pdf' },
            ],
          })}
        />,
      );
      expect(screen.getByText(FOOTER)).not.toBeNull();
      const rows = screen.getAllByRole('listitem');
      expect(rows.map((row) => row.textContent)).toEqual(['Report.pdf', 'Invoice.pdf']);
    });
  });
});
