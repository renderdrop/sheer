// @vitest-environment jsdom
import { act, screen, waitFor, within } from '@testing-library/react';
import { MotionGlobalConfig } from 'motion/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { RecoveryEntry } from '../../api/recovery';
import { useDocuments } from '../../stores/documents';
import { useUi } from '../../stores/ui';
import { setup } from '../../test/render';
import { handleAppEvent } from '../viewer/appEvents';
import { resetPending } from './actions';
import { RecoveryBanner } from './RecoveryBanner';
import { useRecovery } from './store';

const api = vi.hoisted(() => ({
  listRecoveries: vi.fn(),
  restoreRecovery: vi.fn(),
  discardRecovery: vi.fn(),
}));
vi.mock('../../api/recovery', () => api);
vi.mock('../viewer/useViewer', () => ({ adoptOpenOutcomes: vi.fn() }));

const entry = (id: number, extra: Partial<RecoveryEntry> = {}): RecoveryEntry => ({
  id,
  displayName: `doc${id}.pdf`,
  savedAt: `2026-10-01T10:00:0${9 - id}Z`,
  pageCount: 2,
  original: 'unchanged',
  ...extra,
});

const uiInitial = useUi.getState();

beforeEach(() => {
  MotionGlobalConfig.skipAnimations = true;
  useUi.setState({ ...uiInitial }, true);
  useRecovery.setState({ entries: [], hidden: false, busy: [], failed: [] });
  resetPending();
  Object.values(api).forEach((fn) => fn.mockReset());
  api.discardRecovery.mockResolvedValue(undefined);
});
afterEach(() => {
  MotionGlobalConfig.skipAnimations = false;
});

describe('the recovery banner (DESIGN 3.50)', () => {
  it('lists records as a region without taking focus, and shows nothing when there are none', async () => {
    api.listRecoveries.mockResolvedValue([entry(1), entry(2, { original: 'missing' })]);
    setup(<RecoveryBanner />);
    const region = await screen.findByRole('region');
    expect(region.getAttribute('aria-labelledby')).not.toBeNull();
    expect(within(region).getAllByRole('group')).toHaveLength(2);
    expect(within(region).getByText(/restores as a copy/)).toBeTruthy();
    expect(within(region).getByRole('button', { name: 'Restore all' })).toBeTruthy();
    expect(document.activeElement).toBe(document.body);
  });

  it('collapses the rows at three records behind a toggle (B-006)', async () => {
    api.listRecoveries.mockResolvedValue([entry(1), entry(2), entry(3)]);
    const { user } = setup(<RecoveryBanner />);
    const region = await screen.findByRole('region');
    expect(within(region).queryAllByRole('group')).toHaveLength(0);
    expect(within(region).getByRole('status').textContent).toContain('3 documents');
    const toggle = within(region).getByRole('button', { name: 'Show all' });
    expect(toggle.getAttribute('aria-expanded')).toBe('false');
    await user.click(toggle);
    expect(within(region).getAllByRole('group')).toHaveLength(3);
    const hide = within(region).getByRole('button', { name: 'Hide' });
    expect(hide.getAttribute('aria-expanded')).toBe('true');
    await user.click(hide);
    expect(within(region).queryAllByRole('group')).toHaveLength(0);
  });

  it('keeps the toggle on the summary line, away from the bulk actions', async () => {
    api.listRecoveries.mockResolvedValue([entry(1), entry(2), entry(3)]);
    setup(<RecoveryBanner />);
    const region = await screen.findByRole('region');
    const toggle = within(region).getByRole('button', { name: 'Show all' });
    const status = within(region).getByRole('status');
    expect(status.parentElement?.contains(toggle)).toBe(true);
    const discardAll = within(region).getByRole('button', { name: 'Discard all' });
    expect(toggle.parentElement?.contains(discardAll)).toBe(false);
  });

  it('shows the rows at two records without a toggle', async () => {
    api.listRecoveries.mockResolvedValue([entry(1), entry(2)]);
    setup(<RecoveryBanner />);
    const region = await screen.findByRole('region');
    expect(within(region).getAllByRole('group')).toHaveLength(2);
    expect(within(region).queryByRole('button', { name: 'Show all' })).toBeNull();
  });

  it('stays out when there is nothing to restore', async () => {
    api.listRecoveries.mockResolvedValue([]);
    setup(<RecoveryBanner />);
    await waitFor(() => expect(api.listRecoveries).toHaveBeenCalled());
    expect(screen.queryByRole('region')).toBeNull();
  });

  it('yields to an error banner and returns', async () => {
    api.listRecoveries.mockResolvedValue([entry(1)]);
    setup(<RecoveryBanner />);
    await screen.findByRole('region');
    act(() => useUi.getState().showBanner({ code: 'internal', key: 'error.internal', retryable: false }));
    await waitFor(() => expect(screen.queryByRole('region')).toBeNull());
    act(() => useUi.getState().dismissBanner());
    expect(await screen.findByRole('region')).toBeTruthy();
  });

  it('restores a record: the row leaves and a toast says so', async () => {
    api.listRecoveries.mockResolvedValue([entry(1)]);
    api.restoreRecovery.mockResolvedValue({
      type: 'opened',
      document: { id: 9, pageCount: 2, displayName: 'doc1.pdf', kind: 'recovered' },
    });
    const { user } = setup(<RecoveryBanner />);
    await user.click(await screen.findByRole('button', { name: 'Restore' }));
    await waitFor(() => expect(screen.queryByRole('region')).toBeNull());
    expect(api.restoreRecovery).toHaveBeenCalledWith(1);
    expect(useUi.getState().toast?.message).toBe('Restored: doc1.pdf');
  });

  it('keeps the row with an alert when a restore fails', async () => {
    api.listRecoveries.mockResolvedValue([entry(1)]);
    api.restoreRecovery.mockRejectedValue({ code: 'damaged_file', key: 'error.damaged_file', retryable: false });
    const { user } = setup(<RecoveryBanner />);
    await user.click(await screen.findByRole('button', { name: 'Restore' }));
    expect((await screen.findByRole('alert')).textContent).toContain('restore this document');
    expect(screen.getByRole('button', { name: 'Discard' })).toBeTruthy();
  });

  it('discards with Undo for the toast lifetime and deletes the record when the toast ends', async () => {
    api.listRecoveries.mockResolvedValue([entry(1), entry(2)]);
    const { user } = setup(<RecoveryBanner />);
    await user.click((await screen.findAllByRole('button', { name: 'Discard' }))[0] as HTMLElement);
    expect(useUi.getState().toast?.action?.label).toBe('Undo');
    expect(api.discardRecovery).not.toHaveBeenCalled();
    act(() => useUi.getState().toast?.action?.run());
    expect(useRecovery.getState().entries.map((row) => row.id)).toEqual([1, 2]);
    expect(api.discardRecovery).not.toHaveBeenCalled();

    await user.click((await screen.findAllByRole('button', { name: 'Discard' }))[1] as HTMLElement);
    act(() => useUi.getState().dismissToast());
    expect(api.discardRecovery).toHaveBeenCalledWith(2);
    expect(api.discardRecovery).toHaveBeenCalledTimes(1);
  });

  it('discards all as one undoable step', async () => {
    api.listRecoveries.mockResolvedValue([entry(1), entry(2)]);
    const { user } = setup(<RecoveryBanner />);
    await user.click(await screen.findByRole('button', { name: 'Discard all' }));
    expect(useUi.getState().toast?.message).toBe('Changes to 2 documents discarded');
    act(() => useUi.getState().dismissToast());
    expect(api.discardRecovery.mock.calls.map((call) => call[0]).sort()).toEqual([1, 2]);
  });

  it('keeps the records when the user decides later', async () => {
    api.listRecoveries.mockResolvedValue([entry(1)]);
    const { user } = setup(<RecoveryBanner />);
    await user.click(await screen.findByRole('button', { name: 'Decide later' }));
    await waitFor(() => expect(screen.queryByRole('region')).toBeNull());
    expect(useRecovery.getState().entries).toHaveLength(1);
    expect(api.discardRecovery).not.toHaveBeenCalled();
  });
});

describe('engine restart', () => {
  it('toasts that the engine restarted', () => {
    handleAppEvent({ type: 'engineRestarted', lost: [] });
    expect(useUi.getState().toast?.message).toBe('The document engine restarted.');
  });

  it('names the documents that were lost', () => {
    useDocuments.setState({
      byId: { 3: { id: 3, pageCount: 1, displayName: 'a.pdf' }, 4: { id: 4, pageCount: 1, displayName: 'b.pdf' } },
    });
    handleAppEvent({ type: 'engineRestarted', lost: [3, 4] });
    expect(useUi.getState().toast?.message).toBe('The document engine restarted. Open again: a.pdf, b.pdf');
    useDocuments.setState({ byId: {} });
  });
});
