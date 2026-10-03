// @vitest-environment jsdom
import { act, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { setup } from '../../test/render';
import { EmptyState } from './EmptyState';
import { formatAge, useRecents } from './recents';

const api = vi.hoisted(() => ({ listRecents: vi.fn(), removeRecent: vi.fn(), openRecent: vi.fn() }));
const adopt = vi.hoisted(() => vi.fn());
vi.mock('../../api/recents', () => api);
vi.mock('../viewer/useViewer', () => ({ adoptOpenOutcomes: adopt }));

const NOW = 1_700_000_000;
const entries = [
  { id: 1, displayName: 'First.pdf', lastOpened: NOW - 7200, missing: false },
  { id: 2, displayName: 'Gone.pdf', lastOpened: NOW - 100, missing: true },
];

beforeEach(() => {
  api.listRecents.mockReset().mockResolvedValue(entries);
  api.removeRecent.mockReset().mockResolvedValue(undefined);
  api.openRecent.mockReset();
  adopt.mockReset();
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

  it('shows the placeholder when the list is empty or cannot be read', async () => {
    api.listRecents.mockRejectedValue({ code: 'internal' });
    setup(<Host />);
    await waitFor(() => expect(api.listRecents).toHaveBeenCalled());
    expect(screen.getByText('Files you open appear here.')).not.toBeNull();
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
    expect(screen.getByText('Files you open appear here.')).not.toBeNull();
  });

  it('Clear empties the list', async () => {
    const { user } = setup(<Host />);
    await screen.findByText('First.pdf');
    await user.click(screen.getByRole('button', { name: 'Clear' }));
    expect(api.removeRecent).toHaveBeenCalledTimes(2);
    expect(screen.queryByText('First.pdf')).toBeNull();
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
