// @vitest-environment jsdom
import { act, screen, waitFor, within } from '@testing-library/react';
import { MotionGlobalConfig } from 'motion/react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { AppError } from '../../api/errors';
import { setup } from '../../test/render';
import { useUi } from '../../stores/ui';
import { BannerRow } from './Banner';

/** The OS preference, the way reducedMotion.test.tsx stubs it: Motion reads `matchMedia` once and follows its `change` event. */
let reduce = false;
const listeners = new Set<() => void>();
window.matchMedia = (query: string): MediaQueryList =>
  ({
    get matches() {
      return reduce && query.includes('prefers-reduced-motion');
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

function setReducedMotion(value: boolean): void {
  reduce = value;
  for (const listener of listeners) listener();
}

const uiInitial = useUi.getState();
const DAMAGED: AppError = { code: 'damaged_file', key: 'error.damaged_file', retryable: false };

beforeEach(() => {
  useUi.setState({ ...uiInitial }, true);
  setReducedMotion(false);
});

afterEach(() => {
  useUi.setState({ ...uiInitial }, true);
  setReducedMotion(false);
});

/** Every `height` and `opacity` value an element in `root` ever carried in its inline style. */
function recordStyles(root: Node): { heights: Set<string>; opacities: Set<string>; stop: () => void } {
  const heights = new Set<string>();
  const opacities = new Set<string>();
  const read = (element: Element) => {
    if (!(element instanceof HTMLElement)) return;
    const height = element.style.getPropertyValue('height');
    const opacity = element.style.getPropertyValue('opacity');
    if (height !== '') heights.add(height);
    if (opacity !== '') opacities.add(opacity);
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
  return { heights, opacities, stop: () => observer.disconnect() };
}

describe('the banner row (DESIGN 3.12)', () => {
  it('shows nothing without an error and the error as an alert with a Dismiss button when there is one', () => {
    setup(<BannerRow />);
    expect(screen.queryByRole('alert')).toBeNull();
    act(() => useUi.getState().showBanner(DAMAGED));
    const alert = screen.getByRole('alert');
    expect(alert.textContent).toContain('This PDF is damaged and could not be displayed.');
    expect(within(alert).getByRole('button', { name: 'Dismiss' })).not.toBeNull();
  });

  it('is persistent: Esc does not dismiss it, the Dismiss button does and clears the error in the store', async () => {
    const { user } = setup(<BannerRow />);
    act(() => useUi.getState().showBanner(DAMAGED));
    await user.keyboard('{Escape}');
    expect(screen.getByRole('alert')).not.toBeNull();
    await user.click(within(screen.getByRole('alert')).getByRole('button', { name: 'Dismiss' }));
    expect(useUi.getState().banner).toBeNull();
    await waitFor(() => expect(screen.queryByRole('alert')).toBeNull());
  });

  it('a second error replaces the first in the same row', () => {
    setup(<BannerRow />);
    act(() => useUi.getState().showBanner(DAMAGED));
    act(() => useUi.getState().showBanner({ code: 'not_a_pdf', key: 'error.not_a_pdf', retryable: false }));
    expect(screen.getAllByRole('alert')).toHaveLength(1);
    expect(screen.getByRole('alert').textContent).not.toContain('damaged');
  });

  it('is in the flow of the page, at least 48 high, with its gutters inside the element that animates the height', () => {
    const { container } = setup(<BannerRow />);
    act(() => useUi.getState().showBanner(DAMAGED));
    const alert = screen.getByRole('alert');
    expect(alert.className).toContain('min-h-banner-min');
    expect(alert.className).toContain('glass-1');
    const row = container.firstElementChild;
    expect(row?.className).toContain('shrink-0');
    expect(row?.contains(alert)).toBe(true);
    expect(row?.className).not.toMatch(/absolute|fixed|sticky/);
    // The row that grows from height 0 has no padding of its own (it could not be shorter than that: an 8 px jump); the 8 px
    // gutters at the sides and below are padding of the element between it and the alert.
    expect(row?.className).not.toMatch(/(^|\s)-?(p|px|py|pt|pb|ps|pe|pl|pr)-/);
    expect(alert.parentElement?.parentElement).toBe(row);
    expect(alert.parentElement?.className).toContain('px-1');
    expect(alert.parentElement?.className).toContain('pb-1');
  });

  describe('motion (DESIGN 3.12: height and opacity, 250 ms; reduced: opacity only)', () => {
    // The shared test setup finishes animations at once; here they run, so the way there can be seen (a quarter of a second).
    beforeEach(() => {
      MotionGlobalConfig.skipAnimations = false;
    });
    afterEach(() => {
      MotionGlobalConfig.skipAnimations = true;
    });

    it('opens from zero height and opacity, so it pushes the content down instead of jumping in', async () => {
      const { container } = setup(<BannerRow />);
      const recorder = recordStyles(container);
      act(() => useUi.getState().showBanner(DAMAGED));
      const row = container.firstElementChild as HTMLElement;
      expect(row.style.height).toBe('0px');
      expect(row.style.opacity).toBe('0');
      // The content is clipped while the row is still short ...
      await waitFor(() => expect(row.className).toContain('overflow-hidden'), { timeout: 2000 });
      // ... and at rest the row is as high as its content and opaque, and nothing is clipped: the glass shadow reaches
      // beyond the row.
      await waitFor(() => expect(row.style.opacity).toBe('1'), { timeout: 2000 });
      await waitFor(() => expect(row.style.height).toBe('auto'), { timeout: 2000 });
      await waitFor(() => expect(row.className).toContain('overflow-visible'), { timeout: 2000 });
      expect(row.className).not.toContain('overflow-hidden');
      recorder.stop();
      expect(recorder.heights).toContain('0px');
    });

    it('closes the same way back: the row stays while it shrinks and fades, then leaves', async () => {
      const { container, user } = setup(<BannerRow />);
      act(() => useUi.getState().showBanner(DAMAGED));
      const row = container.firstElementChild as HTMLElement;
      await waitFor(() => expect(row.className).toContain('overflow-visible'), { timeout: 2000 });
      const recorder = recordStyles(container);
      await user.click(screen.getByRole('button', { name: 'Dismiss' }));
      // The error is gone from the store at once; the row is still there, on its way out, and clips again.
      expect(useUi.getState().banner).toBeNull();
      expect(screen.queryByRole('alert')).not.toBeNull();
      expect(row.className).toContain('overflow-hidden');
      await waitFor(() => expect(screen.queryByRole('alert')).toBeNull(), { timeout: 2000 });
      recorder.stop();
      expect(recorder.heights.size).toBeGreaterThan(0);
      expect(recorder.opacities.size).toBeGreaterThan(0);
    });

    it('an error that is there at the first paint does not open from zero', () => {
      useUi.setState({ banner: DAMAGED });
      const { container } = setup(<BannerRow />);
      const row = container.firstElementChild as HTMLElement;
      expect(row.style.height).not.toBe('0px');
      expect(row.style.opacity).not.toBe('0');
      expect(row.className).toContain('overflow-visible');
    });

    it('under reduced motion it only fades: the height is never set, and the opacity starts at 0', async () => {
      setReducedMotion(true);
      const { container, user } = setup(<BannerRow />);
      const recorder = recordStyles(container);
      act(() => useUi.getState().showBanner(DAMAGED));
      const row = container.firstElementChild as HTMLElement;
      expect(row.style.opacity).toBe('0');
      await waitFor(() => expect(row.style.opacity).toBe('1'), { timeout: 2000 });
      await user.click(screen.getByRole('button', { name: 'Dismiss' }));
      await waitFor(() => expect(screen.queryByRole('alert')).toBeNull(), { timeout: 2000 });
      recorder.stop();
      expect([...recorder.heights]).toEqual([]);
    });
  });
});
