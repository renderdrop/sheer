// @vitest-environment jsdom
import { screen, waitFor, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { useSettings } from '../../stores/settings';
import { useSettingsPopover } from '../settings/state';
import { useDocuments } from '../../stores/documents';
import { useUi } from '../../stores/ui';
import { setup } from '../../test/render';
import { Home } from './Home';
import { filterByName, formatAge, visibleRecents, withoutOpen } from './recents';
import { gridTarget } from './roving';
import { ToolRows } from './ToolRows';

const api = vi.hoisted(() => ({
  listRecents: vi.fn(),
  removeRecent: vi.fn(),
  openRecent: vi.fn(),
  restoreRecent: vi.fn(),
  setRecentStarred: vi.fn(),
  revealRecent: vi.fn(),
  getRecentThumbnail: vi.fn(),
}));
const hub = vi.hoisted(() => ({ runHubCard: vi.fn() }));
const dispatch = vi.hoisted(() => ({ runAction: vi.fn() }));
vi.mock('../../api/recents', () => api);
vi.mock('../hub/run', () => hub);
vi.mock('../../actions/dispatch', () => dispatch);
vi.mock('../viewer/useViewer', () => ({
  adoptOpenOutcomes: vi.fn(),
  useViewer: (select: (state: { opening: boolean }) => unknown) => select({ opening: false }),
}));

const NOW = Math.floor(Date.now() / 1000);
const entry = (id: number, name: string, extra: object = {}) => ({
  id,
  displayName: name,
  folder: '',
  lastOpened: NOW - 7200,
  missing: false,
  starred: false,
  ...extra,
});

beforeEach(() => {
  api.listRecents.mockReset().mockResolvedValue([entry(1, 'Alpha.pdf'), entry(2, 'Beta.pdf', { starred: true })]);
  api.removeRecent.mockReset().mockResolvedValue(undefined);
  api.restoreRecent.mockReset().mockResolvedValue(true);
  api.setRecentStarred.mockReset().mockResolvedValue(undefined);
  api.revealRecent.mockReset().mockResolvedValue(undefined);
  api.openRecent.mockReset().mockResolvedValue({ type: 'openFailed' });
  api.getRecentThumbnail.mockReset().mockRejectedValue({ code: 'not_found' });
  hub.runHubCard.mockReset();
  dispatch.runAction.mockReset();
  useUi.setState({ toast: null, banner: null, view: 'home' });
  useDocuments.setState({ byId: {}, order: [], activeId: null });
  useSettingsPopover.setState({ open: false });
});

describe('the pure parts', () => {
  it('filters by display name, ignoring case', () => {
    const list = [entry(1, 'Alpha.pdf'), entry(2, 'beta.pdf')];
    expect(filterByName(list, 'ALP').map((e) => e.id)).toEqual([1]);
    expect(filterByName(list, '  ')).toHaveLength(2);
  });
  it('words the age in the locale', () => {
    expect(formatAge(NOW - 7200, NOW, 'en')).toBe('2 hours ago');
    expect(formatAge(0, NOW, 'en')).toBe('');
  });
  it('moves through a grid by rows and columns and stops at the ends', () => {
    expect(gridTarget('ArrowRight', 0, 6, 3)).toBe(1);
    expect(gridTarget('ArrowDown', 1, 6, 3)).toBe(4);
    expect(gridTarget('ArrowDown', 4, 6, 3)).toBeNull();
    expect(gridTarget('ArrowUp', 1, 6, 3)).toBeNull();
    expect(gridTarget('End', 0, 6, 3)).toBe(5);
  });
});

describe('Home', () => {
  it('shows the empty state when nothing was ever opened', async () => {
    api.listRecents.mockResolvedValue([]);
    setup(<Home platform="windows" />);
    expect(await screen.findByText('Drop a PDF here.')).toBeTruthy();
    expect(screen.queryByText('Search recent files')).toBeNull();
    await screen.findByRole('button', { name: 'Or open' });
  });

  it('lists the recent files as cards and filters them from the search field', async () => {
    const { user } = setup(<Home platform="windows" />);
    expect(await screen.findByRole('button', { name: /^Alpha\.pdf/ })).toBeTruthy();
    await user.type(screen.getByRole('searchbox'), 'bet');
    expect(screen.queryByRole('button', { name: /^Alpha\.pdf/ })).toBeNull();
    expect(screen.getByRole('button', { name: /^Beta\.pdf/ })).toBeTruthy();
  });

  it('focuses the search field with the slash key', async () => {
    const { user } = setup(<Home platform="windows" />);
    await screen.findByRole('button', { name: /^Alpha\.pdf/ });
    await user.keyboard('/');
    expect(document.activeElement).toBe(screen.getByRole('searchbox'));
  });

  it('opens a card, and the round plus runs the open action', async () => {
    const { user } = setup(<Home platform="windows" />);
    await user.click(await screen.findByRole('button', { name: /^Alpha\.pdf/ }));
    expect(api.openRecent).toHaveBeenCalledWith(1);
    await user.click(screen.getByRole('button', { name: 'Open' }));
    expect(dispatch.runAction).toHaveBeenCalledWith('open');
  });

  it('marks a file, and a refused mark is a quiet toast', async () => {
    const { user } = setup(<Home platform="windows" />);
    const card = (await screen.findByRole('button', { name: /^Alpha\.pdf/ })).closest('li') as HTMLElement;
    await user.click(within(card).getByRole('button', { name: 'Star' }));
    expect(api.setRecentStarred).toHaveBeenCalledWith(1, true);
    api.setRecentStarred.mockRejectedValueOnce({ code: 'limit' });
    await user.click(within(card).getByRole('button', { name: /Star|Remove star/ }));
    await waitFor(() => expect(useUi.getState().toast?.message).toMatch(/most starred/));
    expect(useUi.getState().banner).toBeNull();
  });

  it('the menu shows the file, and removing offers undo', async () => {
    const { user } = setup(<Home platform="windows" />);
    const card = (await screen.findByRole('button', { name: /^Alpha\.pdf/ })).closest('li') as HTMLElement;
    await user.click(within(card).getByRole('button', { name: /Actions for/ }));
    await user.click(await screen.findByRole('menuitem', { name: 'Show in Explorer' }));
    expect(api.revealRecent).toHaveBeenCalledWith(1);
    await user.click(within(card).getByRole('button', { name: /Actions for/ }));
    await user.click(await screen.findByRole('menuitem', { name: 'Remove from list' }));
    await waitFor(() => expect(useUi.getState().toast?.action?.label).toBe('Undo'));
    expect(screen.queryByRole('button', { name: /^Alpha\.pdf/ })).toBeNull();
  });

  it('Delete on a focused card removes it', async () => {
    const { user } = setup(<Home platform="windows" />);
    (await screen.findByRole('button', { name: /^Alpha\.pdf/ })).focus();
    await user.keyboard('{Delete}');
    expect(api.removeRecent).toHaveBeenCalledWith(1);
  });

  it('switches views from the nav and lists the tools with their hub card', async () => {
    const { user } = setup(<Home platform="windows" />);
    await screen.findByRole('button', { name: /^Alpha\.pdf/ });
    await user.click(screen.getByRole('button', { name: 'Starred' }));
    expect(screen.getByRole('heading', { level: 1, name: 'Starred' })).toBeTruthy();
    expect(screen.queryByRole('button', { name: /^Alpha\.pdf/ })).toBeNull();
    await user.click(screen.getByRole('button', { name: 'Tools' }));
    await user.click(screen.getByRole('button', { name: /Merge/ }));
    expect(hub.runHubCard).toHaveBeenCalledWith('merge');
    expect(screen.getByRole('button', { name: /Export as images/ })).toBeTruthy();
  });

  it('Settings opens the settings popover; arrows move between the nav rows', async () => {
    const { user } = setup(<Home platform="windows" />);
    await screen.findByRole('button', { name: /^Alpha\.pdf/ });
    screen.getByRole('button', { name: 'Start' }).focus();
    await user.keyboard('{ArrowDown}');
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Recent' }));
    await user.click(screen.getByRole('button', { name: 'Settings' }));
    expect(useSettingsPopover.getState().open).toBe(true);
  });

  it('shows one row of five recent cards; Show all leads to the Recent view', async () => {
    api.listRecents.mockResolvedValue(Array.from({ length: 13 }, (_, i) => entry(i + 1, `File ${i + 1}.pdf`)));
    const { user } = setup(<Home platform="macos" />);
    await screen.findByRole('button', { name: /^File 1\.pdf/ });
    // Without layout (jsdom) five columns are assumed: one row is five cards.
    expect(screen.getAllByRole('button', { name: /^File \d+\.pdf/ })).toHaveLength(5);
    await user.click(screen.getByRole('button', { name: 'Show all' }));
    expect(screen.getByRole('heading', { level: 1, name: 'Recent' })).toBeTruthy();
    expect(screen.getAllByRole('button', { name: /^File \d+\.pdf/ })).toHaveLength(13);
  });

  it('greets by time of day, with the author name when the settings have one', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date(2026, 0, 1, 9, 0));
    try {
      useSettings.setState({ authorName: 'Ada' });
      const { unmount } = setup(<Home platform="windows" />);
      expect(await screen.findByText('Good morning, Ada.')).toBeTruthy();
      unmount();
      useSettings.setState({ authorName: '' });
      setup(<Home platform="windows" />);
      expect(await screen.findByText('Good morning.')).toBeTruthy();
    } finally {
      vi.useRealTimers();
      useSettings.setState({ authorName: '' });
    }
  });

  it('has no key chip in the search, shows the eight tiles and More tools leads to the tools view', async () => {
    const { user, container } = setup(<Home platform="windows" />);
    await screen.findByRole('button', { name: /^Alpha.pdf/ });
    expect(container.querySelector('[data-home-hero] kbd')).toBeNull();
    expect(container.querySelectorAll('[data-home-tools] li')).toHaveLength(8);
    await user.click(screen.getByRole('button', { name: /More tools/ }));
    expect(screen.getByRole('heading', { level: 1, name: 'Tools' })).toBeTruthy();
  });

  it('never truncates tile text with an ellipsis and describes each tile by its full subtitle', async () => {
    const { container } = setup(<Home platform="windows" />);
    await screen.findByRole('button', { name: /^Alpha.pdf/ });
    const tiles = container.querySelectorAll('[data-home-tools] button');
    expect(tiles.length).toBe(8);
    for (const tile of tiles) {
      expect(tile.querySelector('.truncate')).toBeNull();
      const sub = tile.querySelector('.home-tile-sub');
      expect(sub?.id).toBeTruthy();
      expect(tile.getAttribute('aria-describedby')).toBe(sub?.id);
    }
  });

  it('shows three tool tiles and More tools in the tightest fit', () => {
    const { container } = setup(<ToolRows few />);
    const names = [...container.querySelectorAll('[data-home-tools] button')].map(
      (tile) => tile.querySelector('.home-tile-title')?.textContent,
    );
    expect(names).toHaveLength(4);
    expect(names[3]).toBe('More tools');
  });

  it('offers no Show all when the recents fit in two rows', async () => {
    setup(<Home platform="macos" />);
    await screen.findByRole('button', { name: /^Alpha\.pdf/ });
    expect(screen.queryByRole('button', { name: 'Show all' })).toBeNull();
  });

  it('hides the Open section without tabs and lists open tabs above Recent without duplicating them', async () => {
    const { user } = setup(<Home platform="windows" />);
    await screen.findByRole('button', { name: /^Alpha\.pdf/ });
    expect(screen.queryByRole('heading', { name: 'Open' })).toBeNull();
    useDocuments.setState({
      byId: {
        7: { id: 7, pageCount: 1, displayName: 'Alpha.pdf' },
        8: { id: 8, pageCount: 2, displayName: 'Gamma.pdf' },
      },
      order: [7, 8],
      activeId: 8,
    });
    const heading = await screen.findByRole('heading', { name: 'Open' });
    const list = within(heading.closest('section') as HTMLElement);
    expect(
      list.getAllByRole('button', { name: /^(Alpha|Gamma).pdf$/ }).map((b) => b.getAttribute('aria-label')),
    ).toEqual(['Alpha.pdf', 'Gamma.pdf']);
    expect(list.getAllByRole('button', { name: /^Actions for/ })).toHaveLength(2);
    // Alpha is open: it is not listed again under Recent.
    expect(screen.getAllByRole('button', { name: /^Alpha\.pdf/ })).toHaveLength(1);
    await user.click(list.getByRole('button', { name: 'Alpha.pdf' }));
    expect(useDocuments.getState().activeId).toBe(7);
    expect(useUi.getState().view).toBe('editor');
  });

  it('shows Home, not the empty state, when only tabs are open; arrows rove through the Open cards', async () => {
    api.listRecents.mockResolvedValue([]);
    useDocuments.setState({
      byId: { 1: { id: 1, pageCount: 1, displayName: 'One.pdf' }, 2: { id: 2, pageCount: 1, displayName: 'Two.pdf' } },
      order: [1, 2],
      activeId: 1,
    });
    const { user } = setup(<Home platform="windows" />);
    (await screen.findByRole('button', { name: 'One.pdf' })).focus();
    await user.keyboard('{ArrowRight}');
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Two.pdf' }));
  });
});

describe('the Recent window', () => {
  it('takes one row of the column count and drops open files', () => {
    const list = Array.from({ length: 10 }, (_, i) => entry(i, `F${i}`));
    expect(visibleRecents(list, 3, false)).toHaveLength(3);
    expect(visibleRecents(list, 3, true)).toHaveLength(10);
    expect(visibleRecents(list, 0, false)).toHaveLength(1);
    expect(withoutOpen(list, ['F1', 'F2']).map((e) => e.id)).not.toContain(1);
  });
});

describe('Home empty state', () => {
  it('fills the column, focuses the Ghost open button first, and styles the nav in Ink', async () => {
    api.listRecents.mockResolvedValue([]);
    const { container } = setup(<Home platform="windows" />);
    const button = await screen.findByRole('button', { name: 'Or open' });
    // The first Tab stop of a fresh window is Open (v1.1 behaviour, Shell tests); its ring is the keyboard focus cue.
    expect(document.activeElement).toBe(button);
    const area = container.querySelector('[data-home-empty]');
    expect(area?.className).toContain('flex-1');
    expect(area?.className).toContain('p-8');
    expect(container.querySelector('[data-home-nav] svg')?.parentElement?.className).toContain('text-ink');
    expect(screen.getByRole('button', { name: 'Start' }).className).toContain('text-ink');
  });
});
