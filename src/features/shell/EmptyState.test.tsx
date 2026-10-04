// @vitest-environment jsdom
import { act, fireEvent, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import { setup } from '../../test/render';
import { EmptyState, type EmptyStateProps } from './EmptyState';

const props = (overrides: Partial<EmptyStateProps> = {}): EmptyStateProps => ({
  openShortcut: 'Ctrl+O',
  openKeyShortcuts: 'Control+O Meta+O',
  opening: false,
  onOpen: vi.fn(),
  ...overrides,
});

describe('EmptyState (DESIGN 3.11)', () => {
  it('puts the initial focus on the Open button, the keyboard path', () => {
    setup(<EmptyState {...props()} />);
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Open…' }));
  });

  it('shows the card: a heading, the hint, the primary Open button with its shortcut chip', () => {
    setup(<EmptyState {...props({ openShortcut: '⌘O' })} />);
    expect(screen.getByRole('heading', { level: 1, name: 'Open a PDF' })).not.toBeNull();
    expect(screen.getByText('Drop a file anywhere in this window or choose one.')).not.toBeNull();
    expect(screen.getByText('⌘O')).not.toBeNull();
    expect(screen.getByRole('button', { name: 'Open…' }).getAttribute('aria-keyshortcuts')).toBe('Control+O Meta+O');
  });

  it('has a decorative floating logo in its own slot, and no icon tile in the card', () => {
    const { container } = setup(<EmptyState {...props()} />);
    const slot = container.querySelector('[data-logo-slot]');
    expect(slot?.getAttribute('aria-hidden')).toBe('true');
    const logo = slot?.querySelector('img');
    expect(logo?.getAttribute('alt')).toBe('');
    expect(logo?.className).toContain('logo-float');
    // Only the ghost images button (DESIGN 3.43) carries an icon.
    expect(container.querySelectorAll('[data-drop-zone] svg')).toHaveLength(1);
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

  it('Open calls the open handler: with the mouse, Enter and Space', async () => {
    const onOpen = vi.fn();
    const { user } = setup(<EmptyState {...props({ onOpen })} />);
    const open = screen.getByRole('button', { name: 'Open…' });
    await user.click(open);
    await user.keyboard('{Enter}');
    await user.keyboard(' ');
    expect(onOpen).toHaveBeenCalledTimes(3);
  });

  it('while a document is opening the button says so, does nothing and keeps the focus', async () => {
    const onOpen = vi.fn();
    const { user } = setup(<EmptyState {...props({ onOpen, opening: true })} />);
    const button = screen.getByRole('button', { name: 'Opening…' });
    expect(document.activeElement).toBe(button);
    expect(button.getAttribute('aria-disabled')).toBe('true');
    await user.click(button);
    await user.keyboard('{Enter}');
    expect(onOpen).not.toHaveBeenCalled();
  });

  it('omits the recents section entirely while there are none', () => {
    setup(<EmptyState {...props()} />);
    expect(screen.queryByRole('heading', { level: 2, name: 'Recent' })).toBeNull();
    expect(screen.getAllByRole('button')).toHaveLength(2); // Open and the ghost images button
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
      expect(screen.queryByText('Files you open appear here.')).toBeNull();
      const rows = screen.getAllByRole('listitem');
      expect(rows.map((row) => row.textContent)).toEqual(['Report.pdf', 'Invoice.pdf']);
    });
  });

  describe('the drop zone is visual only', () => {
    it('at rest it says "Open a PDF" and has no drop look', () => {
      const { container } = setup(<EmptyState {...props()} />);
      expect(container.querySelector('[data-drop-zone]')?.hasAttribute('data-drop-active')).toBe(false);
      expect(screen.queryByText('Drop to open')).toBeNull();
    });

    it('while a file is dragged over, the title says "Drop to open" and the card takes the selected look', () => {
      const { container } = setup(<EmptyState {...props({ dropActive: true })} />);
      expect(screen.getByRole('heading', { level: 1, name: 'Drop to open' })).not.toBeNull();
      const zone = container.querySelector('[data-drop-zone]');
      expect(zone?.getAttribute('data-drop-active')).toBe('true');
      // The 2 px accent ring over the selected fill is a decorative layer, not part of the content.
      expect(zone?.querySelector('[aria-hidden="true"].inset-ring-accent')).not.toBeNull();
    });

    it('does not read what is dropped: no handler in the webview looks at the payload (SECURITY I2)', () => {
      const { container } = setup(<EmptyState {...props()} />);
      const zone = container.querySelector('[data-drop-zone]');
      expect(zone).not.toBeNull();
      const dataTransfer = { files: [], items: [], types: ['Files'], getData: vi.fn() };
      const drop = new Event('drop', { bubbles: true, cancelable: true });
      Object.defineProperty(drop, 'dataTransfer', { value: dataTransfer });
      if (zone !== null) fireEvent(zone, drop);
      // Rust takes the OS drop (dragDropEnabled); the page neither reads nor handles it.
      expect(dataTransfer.getData).not.toHaveBeenCalled();
    });
  });
});
