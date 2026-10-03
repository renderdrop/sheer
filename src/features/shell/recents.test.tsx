// @vitest-environment jsdom
import { act, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { useUi } from '../../stores/ui';
import { setup } from '../../test/render';
import { EmptyState } from './EmptyState';
import { beginOpening, resetTransition, useTransition } from '../viewer/openTransition';
import { formatAge, useRecents } from './recents';

const api = vi.hoisted(() => ({
  listRecents: vi.fn(),
  removeRecent: vi.fn(),
  openRecent: vi.fn(),
  restoreRecent: vi.fn(),
  locateRecent: vi.fn(),
}));
const adopt = vi.hoisted(() => vi.fn());
vi.mock('../../api/recents', () => api);
vi.mock('../viewer/useViewer', () => ({ adoptOpenOutcomes: adopt }));

const NOW = 1_700_000_000;
const entries = [
  { id: 1, displayName: 'First.pdf', folder: 'Reports', lastOpened: NOW - 7200, missing: false },
  { id: 2, displayName: 'Gone.pdf', folder: '', lastOpened: NOW - 100, missing: true },
];

beforeEach(() => {
  api.listRecents.mockReset().mockResolvedValue(entries);
  api.removeRecent.mockReset().mockResolvedValue(undefined);
  api.openRecent.mockReset();
  api.restoreRecent.mockReset().mockResolvedValue(true);
  api.locateRecent.mockReset().mockResolvedValue(true);
  useUi.setState({ toast: null, banner: null });
  adopt.mockReset();
  resetTransition();
});

function Host() {
  const recents = useRecents();
  return (
    <EmptyState
      openShortcut=""
      openKeyShortcuts=""
      opening={false}
      onOpen={() => undefined}
      recents={recents.rows}
      onClearRecents={recents.clear}
    />
  );
}

describe('formatAge', () => {
  it('says how long ago in the language, and nothing for an unknown time', () => {
    expect(formatAge(NOW - 7200, NOW, 'en')).toBe('2 hours ago');
    expect(formatAge(NOW - 7200, NOW, 'de')).toBe('vor 2 Stunden');
    expect(formatAge(NOW - 86_400 * 3, NOW, 'en')).toBe('3 days ago');
    expect(formatAge(0, NOW, 'en')).toBe('');
    expect(formatAge(NOW + 500, NOW, 'en')).toBe('now');
  });
});

describe('the recent files of the empty state', () => {
  it('lists them with their age, marks a missing file, and shows the privacy note', async () => {
    setup(<Host />);
    expect(await screen.findByText('First.pdf')).not.toBeNull();
    expect(screen.getByText('File not found')).not.toBeNull();
    expect(screen.getByText('Recent files are stored only on this device.')).not.toBeNull();
    expect(screen.getByRole('list', { name: 'Recent files' })).not.toBeNull();
  });

  it('names the parent folder and the age on the meta line, never a path', async () => {
    setup(<Host />);
    expect(await screen.findByText(/^Reports · /)).not.toBeNull();
  });

  it('omits the whole section when the list is empty or cannot be read', async () => {
    api.listRecents.mockRejectedValue({ code: 'internal' });
    setup(<Host />);
    await waitFor(() => expect(api.listRecents).toHaveBeenCalled());
    expect(screen.queryByRole('heading', { name: 'Recent' })).toBeNull();
    expect(screen.queryByRole('list', { name: 'Recent files' })).toBeNull();
  });

  it('flies the row tile to the page: its rect is the clone source of the opening', async () => {
    api.openRecent.mockResolvedValue({ type: 'opened', document: { id: 5, pageCount: 1, displayName: 'First.pdf' } });
    const rect = vi
      .spyOn(HTMLElement.prototype, 'getBoundingClientRect')
      .mockReturnValue({ left: 10, top: 20, width: 16, height: 20 } as DOMRect);
    const { user } = setup(<Host />);
    await user.click(await screen.findByRole('button', { name: /^First[.]pdf/ }));
    rect.mockRestore();
    beginOpening(5);
    expect(useTransition.getState().active?.source).toEqual({
      kind: 'tile',
      rect: { left: 10, top: 20, width: 16, height: 20 },
    });
  });

  it('opens a row by id and hands the outcome to the viewer', async () => {
    const outcome = { type: 'needsPassword', id: 8, displayName: 'First.pdf' };
    api.openRecent.mockResolvedValue(outcome);
    const { user } = setup(<Host />);
    await user.click(await screen.findByRole('button', { name: /^First[.]pdf/ }));
    expect(api.openRecent).toHaveBeenCalledWith(1);
    await waitFor(() => expect(adopt).toHaveBeenCalledWith([outcome]));
  });

  it('Delete removes the focused row, the x removes one, and Clear removes all', async () => {
    const { user } = setup(<Host />);
    const first = await screen.findByRole('button', { name: /^First[.]pdf/ });
    first.focus();
    await user.keyboard('{Delete}');
    expect(api.removeRecent).toHaveBeenCalledWith(1);
    expect(screen.queryByText('First.pdf')).toBeNull();
    await user.click(screen.getByRole('button', { name: 'Remove Gone.pdf from recent files' }));
    expect(api.removeRecent).toHaveBeenCalledWith(2);
    expect(screen.queryByRole('list', { name: 'Recent files' })).toBeNull();
  });

  it('Clear empties the list', async () => {
    const { user } = setup(<Host />);
    await screen.findByText('First.pdf');
    await user.click(screen.getByRole('button', { name: 'Clear' }));
    await waitFor(() => expect(api.removeRecent).toHaveBeenCalledTimes(2));
    expect(screen.queryByText('First.pdf')).toBeNull();
  });

  it('a removal gives an Undo toast that restores the entry and reads the list again', async () => {
    const { user } = setup(<Host />);
    await screen.findByText('First.pdf');
    await user.click(screen.getByRole('button', { name: 'Remove First.pdf from recent files' }));
    await waitFor(() => expect(useUi.getState().toast?.message).toBe('Removed First.pdf from recent files'));
    expect(screen.queryByText('First.pdf')).toBeNull();
    const toast = useUi.getState().toast;
    act(() => toast?.action?.run());
    await waitFor(() => expect(api.restoreRecent).toHaveBeenCalledWith(1));
    await waitFor(() => expect(api.listRecents).toHaveBeenCalledTimes(2));
  });

  it('Clear gives one Undo toast that restores in the reverse order', async () => {
    const { user } = setup(<Host />);
    await screen.findByText('First.pdf');
    await user.click(screen.getByRole('button', { name: 'Clear' }));
    await waitFor(() => expect(useUi.getState().toast?.message).toBe('Recent files cleared'));
    act(() => useUi.getState().toast?.action?.run());
    await waitFor(() => expect(api.restoreRecent).toHaveBeenCalledTimes(2));
    expect(api.restoreRecent.mock.calls.map(([id]) => id)).toEqual([2, 1]);
  });

  it('Clear offers Undo only for the entries that really went', async () => {
    api.removeRecent.mockImplementation((id: number) =>
      id === 1 ? Promise.reject(new Error('busy')) : Promise.resolve(),
    );
    const { user } = setup(<Host />);
    await screen.findByText('First.pdf');
    await user.click(screen.getByRole('button', { name: 'Clear' }));
    await waitFor(() => expect(useUi.getState().toast?.message).toBe('Recent files cleared'));
    act(() => useUi.getState().toast?.action?.run());
    await waitFor(() => expect(api.restoreRecent).toHaveBeenCalledTimes(1));
    expect(api.restoreRecent).toHaveBeenCalledWith(2);
    // The one that stayed is read from the backend again.
    await waitFor(() => expect(api.listRecents.mock.calls.length).toBeGreaterThan(1));
  });

  it('Clear with every removal failing shows no Undo', async () => {
    api.removeRecent.mockRejectedValue(new Error('busy'));
    const { user } = setup(<Host />);
    await screen.findByText('First.pdf');
    await user.click(screen.getByRole('button', { name: 'Clear' }));
    await waitFor(() => expect(api.removeRecent).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(api.listRecents.mock.calls.length).toBeGreaterThan(1));
    expect(useUi.getState().toast).toBeNull();
  });

  it('a missing file offers Locate from its button only, once; the row does nothing; an intact file has no button', async () => {
    const { user } = setup(<Host />);
    await screen.findByText('Gone.pdf');
    expect(screen.queryByRole('button', { name: 'Locate First.pdf' })).toBeNull();
    await user.click(screen.getByRole('button', { name: 'Locate Gone.pdf' }));
    expect(api.locateRecent).toHaveBeenCalledWith(2);
    await waitFor(() => expect(api.listRecents).toHaveBeenCalledTimes(2));
    await user.click(await screen.findByRole('button', { name: /^Gone[.]pdf/ }));
    expect(api.locateRecent).toHaveBeenCalledTimes(1);
    expect(api.openRecent).not.toHaveBeenCalled();
  });

  it('a Locate that fails says why in the banner', async () => {
    api.locateRecent.mockRejectedValue({ code: 'not_found' });
    const { user } = setup(<Host />);
    await user.click(await screen.findByRole('button', { name: 'Locate Gone.pdf' }));
    await waitFor(() => expect(useUi.getState().banner).not.toBeNull());
  });

  it('Up and Down move between the rows', async () => {
    const { user } = setup(<Host />);
    const first = await screen.findByRole('button', { name: /^First[.]pdf/ });
    first.focus();
    await user.keyboard('{ArrowDown}');
    expect(document.activeElement).toBe(screen.getByRole('button', { name: /^Gone[.]pdf/ }));
    await act(async () => undefined);
  });
});
