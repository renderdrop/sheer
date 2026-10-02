// @vitest-environment jsdom
import { act, renderHook, waitFor } from '@testing-library/react';
import { GalleryVertical, ListTree } from 'lucide-react';
import { useState } from 'react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { openTooltip, setup } from '../test/render';
import { DURATION, ENTER_SCALE, EASE_OUT, useFade, usePanelFade, usePopoverMotion, useRevealMotion } from './motion';
import { Popover } from './Popover';
import { Tab, TabList, Tabs } from './Tabs';
import { Tooltip } from './Tooltip';

/**
 * Motion reads `(prefers-reduced-motion)` through `matchMedia`, once, and then follows its `change` event. The stub
 * below lets a test switch the preference the way a user does in the OS: flip it and fire `change`.
 */
let preference = false;
const listeners = new Set<() => void>();

function setReducedMotion(reduce: boolean): void {
  preference = reduce;
  for (const listener of listeners) listener();
}

function mediaQueryList(query: string): MediaQueryList {
  const list: Partial<MediaQueryList> = {
    get matches() {
      return preference && query.includes('prefers-reduced-motion');
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
  };
  return list as MediaQueryList;
}

window.matchMedia = mediaQueryList;

/** Every `transform`, `scale`, `translate` or `rotate` value an element ever carried in its inline style. */
function recordTransforms(root: Node): { seen: Set<string>; stop: () => void } {
  const seen = new Set<string>();
  const read = (element: Element) => {
    if (!(element instanceof HTMLElement)) return;
    for (const property of ['transform', 'scale', 'translate', 'rotate']) {
      const value = element.style.getPropertyValue(property);
      if (value !== '' && value !== 'none') seen.add(`${property}: ${value}`);
    }
  };
  const observer = new MutationObserver((records) => {
    for (const record of records) {
      if (record.target instanceof Element) read(record.target);
      for (const added of record.addedNodes) {
        if (added instanceof Element) {
          read(added);
          added.querySelectorAll('*').forEach(read);
        }
      }
    }
  });
  observer.observe(root, { subtree: true, childList: true, attributes: true, attributeFilter: ['style'] });
  return { seen, stop: () => observer.disconnect() };
}

/** The opacity-only shape of a Motion target: no key besides `opacity` and `transition`. */
const transformKeys = (target: object) =>
  Object.keys(target).filter((key) => key !== 'opacity' && key !== 'transition');

beforeEach(() => setReducedMotion(true));
afterEach(() => setReducedMotion(false));

describe('motion presets under reduced motion', () => {
  it('the popover only fades: no scale on the way in, none on the way out, 150 ms ease-out both ways', () => {
    const { result } = renderHook(() => usePopoverMotion());
    expect(result.current.initial).toEqual({ opacity: 0 });
    expect(transformKeys(result.current.animate)).toEqual([]);
    expect(transformKeys(result.current.exit)).toEqual([]);
    expect(result.current.animate.transition).toEqual({ duration: DURATION.fast, ease: EASE_OUT });
    expect(result.current.exit.transition).toEqual({ duration: DURATION.fast, ease: EASE_OUT });
  });

  it('the tooltip fade keeps to opacity and uses the same 150 ms in and out whatever timings it is asked for', () => {
    const { result } = renderHook(() => useFade(DURATION.slow, DURATION.tooltipOut));
    expect(transformKeys(result.current.initial)).toEqual([]);
    expect(result.current.animate.transition).toEqual({ duration: DURATION.fast, ease: EASE_OUT });
    expect(result.current.exit.transition).toEqual({ duration: DURATION.fast, ease: EASE_OUT });
  });

  it('the banner row only fades: no height, 150 ms ease-out both ways', () => {
    const { result } = renderHook(() => useRevealMotion());
    expect(result.current.initial).toEqual({ opacity: 0 });
    expect(transformKeys(result.current.animate)).toEqual([]);
    expect(transformKeys(result.current.exit)).toEqual([]);
    expect(result.current.animate.transition).toEqual({ duration: DURATION.fast, ease: EASE_OUT });
    expect(result.current.exit.transition).toEqual({ duration: DURATION.fast, ease: EASE_OUT });
  });

  it('the left panel only fades: 150 ms ease-out both ways, with nothing but its opacity in the target', () => {
    const { result } = renderHook(() => usePanelFade());
    expect(result.current.initial).toEqual({ opacity: 0 });
    expect(transformKeys(result.current.animate)).toEqual([]);
    expect(transformKeys(result.current.exit)).toEqual([]);
    expect(result.current.animate.transition).toEqual({ duration: DURATION.fast, ease: EASE_OUT });
    expect(result.current.exit.transition).toEqual({ duration: DURATION.fast, ease: EASE_OUT });
  });

  it('control: without the preference the left panel fades over 250 ms ease-out, in step with its grid track', () => {
    setReducedMotion(false);
    const { result } = renderHook(() => usePanelFade());
    expect(result.current.initial).toEqual({ opacity: 0 });
    expect(transformKeys(result.current.animate)).toEqual([]);
    expect(result.current.animate.transition).toEqual({ duration: DURATION.slow, ease: EASE_OUT });
    expect(result.current.exit.transition).toEqual({ duration: DURATION.slow, ease: EASE_OUT });
  });

  it('control: without the preference the banner row moves its height with its opacity, 250 ms ease-out both ways', () => {
    setReducedMotion(false);
    const { result } = renderHook(() => useRevealMotion());
    expect(result.current.initial).toEqual({ height: 0, opacity: 0 });
    expect(result.current.animate).toMatchObject({ height: 'auto', opacity: 1 });
    expect(result.current.exit).toMatchObject({ height: 0, opacity: 0 });
    expect(result.current.animate.transition).toEqual({ duration: DURATION.slow, ease: EASE_OUT });
    expect(result.current.exit.transition).toEqual({ duration: DURATION.slow, ease: EASE_OUT });
  });

  it('control: without the preference the popover does scale in from the entrance scale', () => {
    setReducedMotion(false);
    const { result } = renderHook(() => usePopoverMotion());
    expect(result.current.initial).toMatchObject({ opacity: 0, scale: ENTER_SCALE });
    expect(result.current.animate).toMatchObject({ opacity: 1, scale: 1 });
  });
});

describe('components under reduced motion', () => {
  it('a popover opens and closes without ever carrying a transform, and still works', async () => {
    const { user, getByRole, queryByRole } = setup(
      <Popover label="Zoom" trigger={(trigger) => <button {...trigger}>Open</button>}>
        <button type="button">Apply</button>
      </Popover>,
    );
    const recorder = recordTransforms(document.body);
    await user.click(getByRole('button', { name: 'Open' }));
    const dialog = getByRole('dialog', { name: 'Zoom' });
    expect(document.activeElement).toBe(getByRole('button', { name: 'Apply' }));
    expect(dialog.style.getPropertyValue('transform')).not.toMatch(/scale/);

    await user.keyboard('{Escape}');
    await waitFor(() => expect(queryByRole('dialog')).toBeNull());
    expect(document.activeElement).toBe(getByRole('button', { name: 'Open' }));
    recorder.stop();
    expect([...recorder.seen].filter((value) => /scale|translate|rotate/.test(value))).toEqual([]);
  });

  it('control: the same popover does start from a scaled-down transform without the preference', async () => {
    setReducedMotion(false);
    const { user, getByRole } = setup(
      <Popover label="Zoom" trigger={(trigger) => <button {...trigger}>Open</button>}>
        <button type="button">Apply</button>
      </Popover>,
    );
    const recorder = recordTransforms(document.body);
    await user.click(getByRole('button', { name: 'Open' }));
    recorder.stop();
    expect([...recorder.seen].some((value) => /scale/.test(value))).toBe(true);
  });

  it('a tooltip still opens, and without a transform', async () => {
    const { user, getByRole } = setup(
      <Tooltip label="Zoom in">
        <button type="button">Anchor</button>
      </Tooltip>,
    );
    const recorder = recordTransforms(document.body);
    await user.tab();
    expect(document.activeElement).toBe(getByRole('button', { name: 'Anchor' }));
    await waitFor(() => expect(openTooltip()).not.toBeNull(), { timeout: 2000 });
    expect(openTooltip()?.textContent).toContain('Zoom in');
    recorder.stop();
    expect([...recorder.seen].filter((value) => /scale|translate|rotate/.test(value))).toEqual([]);
  });

  it('moving the selection leaves one fill, inside the selected tab, and never a transform', async () => {
    function Demo() {
      const [value, setValue] = useState('a');
      return (
        <Tabs value={value} onValueChange={setValue}>
          <TabList label="Views">
            <Tab value="a" label="Thumbnails" icon={GalleryVertical} />
            <Tab value="b" label="Outline" icon={ListTree} />
          </TabList>
        </Tabs>
      );
    }
    const { user, getByRole } = setup(<Demo />);
    const recorder = recordTransforms(document.body);
    await user.click(getByRole('tab', { name: 'Outline' }));
    await act(async () => undefined);
    expect(getByRole('tab', { name: 'Outline' }).getAttribute('aria-selected')).toBe('true');
    const indicators = document.querySelectorAll('[role="tab"] > span[aria-hidden="true"].absolute');
    expect(indicators).toHaveLength(1);
    expect(getByRole('tab', { name: 'Outline' }).contains(indicators[0] ?? null)).toBe(true);
    recorder.stop();
    expect([...recorder.seen]).toEqual([]);
  });
});
