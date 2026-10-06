// @vitest-environment jsdom
import { beforeEach, describe, expect, it } from 'vitest';

import { ENABLED_KEY, MAX_VISITED, smartLinksOn, useSmartLinks } from './store';

beforeEach(() => {
  globalThis.localStorage.clear();
  useSmartLinks.setState({ enabled: true, overrides: {}, visited: {} });
});

describe('the smart links switch (L8)', () => {
  it('is on by default and for every tab', () => {
    expect(smartLinksOn(useSmartLinks.getState(), 1)).toBe(true);
  });

  it('the global switch is stored under sheer.smartLinks.enabled', () => {
    useSmartLinks.getState().setEnabled(false);
    expect(ENABLED_KEY).toBe('sheer.smartLinks.enabled');
    expect(globalThis.localStorage.getItem(ENABLED_KEY)).toBe('off');
    useSmartLinks.getState().setEnabled(true);
    expect(globalThis.localStorage.getItem(ENABLED_KEY)).toBe('on');
  });

  it('a tab override only changes that tab', () => {
    useSmartLinks.getState().setForDoc(1, false);
    expect(smartLinksOn(useSmartLinks.getState(), 1)).toBe(false);
    expect(smartLinksOn(useSmartLinks.getState(), 2)).toBe(true);
  });

  it('turning a tab back to the global value is no override', () => {
    useSmartLinks.getState().setForDoc(1, false);
    useSmartLinks.getState().setForDoc(1, true);
    expect(useSmartLinks.getState().overrides).toEqual({});
  });

  it('changing the global switch applies to every tab and clears their overrides', () => {
    useSmartLinks.getState().setForDoc(1, false);
    useSmartLinks.getState().setForDoc(2, false);
    useSmartLinks.getState().setEnabled(false);
    expect(useSmartLinks.getState().overrides).toEqual({});
    expect(smartLinksOn(useSmartLinks.getState(), 1)).toBe(false);
    expect(smartLinksOn(useSmartLinks.getState(), 2)).toBe(false);
  });
});

describe('visited links', () => {
  it('are kept per tab, once each, and forgotten with the tab', () => {
    const { markVisited, forget } = useSmartLinks.getState();
    markVisited(1, 'a');
    markVisited(1, 'a');
    markVisited(2, 'b');
    expect(useSmartLinks.getState().visited).toEqual({ 1: ['a'], 2: ['b'] });
    forget(1);
    expect(useSmartLinks.getState().visited).toEqual({ 2: ['b'] });
  });

  it('are bounded', () => {
    for (let i = 0; i < MAX_VISITED + 5; i += 1) useSmartLinks.getState().markVisited(1, `k${i}`);
    expect(useSmartLinks.getState().visited[1]).toHaveLength(MAX_VISITED);
    expect(useSmartLinks.getState().visited[1]?.at(-1)).toBe(`k${MAX_VISITED + 4}`);
  });
});
