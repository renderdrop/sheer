// @vitest-environment jsdom
import { act, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { MotionGlobalConfig } from 'motion/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { runAction } from '../../actions/dispatch';
import { DISMISS_PRIORITY, registerDismissLayer } from '../../components/dismiss';
import { APP_NAME } from '../../config/app';
import { useLocaleStore } from '../../i18n/store';
import { useSettings } from '../../stores/settings';
import { openTooltip, setup } from '../../test/render';
import { useSettingsPopover } from '../settings/state';
import { AboutDialog } from './AboutDialog';
import { openAbout, toggleAbout, useAboutDialog } from './state';

const settingsInitial = useSettings.getState();

/**
 * Motion reads `(prefers-reduced-motion)` through `matchMedia` once and then follows its `change` event, so the stub is in place
 * before the first render and a test flips the preference the way a user does in the OS (as in components/reducedMotion.test.tsx).
 */
let reduced = false;
const listeners = new Set<() => void>();

function setReducedMotion(reduce: boolean): void {
  reduced = reduce;
  for (const listener of listeners) listener();
}

window.matchMedia = (query: string): MediaQueryList =>
  ({
    get matches() {
      return reduced && query.includes('prefers-reduced-motion');
    },
    media: query,
    onchange: null,
    addEventListener: (_type: string, listener: EventListenerOrEventListenerObject) => {
      if (typeof listener === 'function') listeners.add(() => listener(new Event('change')));
    },
    removeEventListener: () => undefined,
    addListener: () => undefined,
    removeListener: () => undefined,
    dispatchEvent: () => false,
  }) as MediaQueryList;

beforeEach(() => {
  useSettings.setState({ ...settingsInitial, version: '1.2.3' }, true);
  useAboutDialog.setState({ open: false });
  useSettingsPopover.setState({ open: false });
});

afterEach(() => {
  useSettings.setState({ ...settingsInitial }, true);
  useAboutDialog.setState({ open: false });
  useSettingsPopover.setState({ open: false });
});

/** The app (with the id the dialog makes inert) and the dialog, which portals out of it as it does in the shell. */
function Fixture() {
  return (
    <>
      <div id="root">
        <button type="button">More</button>
        <button type="button">elsewhere</button>
      </div>
      <AboutDialog />
    </>
  );
}

const dialog = () => screen.getByRole('dialog', { name: `About ${APP_NAME}` });
const gone = () => waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
const licenses = () => within(dialog()).getByRole('button', { name: 'Third-party licenses' });
const close = () => within(dialog()).getByRole('button', { name: 'Close' });

describe('the About dialog', () => {
  it('is closed until the about action opens it', () => {
    setup(<Fixture />);
    expect(screen.queryByRole('dialog')).toBeNull();
    act(() => openAbout());
    expect(dialog()).not.toBeNull();
  });

  it('is a modal dialog on a solid surface with the dialog shadow, above a backdrop at the modal layer', () => {
    setup(<Fixture />);
    act(() => openAbout());
    expect(dialog().getAttribute('aria-modal')).toBe('true');
    expect(dialog().className).toContain('bg-panel border border-border-subtle shadow-floating');
    expect(dialog().className).toContain('rounded-card');
    // Not glass: solid with --shadow-3 (DESIGN 1.3).
    expect(dialog().className).not.toContain('glass');
    const backdrop = dialog().parentElement as HTMLElement;
    expect(backdrop.className).toContain('z-modal');
    expect(backdrop.className).toContain('bg-backdrop');
  });

  it('shows the word mark, the claim, the version, the licence and the privacy promise, and no logo tile', () => {
    setup(<Fixture />);
    act(() => openAbout());
    expect(dialog().querySelector('img')).toBeNull();
    // The word mark is the name: an image "sheer." inside the heading.
    const heading = within(dialog()).getByRole('heading', { level: 2 });
    expect(within(heading).getByRole('img', { name: APP_NAME })).not.toBeNull();
    expect(within(dialog()).getByText('PDFs made simple')).not.toBeNull();
    expect(within(dialog()).getByText('Version 1.2.3')).not.toBeNull();
    expect(within(dialog()).getByText('Open source under AGPL-3.0-or-later')).not.toBeNull();
    expect(within(dialog()).getByText(/offline, without telemetry/)).not.toBeNull();
  });

  it('leaves the version out until the backend has reported it, and does not write "null"', () => {
    useSettings.setState({ version: null });
    setup(<Fixture />);
    act(() => openAbout());
    expect(within(dialog()).queryByText(/Version/)).toBeNull();
    expect(dialog().textContent).not.toContain('null');
  });

  it('is in German when the UI is', () => {
    useLocaleStore.setState({ locale: 'de' });
    setup(<Fixture />);
    act(() => openAbout());
    const german = screen.getByRole('dialog', { name: `Über ${APP_NAME}` });
    expect(within(german).getByText('Open Source unter AGPL-3.0-or-later')).not.toBeNull();
    expect(within(german).getByRole('button', { name: 'Lizenzen von Drittanbietern' })).not.toBeNull();
    expect(within(german).getByRole('button', { name: 'Schließen' })).not.toBeNull();
  });

  describe('the third-party licenses entry', () => {
    it('is a disabled placeholder that stays focusable and says why: coming soon', async () => {
      const { user } = setup(<Fixture />);
      act(() => openAbout());
      const entry = licenses();
      expect(entry.getAttribute('aria-disabled')).toBe('true');
      expect(entry.hasAttribute('disabled')).toBe(false);
      expect(entry.getAttribute('aria-description')).toBe('Coming soon');
      await user.click(entry);
      // It does nothing: the dialog is still there and nothing else opened.
      expect(dialog()).not.toBeNull();
      expect(screen.getAllByRole('dialog')).toHaveLength(1);
    });

    it('shows the "coming soon" tooltip on keyboard focus', async () => {
      setup(<Fixture />);
      act(() => openAbout());
      act(() => licenses().focus());
      await waitFor(() => expect(openTooltip()?.textContent).toContain('Coming soon'));
    });
  });

  describe('focus', () => {
    it('starts on Close, which is safe: it is neither the placeholder nor anything destructive', () => {
      setup(<Fixture />);
      act(() => openAbout());
      expect(document.activeElement).toBe(close());
    });

    it('is trapped: Tab and Shift+Tab cycle between the three buttons and never reach the app behind', async () => {
      const { user } = setup(<Fixture />);
      act(() => openAbout());
      const check = screen.getByRole('button', { name: 'Check for updates' });
      await user.tab();
      expect(document.activeElement).toBe(check);
      await user.tab();
      expect(document.activeElement).toBe(licenses());
      await user.tab();
      expect(document.activeElement).toBe(close());
      await user.tab({ shift: true });
      expect(document.activeElement).toBe(licenses());
      await user.tab({ shift: true });
      expect(document.activeElement).toBe(check);
      await user.tab({ shift: true });
      expect(document.activeElement).toBe(close());
    });

    it('makes the app behind inert while it is open, and not after', async () => {
      const { user } = setup(<Fixture />);
      const root = document.getElementById('root') as HTMLElement;
      expect(root.hasAttribute('inert')).toBe(false);
      act(() => openAbout());
      expect(root.hasAttribute('inert')).toBe(true);
      await user.keyboard('{Escape}');
      expect(root.hasAttribute('inert')).toBe(false);
      await gone();
    });

    it('returns to where it was, the More button the dialog was chosen from, on Esc', async () => {
      const { user } = setup(<Fixture />);
      const more = screen.getByRole('button', { name: 'More' });
      more.focus();
      act(() => openAbout());
      expect(document.activeElement).toBe(close());
      await user.keyboard('{Escape}');
      expect(document.activeElement).toBe(more);
      await gone();
    });

    it('returns to where it was after Close and after a press on the backdrop', async () => {
      const { user } = setup(<Fixture />);
      const more = screen.getByRole('button', { name: 'More' });
      more.focus();
      act(() => openAbout());
      await user.click(close());
      expect(document.activeElement).toBe(more);
      await gone();
      more.focus();
      act(() => openAbout());
      fireEvent.pointerDown(dialog().parentElement as HTMLElement);
      expect(document.activeElement).toBe(more);
      await gone();
    });
  });

  describe('closing', () => {
    it('closes with Esc, with Close and with a press on the backdrop', async () => {
      const { user } = setup(<Fixture />);
      act(() => openAbout());
      await user.keyboard('{Escape}');
      await gone();
      expect(useAboutDialog.getState().open).toBe(false);

      act(() => openAbout());
      await user.click(close());
      await gone();

      act(() => openAbout());
      fireEvent.pointerDown(dialog().parentElement as HTMLElement);
      await gone();
      expect(useAboutDialog.getState().open).toBe(false);
    });

    it('stays open for a press inside the dialog, on its text or on the placeholder', async () => {
      const { user } = setup(<Fixture />);
      act(() => openAbout());
      await user.click(within(dialog()).getByRole('heading', { level: 2 }));
      fireEvent.pointerDown(dialog());
      await user.click(licenses());
      expect(dialog()).not.toBeNull();
    });

    it('handles Esc for itself: the key is claimed, so the shell does not also release the active tool', async () => {
      setup(<Fixture />);
      act(() => openAbout());
      const event = new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true });
      act(() => void document.activeElement?.dispatchEvent(event));
      expect(event.defaultPrevented).toBe(true);
      await gone();
    });

    it('closes the tooltip of the placeholder first and the dialog on the next Esc', async () => {
      const { user } = setup(<Fixture />);
      act(() => openAbout());
      act(() => licenses().focus());
      await waitFor(() => expect(openTooltip()).not.toBeNull());
      await user.keyboard('{Escape}');
      await waitFor(() => expect(openTooltip()).toBeNull());
      expect(dialog()).not.toBeNull();
      await user.keyboard('{Escape}');
      await gone();
    });
  });

  it('is above the popovers for Esc too: a popover layer that is somehow open beneath it keeps its turn for the next press', async () => {
    const popover = vi.fn();
    const unregister = registerDismissLayer(DISMISS_PRIORITY.popover, popover);
    try {
      const { user } = setup(<Fixture />);
      act(() => openAbout());
      await user.keyboard('{Escape}');
      await gone();
      expect(popover).not.toHaveBeenCalled();
      await user.keyboard('{Escape}');
      expect(popover).toHaveBeenCalledTimes(1);
    } finally {
      unregister();
    }
  });

  it('is a modal only while it is shown: aria-modal goes when the exit starts, so commands run again while it fades', async () => {
    setup(<Fixture />);
    act(() => openAbout());
    expect(dialog().getAttribute('aria-modal')).toBe('true');
    expect(runAction('settings')).toBe(false);
    MotionGlobalConfig.skipAnimations = false;
    try {
      act(() => useAboutDialog.getState().setOpen(false));
      // Still in the page, fading out: not modal any more, like the focus and the inert app.
      expect(dialog().getAttribute('aria-modal')).toBeNull();
      expect(runAction('settings')).toBe(true);
      expect(useSettingsPopover.getState().open).toBe(true);
      await gone();
    } finally {
      MotionGlobalConfig.skipAnimations = true;
    }
  });

  it('lets no command run behind it from any source, and About closes it', () => {
    setup(<Fixture />);
    act(() => openAbout());
    for (const id of ['open', 'settings', 'zoom-in']) expect(runAction(id), id).toBe(false);
    expect(useSettingsPopover.getState().open).toBe(false);
    expect(screen.getAllByRole('dialog')).toHaveLength(1);
    act(() => void runAction('about'));
    expect(useAboutDialog.getState().open).toBe(false);
  });

  it('opens and closes with the toggle of the about action', () => {
    useSettingsPopover.setState({ open: true });
    setup(<Fixture />);
    act(() => toggleAbout());
    expect(useAboutDialog.getState().open).toBe(true);
    expect(useSettingsPopover.getState().open).toBe(false);
    act(() => toggleAbout());
    expect(useAboutDialog.getState().open).toBe(false);
  });

  it('closes the settings popover when it opens, so Esc closes the dialog and not a popover beneath it', () => {
    useSettingsPopover.setState({ open: true });
    setup(<Fixture />);
    act(() => openAbout());
    expect(useSettingsPopover.getState().open).toBe(false);
    expect(useAboutDialog.getState().open).toBe(true);
  });

  it('closes without a fuss when the element that had focus is gone by then, and puts the app back in reach', async () => {
    const { user } = setup(<Fixture />);
    const vanished = document.body.appendChild(document.createElement('button'));
    vanished.focus();
    act(() => openAbout());
    expect(document.activeElement).toBe(close());
    vanished.remove();
    await user.keyboard('{Escape}');
    await gone();
    expect(document.activeElement).not.toBe(vanished);
    expect((document.getElementById('root') as HTMLElement).hasAttribute('inert')).toBe(false);
  });

  it('lifts the inert from the app when the dialog itself is taken away while it is open', () => {
    const { unmount } = setup(<Fixture />);
    const root = document.getElementById('root') as HTMLElement;
    act(() => openAbout());
    expect(root.hasAttribute('inert')).toBe(true);
    unmount();
    // The element is detached with the fixture, but it must not be left behind inert.
    expect(root.hasAttribute('inert')).toBe(false);
  });

  it('can be opened again after it closed', async () => {
    const { user } = setup(<Fixture />);
    act(() => openAbout());
    await user.keyboard('{Escape}');
    await gone();
    act(() => openAbout());
    expect(dialog()).not.toBeNull();
    expect(document.activeElement).toBe(close());
  });
});

describe('motion', () => {
  /** Every transform value that the dialog's elements carry in their inline style, from the moment it opens. */
  function transformsWhileOpening(): Set<string> {
    const seen = new Set<string>();
    const read = (element: Element) => {
      if (!(element instanceof HTMLElement)) return;
      for (const property of ['transform', 'scale', 'translate']) {
        const value = element.style.getPropertyValue(property);
        if (value !== '' && value !== 'none') seen.add(`${property}: ${value}`);
      }
    };
    const visit = (records: MutationRecord[]) => {
      for (const record of records) {
        if (record.target instanceof Element) read(record.target);
        for (const added of record.addedNodes) {
          if (added instanceof Element) {
            read(added);
            added.querySelectorAll('*').forEach(read);
          }
        }
      }
    };
    const observer = new MutationObserver(visit);
    observer.observe(document.body, { subtree: true, childList: true, attributes: true, attributeFilter: ['style'] });
    act(() => openAbout());
    // The observer reports in a microtask: take what it has now.
    visit(observer.takeRecords());
    observer.disconnect();
    return seen;
  }

  afterEach(() => setReducedMotion(false));

  it('scales in like a popover (opacity and scale .96 to 1) by default', () => {
    setReducedMotion(false);
    setup(<Fixture />);
    expect([...transformsWhileOpening()].some((value) => value.includes('scale'))).toBe(true);
  });

  it('only fades under reduced motion: no transform of any kind', () => {
    setReducedMotion(true);
    setup(<Fixture />);
    expect([...transformsWhileOpening()]).toEqual([]);
    expect(dialog()).not.toBeNull();
  });
});
