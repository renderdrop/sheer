// @vitest-environment jsdom
import { act, screen, waitFor, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { updateSettings, type Settings } from '../../api/app';
import { useSettings } from '../../stores/settings';
import { setup } from '../../test/render';
import { SettingsPopover } from './SettingsPopover';
import { openSettings, useSettingsPopover } from './state';

vi.mock('../../api/app', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../api/app')>()),
  updateSettings: vi.fn(),
}));

const updateSettingsMock = vi.mocked(updateSettings);
const settingsInitial = useSettings.getState();

beforeEach(() => {
  useSettings.setState({ ...settingsInitial, authorName: 'Ada' }, true);
  useSettingsPopover.setState({ open: false });
  updateSettingsMock.mockReset();
  updateSettingsMock.mockImplementation((patch) => {
    const { glass, theme, language, leftPanelWidth, authorName } = useSettings.getState();
    const current: Settings = {
      glass,
      theme,
      language,
      leftPanelWidth,
      authorName,
      welcomeTour: 'pending',
      authorPrompt: 'pending',
    };
    return Promise.resolve({ ...current, ...patch });
  });
});

function field(): HTMLInputElement {
  return within(screen.getByRole('dialog', { name: 'Settings' })).getByRole('textbox', { name: 'Author name' });
}

describe('the author name setting', () => {
  it('shows the saved name', () => {
    setup(<SettingsPopover />);
    act(() => openSettings());
    expect(field().value).toBe('Ada');
    expect(field().maxLength).toBe(128);
  });

  it('saves the trimmed name on Enter', async () => {
    const { user } = setup(<SettingsPopover />);
    act(() => openSettings());
    await user.clear(field());
    await user.type(field(), '  Grace Hopper {Enter}');
    await waitFor(() => expect(updateSettingsMock).toHaveBeenCalledWith({ authorName: 'Grace Hopper' }));
    await waitFor(() => expect(useSettings.getState().authorName).toBe('Grace Hopper'));
  });

  it('saves an empty name: no author (ADR-034)', async () => {
    const { user } = setup(<SettingsPopover />);
    act(() => openSettings());
    await user.clear(field());
    await user.tab();
    await waitFor(() => expect(updateSettingsMock).toHaveBeenCalledWith({ authorName: '' }));
  });

  it('reverts the typing on Esc and keeps the popover open', async () => {
    const { user } = setup(<SettingsPopover />);
    act(() => openSettings());
    await user.type(field(), 'xyz');
    await user.keyboard('{Escape}');
    expect(field().value).toBe('Ada');
    expect(screen.queryByRole('dialog', { name: 'Settings' })).not.toBeNull();
    expect(updateSettingsMock).not.toHaveBeenCalled();
  });
});
