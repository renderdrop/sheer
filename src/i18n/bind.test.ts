import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { useSettings } from '../stores/settings';
import { bindLocaleToSettings } from './bind';
import { useLocaleStore } from './store';

/** Stands in for `<html>`: records the attributes it is given. */
class FakeRoot {
  readonly attributes = new Map<string, string>();
  setAttribute(name: string, value: string): void {
    this.attributes.set(name, value);
  }
}

/** The bindings of the running test: the stores are shared, so every one is undone afterwards. */
const unbinders: (() => void)[] = [];

beforeEach(() => {
  useSettings.setState(useSettings.getInitialState(), true);
  useLocaleStore.setState({ locale: 'en' });
});

afterEach(() => {
  for (const unbind of unbinders.splice(0)) unbind();
});

function bind(root: FakeRoot, system: string | undefined): () => void {
  const unbind = bindLocaleToSettings(root, useSettings, useLocaleStore, () => system);
  unbinders.push(unbind);
  return unbind;
}

describe('bindLocaleToSettings', () => {
  it('applies the current setting at once: "system" follows the OS language', () => {
    const german = new FakeRoot();
    bind(german, 'de-AT')();
    expect(german.attributes.get('lang')).toBe('de');
    expect(useLocaleStore.getState().locale).toBe('de');

    const french = new FakeRoot();
    bind(french, 'fr-FR')();
    expect(french.attributes.get('lang')).toBe('en');
    expect(useLocaleStore.getState().locale).toBe('en');
  });

  it('follows the setting when it changes', () => {
    const root = new FakeRoot();
    const unbind = bind(root, 'en-US');
    expect(root.attributes.get('lang')).toBe('en');

    useSettings.setState({ language: 'de' });
    expect(root.attributes.get('lang')).toBe('de');
    expect(useLocaleStore.getState().locale).toBe('de');

    useSettings.setState({ language: 'en' });
    expect(root.attributes.get('lang')).toBe('en');
    expect(useLocaleStore.getState().locale).toBe('en');

    // Back to "system": the OS language decides again.
    useSettings.setState({ language: 'de' });
    useSettings.setState({ language: 'system' });
    expect(root.attributes.get('lang')).toBe('en');
    unbind();
  });

  it('an explicit language wins over the OS language, and the OS language over nothing', () => {
    const root = new FakeRoot();
    useSettings.setState({ language: 'en' });
    bind(root, 'de-DE');
    expect(root.attributes.get('lang')).toBe('en');
    useSettings.setState({ language: 'de' });
    expect(root.attributes.get('lang')).toBe('de');

    const bare = new FakeRoot();
    useSettings.setState({ language: 'system' });
    bind(bare, undefined);
    expect(bare.attributes.get('lang')).toBe('en');
  });

  it('stops following after the unsubscribe function ran', () => {
    const root = new FakeRoot();
    const unbind = bind(root, 'en-US');
    unbind();
    useSettings.setState({ language: 'de' });
    expect(root.attributes.get('lang')).toBe('en');
    expect(useLocaleStore.getState().locale).toBe('en');
  });

  it('a settings update that does not touch the language leaves the locale alone', () => {
    const root = new FakeRoot();
    bind(root, 'de-DE');
    let changes = 0;
    const stop = useLocaleStore.subscribe(() => (changes += 1));
    useSettings.setState({ authorName: 'Ada' });
    useSettings.setState({ leftPanelWidth: 300 });
    stop();
    expect(changes).toBe(0);
    expect(useLocaleStore.getState().locale).toBe('de');
  });
});
