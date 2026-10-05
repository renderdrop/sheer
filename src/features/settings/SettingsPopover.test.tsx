// @vitest-environment jsdom
import { act, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { updateSettings, type Settings } from '../../api/app';
import { Popover } from '../../components';
import { bindLocaleToSettings } from '../../i18n/bind';
import { useLocaleStore } from '../../i18n/store';
import { useSettings } from '../../stores/settings';
import { setup } from '../../test/render';
import { SettingsPopover } from './SettingsPopover';
import { useAboutDialog } from '../about/state';
import { useUpdate } from '../update/store';
import { restartTour } from '../tour/runtime';
import { openSettings, useSettingsPopover } from './state';

vi.mock('../../api/app', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../api/app')>()),
  updateSettings: vi.fn(),
}));

vi.mock('../../api/update', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../api/update')>()),
  updaterConfigured: vi.fn(() => Promise.resolve(true)),
}));

vi.mock('../tour/runtime', () => ({ restartTour: vi.fn(() => Promise.resolve()) }));

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
  useUpdate.setState({ check: 'idle', configured: true });
  updateSettingsMock.mockReset();
  answerWithPatch();
});

afterEach(() => {
  useSettings.setState({ ...settingsInitial }, true);
  useSettingsPopover.setState({ open: false });
});

/** A menu title, which is what the popover anchors to, and the popover. */
function Fixture() {
  return (
    <>
      <div role="toolbar" aria-label="Tools">
        <button type="button" data-toolbar-item="left-panel">
          panel
        </button>
        <button type="button" data-menubar-item="file">
          File
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

describe('the settings panel (DESIGN 3.6)', () => {
  const labels = () =>
    [...popover().querySelectorAll('span.t-label')]
      .map((el) => el.textContent)
      .filter((text) => text !== 'Recognise shapes when you pause');

  it('has the groups in order and nothing else', () => {
    setup(<Fixture />);
    act(() => openSettings());
    expect(labels()).toEqual(['Language', 'Author name', 'Drawing', 'Updates', 'Tour & tips', 'About']);
    expect(within(popover()).queryByText('Signatures')).toBeNull();
    expect(within(popover()).queryByRole('button', { name: /default PDF app/ })).toBeNull();
  });

  it('hides the Updates group from the first open until the probe says the updater is configured', async () => {
    useUpdate.setState({ configured: null });
    setup(<Fixture />);
    act(() => openSettings());
    expect(labels()).toEqual(['Language', 'Author name', 'Drawing', 'Tour & tips', 'About']);
    await waitFor(() => expect(labels()).toContain('Updates'));
    expect(within(popover()).getByRole('switch', { name: 'Updates' }).getAttribute('aria-checked')).toBe('false');
  });

  it('hides the whole Updates group while the updater is unconfigured', () => {
    useUpdate.setState({ check: 'unconfigured', configured: false });
    setup(<Fixture />);
    act(() => openSettings());
    expect(labels()).toEqual(['Language', 'Author name', 'Drawing', 'Tour & tips', 'About']);
    expect(within(popover()).queryByRole('switch', { name: 'Updates' })).toBeNull();
    useUpdate.setState({ check: 'idle' });
  });

  it('restarts the tour through the tour runtime', async () => {
    const { user } = setup(<Fixture />);
    act(() => openSettings());
    await user.click(within(popover()).getByRole('button', { name: 'Start tour' }));
    expect(restartTour).toHaveBeenCalledOnce();
  });

  it('opens the About dialog and closes the popover', async () => {
    useSettings.setState({ version: '1.2.0' });
    const { user } = setup(<Fixture />);
    act(() => openSettings());
    expect(within(popover()).getByText('sheer. · Version 1.2.0')).not.toBeNull();
    await user.click(within(popover()).getByRole('button', { name: 'About sheer.' }));
    expect(useAboutDialog.getState().open).toBe(true);
    expect(useSettingsPopover.getState().open).toBe(false);
    useAboutDialog.setState({ open: false });
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

  it('hangs from the toolbar: it is a G2 popover, and focus goes back to the menu title on Esc', async () => {
    const { user } = setup(<Fixture />);
    act(() => openSettings());
    expect(popover().className).toContain('bg-panel border border-border-subtle shadow-floating');
    await user.keyboard('{Escape}');
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(useSettingsPopover.getState().open).toBe(false);
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'File' }));
  });

  it('falls back to the Home strip when there is no menu title or top bar', async () => {
    const { user } = setup(
      <>
        <div data-slot="home-strip" role="group" aria-label="Home" tabIndex={0} />
        <SettingsPopover />
      </>,
    );
    act(() => openSettings());
    await user.keyboard('{Escape}');
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(document.activeElement).toBe(screen.getByRole('group', { name: 'Home' }));
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
    // Order: Language, author name, shape switch, Updates, Start tour, Show tips again, Ghost About button (the last), then wrap.
    const tab = async () => {
      await user.tab();
      return document.activeElement;
    };
    expect(await tab()).toBe(within(popover()).getByRole('textbox', { name: 'Author name' }));
    expect(await tab()).toBe(within(popover()).getByRole('switch', { name: 'Recognise shapes when you pause' }));
    expect(await tab()).toBe(within(popover()).getByRole('switch', { name: 'Updates' }));
    expect(await tab()).toBe(within(popover()).getByRole('button', { name: 'Start tour' }));
    expect(await tab()).toBe(within(popover()).getByRole('button', { name: 'Show tips again' }));
    expect(await tab()).toBe(within(popover()).getByRole('button', { name: 'About sheer.' }));
    expect(await tab()).toBe(choose('Language', 'English'));
    await user.tab({ shift: true });
    expect(document.activeElement).toBe(within(popover()).getByRole('button', { name: 'About sheer.' }));
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
