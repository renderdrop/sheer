// @vitest-environment jsdom
import { act, fireEvent, screen, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { setup } from '../../test/render';
import { useDocuments } from '../../stores/documents';
import { useUi } from '../../stores/ui';
import { MenuBar } from './MenuBar';

vi.mock('../../api/recents', () => ({
  listRecents: vi.fn().mockResolvedValue([]),
  openRecent: vi.fn(),
  removeRecent: vi.fn(),
}));

beforeEach(() => {
  useDocuments.setState({ activeId: null, order: [], byId: {} });
  useUi.setState({ mode: 'read' });
});

const items = () => screen.getAllByRole('menuitem', { name: /^(File|Edit|View|Tools|Help)$/ });
const labelsOf = (menu: HTMLElement) =>
  [...menu.querySelectorAll('[role^="menuitem"]')].map((entry) => entry.getAttribute('data-label'));

describe('the Windows menu bar (DESIGN 3.56)', () => {
  it('is a menubar with File, Edit, View, Tools and Help, none of them a tab stop, with their access keys', () => {
    setup(<MenuBar />);
    expect(screen.getByRole('menubar', { name: 'Application menu' })).not.toBeNull();
    expect(items().map((item) => item.textContent)).toEqual(['File', 'Edit', 'View', 'Tools', 'Help']);
    for (const item of items()) expect(item.tabIndex).toBe(-1);
    expect(items().map((item) => item.getAttribute('aria-keyshortcuts'))).toEqual([
      'Alt+F',
      'Alt+E',
      'Alt+V',
      'Alt+T',
      'Alt+H',
    ]);
    expect(items().every((item) => item.getAttribute('aria-haspopup') === 'menu')).toBe(true);
  });

  it('opens File with a click and lists the commands of the design, Flatten form and Exit included', async () => {
    const { user } = setup(<MenuBar />);
    await user.click(screen.getByRole('menuitem', { name: 'File' }));
    const menu = await screen.findByRole('menu', { name: 'File' });
    expect(labelsOf(menu)).toEqual([
      'Open…',
      'Save',
      'Save As…',
      'Export Copy…',
      'Export Images…',
      'Create PDF From Images…',
      'Compress…',
      'Flatten Form…',
      'Protect…',
      'Document Properties…',
      'Signatures…',
      'Copy Citation List',
      'Save Citation List…',
      'Print…',
      'Close Document',
      'Settings…',
      'Exit',
    ]);
  });

  it('has the Tools menu with the five modes as radio items, the active one checked, and no tools', async () => {
    const { user } = setup(<MenuBar />);
    await user.click(screen.getByRole('menuitem', { name: 'Tools' }));
    const menu = await screen.findByRole('menu', { name: 'Tools' });
    expect(labelsOf(menu)).toEqual([
      'Read',
      'Comment',
      'Fill & Sign',
      'Pages',
      'Edit',
      'Highlight Form Fields',
      'Manage Signatures…',
    ]);
    const radios = within(menu).getAllByRole('menuitemradio');
    expect(radios.map((radio) => radio.getAttribute('aria-checked'))).toEqual([
      'true',
      'false',
      'false',
      'false',
      'false',
    ]);
  });

  it('moves between the titles with Left and Right (wrapping) and opens with Down', async () => {
    const { user } = setup(<MenuBar />);
    act(() => items()[0]?.focus());
    await user.keyboard('{ArrowRight}');
    expect(document.activeElement).toBe(items()[1]);
    await user.keyboard('{ArrowLeft}{ArrowLeft}');
    expect(document.activeElement).toBe(items()[4]);
    await user.keyboard('{ArrowDown}');
    expect(await screen.findByRole('menu', { name: 'Help' })).not.toBeNull();
  });

  it('Left and Right inside an open menu open the neighbour, and Esc returns to the title', async () => {
    const { user } = setup(<MenuBar />);
    await user.click(screen.getByRole('menuitem', { name: 'Edit' }));
    await screen.findByRole('menu', { name: 'Edit' });
    await user.keyboard('{ArrowRight}');
    expect(await screen.findByRole('menu', { name: 'View' })).not.toBeNull();
    await user.keyboard('{Escape}');
    expect(document.activeElement).toBe(screen.getByRole('menuitem', { name: 'View' }));
  });

  it('Alt pressed and released alone, and F10, focus File without opening a menu', () => {
    setup(<MenuBar />);
    fireEvent.keyDown(window, { key: 'Alt', altKey: true });
    fireEvent.keyUp(window, { key: 'Alt' });
    expect(document.activeElement).toBe(items()[0]);
    expect(screen.queryByRole('menu')).toBeNull();
    // A second Alt gives focus back.
    fireEvent.keyDown(window, { key: 'Alt', altKey: true });
    fireEvent.keyUp(window, { key: 'Alt' });
    expect(document.activeElement).not.toBe(items()[0]);
    fireEvent.keyDown(window, { key: 'F10' });
    expect(document.activeElement).toBe(items()[0]);
  });

  it('Alt with an access key opens that menu, and Ctrl+Alt (AltGr) does not', async () => {
    setup(<MenuBar />);
    fireEvent.keyDown(window, { key: 'v', altKey: true, ctrlKey: true });
    expect(screen.queryByRole('menu')).toBeNull();
    fireEvent.keyDown(window, { key: 'v', altKey: true });
    expect(await screen.findByRole('menu', { name: 'View' })).not.toBeNull();
  });

  it('underlines the access key only while Alt is held', () => {
    setup(<MenuBar />);
    const underlined = () => items().map((item) => item.querySelector('.underline')?.textContent ?? null);
    expect(underlined()).toEqual([null, null, null, null, null]);
    fireEvent.keyDown(window, { key: 'Alt', altKey: true });
    expect(underlined()).toEqual(['F', 'E', 'V', 'T', 'H']);
    fireEvent.keyUp(window, { key: 'Alt' });
    expect(underlined()).toEqual([null, null, null, null, null]);
  });

  it('greys the commands that need a document without one, and keeps them focusable', async () => {
    const { user } = setup(<MenuBar />);
    await user.click(screen.getByRole('menuitem', { name: 'File' }));
    const menu = await screen.findByRole('menu', { name: 'File' });
    const entry = (label: string) =>
      [...menu.querySelectorAll('[role^="menuitem"]')].find(
        (candidate) => candidate.getAttribute('data-label') === label,
      );
    expect(entry('Save')?.getAttribute('aria-disabled')).toBe('true');
    expect(entry('Open…')?.getAttribute('aria-disabled')).toBeNull();
  });
});
