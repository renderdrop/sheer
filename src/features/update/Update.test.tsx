// @vitest-environment jsdom
import { act, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import * as api from '../../api/update';
import { useSettings } from '../../stores/settings';
import { AboutUpdate } from './AboutUpdate';
import { resetUpdate, useUpdate } from './store';
import { UpdateBannerRow } from './UpdateBanner';

vi.mock('../../api/update', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../api/update')>()),
  checkForUpdate: vi.fn(),
  downloadUpdate: vi.fn(),
  installUpdateOnQuit: vi.fn(),
  skipUpdateVersion: vi.fn(),
}));
vi.mock('../save/quit', () => ({ requestQuit: vi.fn(() => Promise.resolve()) }));

const mocked = vi.mocked(api);
const INFO = { version: '1.2.0', date: null, notes: '<b>Fixes</b>' };

beforeEach(() => {
  resetUpdate();
  useSettings.setState({ skippedVersion: null });
  mocked.skipUpdateVersion.mockResolvedValue();
  mocked.installUpdateOnQuit.mockResolvedValue();
});
afterEach(() => vi.clearAllMocks());

describe('store', () => {
  it('ignores a skipped version pushed by an automatic check', () => {
    useSettings.setState({ skippedVersion: '1.2.0' });
    useUpdate.getState().offer(INFO);
    expect(useUpdate.getState().info).toBeNull();
  });

  it('goes available, downloading, ready; restart installs on quit then runs the quit flow', async () => {
    useUpdate.getState().offer(INFO);
    mocked.downloadUpdate.mockImplementation((on) => {
      on({ kind: 'progress', downloaded: 5, total: 10 });
      on({ kind: 'verified' });
      return Promise.resolve();
    });
    await useUpdate.getState().download();
    expect(useUpdate.getState().phase).toBe('ready');
    await useUpdate.getState().restart();
    expect(mocked.installUpdateOnQuit).toHaveBeenCalled();
    const { requestQuit } = await import('../save/quit');
    expect(requestQuit).toHaveBeenCalled();
  });

  it('a signature failure offers no retry and is not offered again', async () => {
    useUpdate.getState().offer(INFO);
    mocked.downloadUpdate.mockImplementation((on) => {
      on({ kind: 'failed', code: 'damaged_file' });
      return Promise.resolve();
    });
    await useUpdate.getState().download();
    expect(useUpdate.getState().phase).toBe('unverified');
    await useUpdate.getState().download();
    expect(mocked.downloadUpdate).toHaveBeenCalledTimes(1);
    useUpdate.getState().offer(INFO);
    expect(useUpdate.getState().phase).toBe('unverified');
  });

  it('a network failure can be retried', async () => {
    useUpdate.getState().offer(INFO);
    mocked.downloadUpdate.mockRejectedValue({ code: 'io_not_found' });
    await useUpdate.getState().download();
    expect(useUpdate.getState().phase).toBe('downloadFailed');
  });

  it('skip stores the version', async () => {
    useUpdate.getState().offer(INFO);
    await useUpdate.getState().skip();
    expect(mocked.skipUpdateVersion).toHaveBeenCalledWith('1.2.0');
    expect(useSettings.getState().skippedVersion).toBe('1.2.0');
    expect(useUpdate.getState().hidden).toBe(true);
  });

  it('an unconfigured build is told apart from a failure', async () => {
    mocked.checkForUpdate.mockRejectedValue({ code: 'unsupported_feature', params: { what: 'updater_unconfigured' } });
    await useUpdate.getState().checkNow();
    expect(useUpdate.getState().check).toBe('unconfigured');
    mocked.checkForUpdate.mockRejectedValue({ code: 'internal' });
    await useUpdate.getState().checkNow();
    expect(useUpdate.getState().check).toBe('failed');
  });
});

describe('UpdateBannerRow', () => {
  it('shows the offer as a status, notes as plain text, and Download', async () => {
    const user = userEvent.setup();
    render(<UpdateBannerRow />);
    expect(screen.queryByRole('status')).toBeNull();
    act(() => useUpdate.getState().offer(INFO));
    expect((await screen.findByRole('status')).textContent).toContain('1.2.0');
    await user.click(screen.getByRole('button', { name: 'Details' }));
    expect(screen.getByLabelText('Release notes').textContent).toBe('<b>Fixes</b>');
    expect(screen.queryByRole('dialog')).toBeNull();
    mocked.downloadUpdate.mockImplementation((on) => {
      on({ kind: 'verified' });
      return Promise.resolve();
    });
    await user.click(screen.getByRole('button', { name: 'Download' }));
    expect(await screen.findByRole('button', { name: 'Restart to update' })).toBeTruthy();
  });

  it('shows an alert without a retry for a bad signature', async () => {
    render(<UpdateBannerRow />);
    act(() => {
      useUpdate.setState({ info: INFO, phase: 'unverified', hidden: false });
    });
    expect((await screen.findByRole('alert')).textContent).toContain('deleted');
    expect(screen.queryByRole('button', { name: 'Try again' })).toBeNull();
  });
});

describe('AboutUpdate', () => {
  it('checks on demand and says when updates are not configured', async () => {
    const user = userEvent.setup();
    mocked.checkForUpdate.mockRejectedValue({ code: 'unsupported_feature', params: { what: 'updater_unconfigured' } });
    render(<AboutUpdate />);
    await user.click(screen.getByRole('button', { name: 'Check for updates' }));
    await waitFor(() => expect(screen.getByRole('status').textContent).toContain('not configured'));
  });
});
