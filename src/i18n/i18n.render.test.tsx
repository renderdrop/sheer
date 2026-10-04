// @vitest-environment jsdom
import { act, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { DocumentInfo } from '../api/documents';
import { Shell } from '../features/shell/Shell';
import { useViewer } from '../features/viewer/useViewer';
import { resetViewer } from '../features/viewer/viewer.testutil';
import { useSettings } from '../stores/settings';
import { opened } from '../stores/documents.testutil';
import { useUi } from '../stores/ui';
import { setup } from '../test/render';
import { bindLocaleToSettings } from './bind';
import { catalogs } from './catalog';

const documentsApi = vi.hoisted(() => ({
  openDocumentDialog: vi.fn(),
  closeDocument: vi.fn(),
}));
const renderApi = vi.hoisted(() => ({ renderPage: vi.fn(), setViewport: vi.fn(), getPageSizes: vi.fn() }));
const windowApi = vi.hoisted(() => ({
  minimizeWindow: vi.fn(),
  toggleMaximizeWindow: vi.fn(),
  closeWindow: vi.fn(),
  isWindowMaximized: vi.fn(),
  isWindowFullscreen: vi.fn(),
}));

vi.mock('../api/documents', () => documentsApi);
vi.mock('../api/render', () => renderApi);
vi.mock('../api/window', () => windowApi);

const uiInitial = useUi.getState();
const settingsInitial = useSettings.getState();

const REPORT: DocumentInfo = { id: 1, pageCount: 120, displayName: 'Quarterly report.pdf' };
const NBSP = String.fromCharCode(0xa0);
const html = document.documentElement;

let unbind: (() => void) | null = null;

/** Changes the `language` setting the way the settings store does after the backend accepted it. */
function chooseLanguage(language: 'system' | 'en' | 'de'): void {
  act(() => useSettings.setState({ language }));
}

beforeEach(() => {
  useUi.setState({ ...uiInitial }, true);
  resetViewer();
  useViewer.setState({ viewport: { width: 900, height: 700 } });
  useSettings.setState({ ...settingsInitial, platform: 'windows' }, true);
  documentsApi.openDocumentDialog.mockReset().mockResolvedValue([opened(REPORT)]);
  renderApi.renderPage.mockReset().mockResolvedValue({ data: new Uint8Array([1]), width: 816, height: 1056 });
  renderApi.setViewport.mockReset().mockResolvedValue(undefined);
  renderApi.getPageSizes.mockReset().mockResolvedValue([]);
  documentsApi.closeDocument.mockReset().mockResolvedValue(undefined);
  for (const mock of Object.values(windowApi)) mock.mockReset().mockResolvedValue(false);
  URL.createObjectURL = vi.fn(() => 'blob:page');
  URL.revokeObjectURL = vi.fn();
  html.removeAttribute('lang');
  unbind = bindLocaleToSettings(html);
});

afterEach(() => {
  unbind?.();
  unbind = null;
  vi.restoreAllMocks();
  useUi.setState({ ...uiInitial }, true);
  resetViewer();
  useSettings.setState(settingsInitial, true);
});

describe('the language setting', () => {
  it('switching it changes the rendered text and <html lang>', () => {
    setup(<Shell />);
    // jsdom reports "en-US": "system" is English.
    expect(html.lang).toBe('en');
    expect(screen.getByRole('heading', { level: 1, name: 'Drop a PDF here.' })).not.toBeNull();
    expect(screen.getByRole('button', { name: /^(Or open|Open)$/ })).not.toBeNull();

    chooseLanguage('de');
    expect(html.lang).toBe('de');
    expect(screen.getByRole('group', { name: 'Fenstersteuerung' })).not.toBeNull();
    expect(screen.getByRole('heading', { level: 1, name: 'PDF hier ablegen.' })).not.toBeNull();
    expect(screen.getByRole('button', { name: /^(Oder öffnen|Öffnen)$/ })).not.toBeNull();
    expect(screen.queryByRole('group', { name: 'Window controls' })).toBeNull();

    chooseLanguage('en');
    expect(html.lang).toBe('en');
    expect(screen.getByRole('heading', { level: 1, name: 'Drop a PDF here.' })).not.toBeNull();
    expect(screen.queryByText('PDF öffnen')).toBeNull();
  });

  it('"system" follows the OS language when the UI starts', () => {
    unbind?.();
    vi.spyOn(window.navigator, 'language', 'get').mockReturnValue('de-AT');
    html.removeAttribute('lang');
    unbind = bindLocaleToSettings(html);
    expect(html.lang).toBe('de');
    setup(<Shell />);
    expect(screen.getByRole('heading', { level: 1, name: 'PDF hier ablegen.' })).not.toBeNull();

    // An explicit choice overrides the OS.
    chooseLanguage('en');
    expect(html.lang).toBe('en');
    expect(screen.getByRole('heading', { level: 1, name: 'Drop a PDF here.' })).not.toBeNull();
  });

  it('the announced shortcut of Open stays canonical in both languages on Windows', () => {
    act(() => useSettings.setState({ platform: 'windows' }));
    setup(<Shell />);
    const open = () => screen.getByRole('button', { name: /^(Or open|Oder öffnen)$/ });
    expect(open().getAttribute('aria-keyshortcuts')).toBe('Control+O');
    chooseLanguage('de');
    expect(open().getAttribute('aria-keyshortcuts')).toBe('Control+O');
    chooseLanguage('en');
    expect(open().getAttribute('aria-keyshortcuts')).toBe('Control+O');
  });

  it('on macOS the announced shortcut is the same in both languages', () => {
    act(() => useSettings.setState({ platform: 'macos' }));
    setup(<Shell />);
    const open = () => screen.getByRole('button', { name: /^(Or open|Oder öffnen)$/ });
    expect(open().getAttribute('aria-keyshortcuts')).toBe('Meta+O');
    chooseLanguage('de');
    expect(open().getAttribute('aria-keyshortcuts')).toBe('Meta+O');
  });

  it('the tool sidebar, its rows and the page sidebar chevron follow the language', async () => {
    const { user } = setup(<Shell />);
    await user.click(screen.getByRole('button', { name: /^(Or open|Open)$/ }));
    await screen.findByRole('img', { name: /^Page 1 of/ });
    chooseLanguage('de');
    // jsdom is narrower than 1100: the tool sidebar is its rail here, so the window is widened for the full sidebar.
    act(() => {
      Object.defineProperty(window, 'innerWidth', { value: 1280, configurable: true, writable: true });
      window.dispatchEvent(new Event('resize'));
    });
    const tools = screen.getByRole('complementary', { name: 'Eigenschaften' });
    expect(within(tools).getByRole('heading', { name: 'Werkzeuge' })).not.toBeNull();
    for (const name of [
      'Auswählen',
      'Markieren',
      'Text',
      'Zeichnen',
      'Kommentar',
      'Signatur',
      'Formen',
      'Bilder',
      'Seiten organisieren',
      'PDF exportieren',
      'Mehr',
    ]) {
      expect(within(tools).getByRole('button', { name }), name).not.toBeNull();
    }
    expect(screen.getByRole('button', { name: 'Seitenleiste ausblenden' })).not.toBeNull();
  });

  it('with a document open the panels, canvas and top bar are German, and plurals follow the language', async () => {
    const { user } = setup(<Shell />);
    await user.click(screen.getByRole('button', { name: /^(Or open|Open)$/ }));
    await screen.findByRole('img', { name: /^Page 1 of/ });
    const separator = screen.getByRole('separator', { name: 'Resize left panel' });
    expect(separator.getAttribute('aria-valuetext')).toBe('200 pixels');

    chooseLanguage('de');
    expect(screen.getByRole('img', { name: 'Seite 1 von 120' })).not.toBeNull();
    expect(screen.getByRole('complementary', { name: 'Linke Seitenleiste' })).not.toBeNull();
    expect(screen.getByRole('separator', { name: 'Breite der Seitenleiste ändern' })).not.toBeNull();
    expect(
      screen.getByRole('separator', { name: 'Breite der Seitenleiste ändern' }).getAttribute('aria-valuetext'),
    ).toBe('200 Pixel');
    expect(screen.getByRole('region', { name: 'Dokument' })).not.toBeNull();
    for (const tab of ['Seiten', 'Gliederung', 'Kommentare', 'Suche']) {
      expect(screen.getByRole('tab', { name: tab }), tab).not.toBeNull();
    }
    const topbar = within(document.querySelector<HTMLElement>('[data-slot="topbar"]') as HTMLElement);
    expect(topbar.getByRole('textbox', { name: 'Zu Seite springen' })).not.toBeNull();
    expect(topbar.getByRole('button', { name: `100${NBSP}% · Zoomstufe` })).not.toBeNull();
    expect(topbar.getByRole('button', { name: 'Fertig' })).not.toBeNull();
  });

  it('page numbers are written in the language of the UI', async () => {
    documentsApi.openDocumentDialog.mockResolvedValue([opened({ id: 1, pageCount: 12000, displayName: 'Big.pdf' })]);
    const { user } = setup(<Shell />);
    await user.click(screen.getByRole('button', { name: /^(Or open|Open)$/ }));
    await screen.findByRole('img', { name: /^Page 1 of/ });
    expect(screen.getByRole('img', { name: 'Page 1 of 12,000' })).not.toBeNull();
    chooseLanguage('de');
    expect(screen.getByRole('img', { name: 'Seite 1 von 12.000' })).not.toBeNull();
    const field = screen.getByRole('textbox', { name: 'Zu Seite springen' });
    expect(field.parentElement?.textContent).toBe('/ 12.000');
  });

  it('an error in the banner is translated, and so is its dismiss button', () => {
    setup(<Shell />);
    act(() =>
      useUi.getState().showBanner({
        code: 'limit_exceeded',
        key: 'error.limit_exceeded',
        retryable: false,
        params: { what: 'documents' },
      }),
    );
    expect(screen.getByRole('alert').textContent).toContain('Too many documents are open.');
    chooseLanguage('de');
    const alert = screen.getByRole('alert');
    expect(alert.textContent).toContain('Es sind zu viele Dokumente geöffnet.');
    expect(within(alert).getByRole('button', { name: 'Ausblenden' })).not.toBeNull();
  });

  it('the Windows caption buttons are translated', () => {
    setup(<Shell />);
    chooseLanguage('de');
    const controls = screen.getByRole('group', { name: 'Fenstersteuerung' });
    for (const name of ['Minimieren', 'Maximieren', 'Schließen']) {
      expect(within(controls).getByRole('button', { name }), name).not.toBeNull();
    }
  });

  it('no English text of the shell is left over in the German UI', async () => {
    const { user, container } = setup(<Shell />);
    await user.click(screen.getByRole('button', { name: /^(Or open|Open)$/ }));
    await screen.findByRole('img', { name: /^Page 1 of/ });
    act(() => useUi.getState().showBanner({ code: 'internal', key: 'error.internal', retryable: false }));
    chooseLanguage('de');

    // What a user or a screen reader gets: the visible text of every element, and the label attributes.
    const shown = new Set<string>();
    for (const element of container.querySelectorAll('*')) {
      for (const attribute of ['aria-label', 'alt', 'title', 'aria-valuetext', 'aria-description']) {
        const value = element.getAttribute(attribute);
        if (value !== null) shown.add(value);
      }
      if (element.children.length === 0 && element.textContent) shown.add(element.textContent.trim());
    }
    const english = Object.entries(catalogs.en)
      // The menu.* texts are for the macOS menu bar, which Rust labels; the webview never shows them ("Zoom" is also a toolbar label).
      .filter(([key, message]) => !key.startsWith('menu.') && message !== catalogs.de[key] && !message.includes('{'))
      .map(([, message]) => message);
    expect(english.filter((message) => shown.has(message))).toEqual([]);
    // The check can see text at all.
    expect(shown.has('Dokument')).toBe(true);
    expect(shown.has('Es ist ein Fehler aufgetreten.')).toBe(true);
  });

  it('no "undefined", "null", "NaN", object text or unfilled {placeholder} reaches the screen in either language', async () => {
    const { user, container } = setup(<Shell />);
    await user.click(screen.getByRole('button', { name: /^(Or open|Open)$/ }));
    await screen.findByRole('img', { name: /^Page 1 of/ });
    act(() => useUi.getState().showBanner({ code: 'limit_exceeded', key: 'error.limit_exceeded', retryable: false }));

    const broken = /undefined|\bnull\b|NaN|\[object|\{\w+\}/;
    const everythingShown = (): string[] => {
      const shown: string[] = [];
      for (const element of container.querySelectorAll('*')) {
        for (const attribute of ['aria-label', 'alt', 'title', 'aria-valuetext', 'aria-description']) {
          const value = element.getAttribute(attribute);
          if (value !== null) shown.push(value);
        }
        if (element.children.length === 0 && element.textContent) shown.push(element.textContent);
      }
      return shown;
    };

    for (const language of ['en', 'de', 'system'] as const) {
      chooseLanguage(language);
      const shown = everythingShown();
      expect(shown.length, language).toBeGreaterThan(10);
      expect(
        shown.filter((text) => broken.test(text)),
        language,
      ).toEqual([]);
    }
  });
});

vi.mock('../api/pages', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../api/pages')>()),
  getPages: vi.fn().mockResolvedValue([]),
}));
