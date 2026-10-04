// @vitest-environment jsdom
import { screen, waitFor, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { useSettingsPopover } from '../settings/state';
import { useUi } from '../../stores/ui';
import { setup } from '../../test/render';
import { Home } from './Home';
import { filterByName, formatAge } from './recents';
import { gridTarget } from './roving';

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
  useUi.setState({ toast: null, banner: null });
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
    screen.getByRole('button', { name: 'Home' }).focus();
    await user.keyboard('{ArrowDown}');
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Recent' }));
    await user.click(screen.getByRole('button', { name: 'Settings' }));
    expect(useSettingsPopover.getState().open).toBe(true);
  });

  it('shows Show all only beyond twelve cards', async () => {
    api.listRecents.mockResolvedValue(Array.from({ length: 13 }, (_, i) => entry(i + 1, `File ${i + 1}.pdf`)));
    const { user } = setup(<Home platform="macos" />);
    await user.click(await screen.findByRole('button', { name: 'Show all' }));
    expect(screen.getByRole('heading', { level: 1, name: 'Recent' })).toBeTruthy();
    expect(screen.getAllByRole('button', { name: /^File \d+\.pdf/ })).toHaveLength(13);
  });
});
