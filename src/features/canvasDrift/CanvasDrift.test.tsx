// @vitest-environment jsdom
import { readFileSync } from 'node:fs';
import { act, cleanup, render, renderHook } from '@testing-library/react';
import { MotionGlobalConfig } from 'motion/react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { runAction } from '../../actions/dispatch';
import de from '../../i18n/locales/de.json';
import en from '../../i18n/locales/en.json';
import { useUi } from '../../stores/ui';
import { useMarginPrefs } from '../margin/store';
import { useMenuEntries } from '../shell/useMenuEntries';
import { PageLayout, buildMetrics } from '../viewer/layout';
import { CanvasDrift } from './CanvasDrift';
import { maskRects, placeShapes } from './geometry';
import { useDriftPrefs } from './store';

const layout = () =>
  new PageLayout(
    buildMetrics(
      [
        [612, 792],
        [612, 792],
        [612, 792],
      ],
      'continuous',
    ),
    { zoom: 1, gap: 16, viewport: { width: 1400, height: 900 }, current: 0 },
  );

beforeEach(() => {
  useDriftPrefs.setState({ enabled: true });
  useUi.setState({ mode: 'read' });
});
afterEach(() => {
  cleanup();
  MotionGlobalConfig.skipAnimations = false;
});

describe('maskRects', () => {
  const frame = { left: 100, top: 100, width: 200, height: 200 };

  it('cuts a page and keeps the clearance around it, in the frame coordinates', () => {
    // The page inflated by 16 is 184..616 x -16..166; clipped to the frame that is 84..200 x 0..66 from the frame's corner.
    expect(maskRects(frame, [{ left: 200, top: 0, width: 400, height: 150 }], 16)).toEqual([
      { left: 84, top: 0, width: 116, height: 66 },
    ]);
  });

  it('leaves out an obstacle further away than the clearance, and keeps one just inside it', () => {
    expect(maskRects(frame, [{ left: 0, top: 100, width: 100 - 17, height: 200 }], 16)).toEqual([]);
    expect(maskRects(frame, [{ left: 0, top: 100, width: 100 - 15, height: 200 }], 16)).toHaveLength(1);
  });
});

describe('placeShapes', () => {
  it('gives up to three shapes, fewer for a short document, none for an empty one', () => {
    const sizes = [360, 200, 280] as const;
    const gutter = { left: 100, right: 700 };
    expect(placeShapes({ width: 800, height: 900 }, gutter, sizes)).toHaveLength(1);
    expect(placeShapes({ width: 800, height: 20000 }, gutter, sizes)).toHaveLength(3);
    expect(placeShapes({ width: 0, height: 20000 }, gutter, sizes)).toEqual([]);
  });
});

describe('CanvasDrift', () => {
  it('draws masked shapes in document view, aria-hidden', () => {
    const { container } = render(<CanvasDrift layout={layout()} margin />);
    const frames = container.querySelectorAll<HTMLElement>('[data-drift-frame]');
    expect(frames.length).toBeGreaterThan(0);
    expect(frames[0]?.getAttribute('style')).toContain('data:image/svg+xml');
    expect(container.querySelector('[data-canvas-drift]')?.getAttribute('aria-hidden')).toBe('true');
  });

  it('shows no shapes in Seiten mode', () => {
    useUi.setState({ mode: 'pages' });
    const { container } = render(<CanvasDrift layout={layout()} margin={false} />);
    expect(container.querySelector('[data-canvas-drift]')).toBeNull();
  });

  it('shows no shapes when the switch is off', () => {
    useDriftPrefs.getState().setEnabled(false);
    const { container } = render(<CanvasDrift layout={layout()} margin={false} />);
    expect(container.querySelector('[data-canvas-drift]')).toBeNull();
  });

  it('is live normally and static with reduced motion', () => {
    const live = render(<CanvasDrift layout={layout()} margin={false} />);
    expect(live.container.querySelector('[data-canvas-drift]')?.getAttribute('data-drift')).toBe('live');
    live.unmount();
    MotionGlobalConfig.skipAnimations = true;
    const still = render(<CanvasDrift layout={layout()} margin={false} />);
    expect(still.container.querySelector('[data-canvas-drift]')?.getAttribute('data-drift')).toBe('static');
  });

  it('pauses when the window loses focus', () => {
    const { container } = render(<CanvasDrift layout={layout()} margin={false} />);
    const root = () => container.querySelector('[data-canvas-drift]');
    const focus = (on: boolean) => {
      document.hasFocus = () => on;
      act(() => {
        window.dispatchEvent(new Event(on ? 'focus' : 'blur'));
      });
    };
    focus(false);
    expect(root()?.getAttribute('data-paused')).toBe('true');
    focus(true);
    expect(root()?.getAttribute('data-paused')).toBe('false');
  });
});

describe('View > Comments in margin', () => {
  it('toggles the shared preference through the registered action', () => {
    useMarginPrefs.getState().setEnabled(true);
    runAction('toggle-margin-comments');
    expect(useMarginPrefs.getState().enabled).toBe(false);
    runAction('toggle-margin-comments');
    expect(useMarginPrefs.getState().enabled).toBe(true);
  });

  it('shows its check in the menu in step with the preference, with en and de texts', () => {
    useMarginPrefs.getState().setEnabled(false);
    const { result } = renderHook(() => useMenuEntries('view', () => undefined));
    const entry = () =>
      result.current.find((item) => 'id' in item && item.id === 'toggle-margin-comments') as
        { checked?: boolean } | undefined;
    expect(entry()?.checked).toBe(false);
    act(() => useMarginPrefs.getState().setEnabled(true));
    expect(entry()?.checked).toBe(true);
    expect(en['menu.view.marginComments']).toBe('Comments in Margin');
    expect(de['menu.view.marginComments']).toBe('Kommentare am Rand');
  });
});

describe('page shadow clearance', () => {
  it('no shape frame content survives inside a page inflated by the shadow reach (blur 30, offset-y 8)', () => {
    const reach = { left: 30, right: 30, top: 22, bottom: 38 };
    const clearance = Number.parseFloat(
      /--gap-shape-clearance:\s*(\d+)px/.exec(readFileSync('src/styles/tokens.css', 'utf8'))?.[1] ?? '0',
    );
    expect(clearance).toBeGreaterThanOrEqual(Math.max(...Object.values(reach)));
    const page = { left: 300, top: 300, width: 400, height: 500 };
    // Frames approaching the page from below and from the side: the cut must reach the shadow's far edge.
    const below = { left: 400, top: page.top + page.height + 20, width: 100, height: 100 };
    const [cut] = maskRects(below, [page], clearance);
    expect(cut?.top).toBe(0);
    expect(cut?.height).toBeGreaterThanOrEqual(page.top + page.height + reach.bottom - below.top);
    const beside = { left: page.left + page.width + 10, top: 400, width: 100, height: 100 };
    const [side] = maskRects(beside, [page], clearance);
    expect(side?.width).toBeGreaterThanOrEqual(page.left + page.width + reach.right - beside.left);
  });
});
