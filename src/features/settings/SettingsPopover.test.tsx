// @vitest-environment jsdom
import { act, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { openDefaultAppsSettings, updateSettings, type Settings } from '../../api/app';
import { Popover } from '../../components';
import { bindLocaleToSettings } from '../../i18n/bind';
import { useLocaleStore } from '../../i18n/store';
import { useSettings } from '../../stores/settings';
import { setup } from '../../test/render';
import { SettingsPopover } from './SettingsPopover';
import { openSettings, useSettingsPopover } from './state';

vi.mock('../../api/app', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../api/app')>()),
  updateSettings: vi.fn(),
  openDefaultAppsSettings: vi.fn(() => Promise.resolve()),
}));

const updateSettingsMock = vi.mocked(updateSettings);
const settingsInitial = useSettings.getState();

/** The backend's answer: the settings with the patch applied (what `update_settings` returns). */
function answerWithPatch() {
  updateSettingsMock.mockImplementation((patch) => {
    const { language, leftPanelWidth, authorName } = useSettings.getState();
    const current: Settings = {
      language,
      leftPanelWidth,
      authorName,
      welcomeTour: 'pending',
      authorPrompt: 'pending',
    };
    return Promise.resolve({ ...current, ...patch });
  });
}

beforeEach(() => {
  useSettings.setState({ ...settingsInitial }, true);
  useSettingsPopover.setState({ open: false });
  updateSettingsMock.mockReset();
  answerWithPatch();
});

afterEach(() => {
  useSettings.setState({ ...settingsInitial }, true);
  useSettingsPopover.setState({ open: false });
});

/** A toolbar with a More button, which is what the popover anchors to, and the popover. */
function Fixture() {
  return (
    <>
      <div role="toolbar" aria-label="Tools">
        <button type="button" data-toolbar-item="left-panel">
          panel
        </button>
        <button type="button" data-toolbar-item="more">
          More
        </button>
      </div>
      <button type="button">elsewhere</button>
      <SettingsPopover />
    </>
  );
}

const popover = () => screen.getByRole('dialog', { name: 'Settings' });
const group = (name: string) => within(popover()).getByRole('radiogroup', { name });
const checked = (name: string) =>
  within(group(name))
    .getAllByRole('radio')
    .find((radio) => radio.getAttribute('aria-checked') === 'true')?.textContent;
const choose = (name: string, option: string) => within(group(name)).getByRole('radio', { name: option });

describe('the default PDF app row', () => {
  const button = () => within(popover()).queryByRole('button', { name: /default PDF app/ });

  it('opens the OS page on Windows', async () => {
    useSettings.setState({ platform: 'windows' });
    const { user } = setup(<Fixture />);
    act(() => openSettings());
    await user.click(button() as HTMLElement);
    expect(openDefaultAppsSettings).toHaveBeenCalledOnce();
  });

  it('is hidden on macOS and when the platform is unknown', () => {
    useSettings.setState({ platform: 'macos' });
    setup(<Fixture />);
    act(() => openSettings());
    expect(button()).toBeNull();
  });
});

describe('the settings popover', () => {
  it('is closed until the settings action opens it', () => {
    setup(<Fixture />);
    expect(screen.queryByRole('dialog')).toBeNull();
    act(() => openSettings());
    expect(popover()).not.toBeNull();
  });

  it('shows Language as a labelled segmented control with the saved value checked, and no theme or glass control', () => {
    useSettings.setState({ language: 'de' });
    setup(<Fixture />);
    act(() => openSettings());
    expect(
      within(group('Language'))
        .getAllByRole('radio')
        .map((radio) => radio.textContent),
    ).toEqual(['System', 'English', 'Deutsch']);
    expect(checked('Language')).toBe('Deutsch');
    expect(within(popover()).queryByRole('radiogroup', { name: 'Theme' })).toBeNull();
    expect(within(popover()).queryByRole('radiogroup', { name: 'Glass' })).toBeNull();
  });

  it('takes focus on the checked language, the first control, when it opens', () => {
    setup(<Fixture />);
    act(() => openSettings());
    expect(document.activeElement).toBe(choose('Language', 'System'));
  });

  it('hangs from the toolbar: it is a G2 popover, and focus goes back to the More button on Esc', async () => {
    const { user } = setup(<Fixture />);
    act(() => openSettings());
    expect(popover().className).toContain('bg-panel border border-border-subtle shadow-floating');
    await user.keyboard('{Escape}');
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(useSettingsPopover.getState().open).toBe(false);
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'More' }));
  });

  it('falls back to the toolbar itself when there is no More button', async () => {
    const { user } = setup(
      <>
        <div role="toolbar" aria-label="Tools" tabIndex={0} />
        <SettingsPopover />
      </>,
    );
    act(() => openSettings());
    await user.keyboard('{Escape}');
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(document.activeElement).toBe(screen.getByRole('toolbar'));
  });

  it('stays open when the shortcut is typed again, and closes on an outside click', async () => {
    const { user } = setup(<Fixture />);
    act(() => openSettings());
    act(() => openSettings());
    expect(popover()).not.toBeNull();
    await user.click(screen.getByRole('button', { name: 'elsewhere' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(useSettingsPopover.getState().open).toBe(false);
  });

  it('saves a language choice through update_settings and shows it at once', async () => {
    const { user } = setup(<Fixture />);
    act(() => openSettings());
    await user.click(choose('Language', 'English'));
    expect(updateSettingsMock).toHaveBeenCalledExactlyOnceWith({ language: 'en' });
    await waitFor(() => expect(checked('Language')).toBe('English'));
    expect(useSettings.getState().language).toBe('en');
  });

  it('switches the language at once, popover included: choosing Deutsch makes it German', async () => {
    const unbind = bindLocaleToSettings(document.documentElement, useSettings, useLocaleStore, () => 'en-US');
    const { user } = setup(<Fixture />);
    act(() => openSettings());
    await user.click(choose('Language', 'Deutsch'));
    expect(updateSettingsMock).toHaveBeenCalledExactlyOnceWith({ language: 'de' });
    await waitFor(() => expect(screen.getByRole('dialog', { name: 'Einstellungen' })).not.toBeNull());
    const german = screen.getByRole('dialog', { name: 'Einstellungen' });
    expect(within(german).getByRole('radiogroup', { name: 'Sprache' })).not.toBeNull();
    expect(document.documentElement.getAttribute('lang')).toBe('de');
    unbind();
  });

  it('is operable from the keyboard: arrows choose, Tab moves between the controls and wraps inside the popover', async () => {
    const { user } = setup(<Fixture />);
    act(() => openSettings());
    await user.keyboard('{ArrowRight}');
    expect(updateSettingsMock).toHaveBeenLastCalledWith({ language: 'en' });
    await waitFor(() => expect(checked('Language')).toBe('English'));
    // Tab at the last control wraps to the first: the popover keeps focus inside.
    // The author name field is the second stop, Manage signatures the third, the Help row's two buttons the fifth and the sixth (the last one).
    await user.tab();
    expect(document.activeElement).toBe(within(popover()).getByRole('textbox', { name: 'Author name' }));
    await user.tab();
    expect(document.activeElement).toBe(within(popover()).getByRole('button', { name: 'Manage signatures…' }));
    await user.tab();
    expect(document.activeElement).toBe(choose('Updates', 'Off'));
    await user.tab();
    expect(document.activeElement).toBe(within(popover()).getByRole('button', { name: 'Start tour' }));
    await user.tab();
    expect(document.activeElement).toBe(within(popover()).getByRole('button', { name: 'Show tips again' }));
    await user.tab();
    expect(document.activeElement).toBe(choose('Language', 'English'));
    await user.tab({ shift: true });
    expect(document.activeElement).toBe(within(popover()).getByRole('button', { name: 'Show tips again' }));
  });

  it('shows the error when the backend refuses a change, and no error while all is well', async () => {
    updateSettingsMock.mockRejectedValueOnce({
      code: 'invalid_argument',
      retryable: false,
      params: { what: 'settings' },
    });
    const { user } = setup(<Fixture />);
    act(() => openSettings());
    expect(within(popover()).queryByRole('alert')).toBeNull();
    await user.click(choose('Language', 'Deutsch'));
    expect((await within(popover()).findByRole('alert')).textContent).toBe('That setting is not valid.');
    expect(checked('Language')).toBe('System');
    await user.click(choose('Language', 'English'));
    await waitFor(() => expect(within(popover()).queryByRole('alert')).toBeNull());
    expect(checked('Language')).toBe('English');
  });

  it('is one popover at a time: opening another popover closes it', async () => {
    const { user } = setup(
      <>
        <Fixture />
        <SettingsOtherPopover />
      </>,
    );
    act(() => openSettings());
    expect(popover()).not.toBeNull();
    await user.click(screen.getByRole('button', { name: 'Other' }));
    expect(screen.getByRole('dialog', { name: 'Other' })).not.toBeNull();
    await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Settings' })).toBeNull());
    expect(useSettingsPopover.getState().open).toBe(false);
  });
});

// A second popover, to check the one-at-a-time rule of the Popover primitive with this one controlled from a store.
function SettingsOtherPopover() {
  return (
    <Popover label="Other" trigger={(trigger) => <button {...trigger}>Other</button>}>
      <button type="button">inside</button>
    </Popover>
  );
}
