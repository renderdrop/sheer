// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { useLocaleStore } from '../../i18n/store';
import {
  FORMAT_KEY,
  STYLE_KEY,
  DEFAULT_STYLE,
  getCitationFormat,
  getCitationStyle,
  setCitationFormat,
  setCitationStyle,
  useCitationPrefs,
} from './style';

beforeEach(() => {
  localStorage.clear();
  useCitationPrefs.setState({ style: undefined, format: 'txt' });
  useLocaleStore.setState({ locale: 'en' });
});

describe('citation preferences', () => {
  it('starts with APA 7 in every UI language', () => {
    expect(DEFAULT_STYLE).toBe('apa7');
    expect(getCitationStyle()).toBe('apa7');
    useLocaleStore.setState({ locale: 'de' });
    expect(getCitationStyle()).toBe('apa7');
  });

  it('keeps a chosen style over the language and writes it to storage', () => {
    setCitationStyle('mla9');
    useLocaleStore.setState({ locale: 'de' });
    expect(getCitationStyle()).toBe('mla9');
    expect(localStorage.getItem(STYLE_KEY)).toBe('mla9');
  });

  it('remembers the last save format', () => {
    expect(getCitationFormat()).toBe('txt');
    setCitationFormat('bib');
    expect(getCitationFormat()).toBe('bib');
    expect(localStorage.getItem(FORMAT_KEY)).toBe('bib');
  });

  it('survives a storage that throws', () => {
    const spy = vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('full');
    });
    setCitationStyle('chicago17AuthorDate');
    expect(getCitationStyle()).toBe('chicago17AuthorDate');
    spy.mockRestore();
  });
});
