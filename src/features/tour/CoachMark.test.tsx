// @vitest-environment jsdom
import { act, screen } from '@testing-library/react';
import { useState } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { setup } from '../../test/render';
import { CANVAS_EXTRA_SCROLL, CoachMark } from './CoachMark';
import { useTour } from './store';
import { TourPill } from './TourPill';

const tourInitial = useTour.getState();

/** The top bar's anchors and the zoom button, as the shell renders them, plus the coach mark and the pill. */
function Fixture() {
  return (
    <>
      <button type="button" data-toolbar-item="zoom-in" aria-label="Zoom menu">
        +
      </button>
      <button type="button">elsewhere</button>
      <footer>
        <span data-tour-anchor="topbar-file-name">Welcome.pdf</span>
        <TourPill />
      </footer>
      <CoachMark />
    </>
  );
}

beforeEach(() => {
  useTour.setState({ ...tourInitial }, true);
});

afterEach(() => {
  useTour.getState().end('restart');
});

describe('the coach mark', () => {
  it('is a labelled, non-modal region that does not take focus when it appears', async () => {
    setup(<Fixture />);
    expect(screen.queryByRole('region')).toBeNull();
    act(() => useTour.getState().start(1));
    const region = await screen.findByRole('region', { name: 'Open a PDF' });
    expect(region.getAttribute('aria-modal')).toBeNull();
    expect(region.hasAttribute('aria-live')).toBe(false);
    expect(region.contains(document.activeElement)).toBe(false);
    expect(document.querySelector('[data-tour-count]')?.getAttribute('aria-label')).toBe('Step 1 of 7');
  });

  it('describes its anchor by the instruction while the step is on, and lets go of it after', async () => {
    setup(<Fixture />);
    act(() => useTour.getState().start(1));
    const region = await screen.findByRole('region');
    const anchor = document.querySelector('[data-tour-anchor="topbar-file-name"]');
    const describedBy = anchor?.getAttribute('aria-describedby') ?? '';
    expect(document.getElementById(describedBy)?.textContent).toContain('This file opened by itself');
    expect(region.getAttribute('aria-labelledby')).not.toBe('');
    act(() => useTour.getState().end('restart'));
    expect(anchor?.hasAttribute('aria-describedby')).toBe(false);
  });

  it('hides on Esc inside it, gives focus back, and leaves the pill to bring it back', async () => {
    const { user } = setup(<Fixture />);
    const elsewhere = screen.getByRole('button', { name: 'elsewhere' });
    act(() => useTour.getState().start(1));
    await screen.findByRole('region');
    elsewhere.focus();
    await user.tab();
    // The card is last in the DOM order; reach its first control from where focus was.
    const hide = screen.getByRole('button', { name: 'Hide hint' });
    act(() => hide.focus());
    await user.keyboard('{Escape}');
    expect(useTour.getState().hidden).toBe(true);
    await act(async () => undefined);
    expect(screen.queryByRole('region')).toBeNull();
    const pill = screen.getByRole('button', { name: /Welcome tour, step 1 of 7/ });
    expect(pill.getAttribute('aria-expanded')).toBe('false');
    await user.click(pill);
    expect(useTour.getState().hidden).toBe(false);
    await screen.findByRole('region');
    // The pill's activation puts focus on Next.
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Next' }));
  });

  it('hides with the x button and ends with Skip, leaving nothing behind', async () => {
    const { user } = setup(<Fixture />);
    act(() => useTour.getState().start(1));
    await screen.findByRole('region');
    await user.click(screen.getByRole('button', { name: 'Hide hint' }));
    expect(useTour.getState().hidden).toBe(true);
    act(() => useTour.getState().show());
    await user.click(await screen.findByRole('button', { name: 'Skip tour' }));
    expect(useTour.getState().docId).toBeNull();
    await act(async () => undefined);
    expect(screen.queryByRole('region')).toBeNull();
    expect(screen.queryByRole('button', { name: /Welcome tour, step/ })).toBeNull();
  });

  it('shows the done state with the check and the full bar', async () => {
    setup(<Fixture />);
    act(() => useTour.getState().start(1));
    await screen.findByRole('region');
    act(() => useTour.getState().complete());
    expect(await screen.findByRole('heading', { name: 'Done: Open a PDF' })).toBeTruthy();
    expect(document.querySelector('h2 svg')).not.toBeNull();
    expect(document.querySelector('[data-tour-card]')?.className).toContain(
      'bg-panel border border-control-border shadow-floating',
    );
  });

  it('falls back to the page field when the anchor is missing, so Skip stays reachable', async () => {
    setup(
      <>
        <span data-tour-anchor="topbar-page-field">1 / 4</span>
        <CoachMark />
      </>,
    );
    act(() => useTour.getState().start(1));
    act(() => useTour.setState({ index: 2 }));
    await screen.findByRole('region', { name: 'Zoom in' });
    expect(screen.getByRole('button', { name: 'Skip tour' })).toBeTruthy();
  });

  it('falls back to the canvas when nothing else is on screen', async () => {
    setup(
      <>
        <div data-canvas-content="" />
        <CoachMark />
      </>,
    );
    act(() => useTour.getState().start(1));
    act(() => useTour.setState({ index: 2 }));
    expect(await screen.findByRole('region', { name: 'Zoom in' })).toBeTruthy();
  });

  it('wraps its footer instead of letting a button leave the card, on the last step too (longest label)', async () => {
    setup(<Fixture />);
    act(() => useTour.getState().start(1));
    await screen.findByRole('region');
    act(() => useTour.setState({ index: 6 }));
    const finish = await screen.findByRole('button', { name: 'Finish' });
    const footer = finish.parentElement?.parentElement;
    expect(footer?.className).toContain('flex-wrap');
    expect(footer?.className.split(' ')).not.toContain('h-control-sm');
    for (const button of footer?.querySelectorAll('button') ?? [])
      expect(button.className).toContain('whitespace-nowrap');
  });

  it('has Hide, Skip, Back, Next in tab order; Back is disabled on step 1', async () => {
    setup(<Fixture />);
    act(() => useTour.getState().start(1));
    await screen.findByRole('region');
    const names = Array.from(document.querySelectorAll('[data-tour-card] button')).map(
      (b) => b.textContent || b.getAttribute('aria-label'),
    );
    expect(names).toEqual(['Hide hint', 'Skip tour', 'Back', 'Next']);
    expect(screen.getByRole('button', { name: 'Back' }).getAttribute('aria-disabled')).toBe('true');
  });

  it('moves with Next and Back by keyboard, and says Finish on the last step', async () => {
    const { user } = setup(<Fixture />);
    act(() => useTour.getState().start(1));
    await screen.findByRole('region');
    const next = screen.getByRole('button', { name: 'Next' });
    act(() => next.focus());
    await user.keyboard('{Enter}');
    expect(useTour.getState().index).toBe(1);
    await user.click(screen.getByRole('button', { name: 'Back' }));
    expect(useTour.getState().index).toBe(0);
    act(() => useTour.setState({ index: 6 }));
    expect(await screen.findByRole('button', { name: 'Finish' })).toBeTruthy();
  });

  it('shows the count and a progress bar that fills with the steps', async () => {
    setup(<Fixture />);
    act(() => useTour.getState().start(1));
    await screen.findByRole('region');
    const bar = document.querySelector<HTMLElement>('[data-tour-progress]');
    expect(bar?.parentElement?.getAttribute('aria-hidden')).toBe('true');
    expect(bar?.parentElement?.className).toContain('h-progress');
    act(() => useTour.getState().next());
    await act(async () => undefined);
    expect(document.querySelector('[data-tour-count]')?.textContent).toBe('2 / 7');
    expect(useTour.getState().index).toBe(1);
  });

  it('is hidden while paused, and the pill shows the count with the paused label', async () => {
    const { user } = setup(<Fixture />);
    act(() => useTour.getState().start(1));
    await screen.findByRole('region');
    act(() => useTour.getState().pause());
    await act(async () => undefined);
    expect(screen.queryByRole('region')).toBeNull();
    expect(document.querySelector('[data-tour-ring]')).toBeNull();
    const pill = screen.getByRole('button', { name: /Welcome tour paused/ });
    await user.click(pill);
    expect(useTour.getState().paused).toBe(false);
    await screen.findByRole('region');
  });

  describe('the clearance under the card', () => {
    /** A canvas that scrolls, as the viewer renders it; `key` remounts it, as a document switch does. */
    function Canvas({ id }: { id: number }) {
      return (
        <main key={id} data-action-scope="canvas">
          <div role="region" aria-label="Document" data-canvas-id={id} ref={scrolls} />
        </main>
      );
    }
    function Shell() {
      const [id, setId] = useState(1);
      return (
        <>
          <Canvas id={id} />
          <button type="button" onClick={() => setId(2)}>
            switch
          </button>
          <Fixture />
        </>
      );
    }
    // The anchors sit at the bottom of the window, so the card is placed above them.
    beforeEach(() => {
      vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (this: HTMLElement) {
        const at = this.hasAttribute('data-tour-anchor') ? 750 : 0;
        return {
          left: 0,
          top: at,
          width: 100,
          height: 24,
          right: 100,
          bottom: at + 24,
          x: 0,
          y: at,
          toJSON: () => ({}),
        };
      });
    });
    afterEach(() => vi.restoreAllMocks());
    const scroller = (id: number) => document.querySelector<HTMLElement>(`[data-canvas-id="${id}"]`);
    const scrolls = (element: HTMLElement | null) => {
      if (element === null) return;
      Object.defineProperty(element, 'scrollHeight', { value: 2000, configurable: true });
      Object.defineProperty(element, 'clientHeight', { value: 600, configurable: true });
    };

    it('adds scroll height through a custom property and leaves the viewport alone, and removes it when the step ends', async () => {
      const { user } = setup(<Shell />);
      act(() => useTour.getState().start(1));
      await screen.findByRole('region', { name: 'Open a PDF' });
      const region = scroller(1);
      await act(async () => {
        await Promise.resolve();
      });
      expect(region?.style.getPropertyValue(CANVAS_EXTRA_SCROLL)).toContain('calc(');
      // Nothing that resizes the content box: no padding, border or size is written.
      expect(region?.style.paddingBottom).toBe('');
      expect(region?.style.height).toBe('');
      act(() => useTour.getState().skip());
      await act(async () => {
        await Promise.resolve();
      });
      expect(region?.style.getPropertyValue(CANVAS_EXTRA_SCROLL)).toBe('');
      void user;
    });

    it('is removed when the card unmounts, and follows a canvas that remounts', async () => {
      const { user, unmount } = setup(<Shell />);
      act(() => useTour.getState().start(1));
      await screen.findByRole('region', { name: 'Open a PDF' });
      const first = scroller(1);
      expect(first?.style.getPropertyValue(CANVAS_EXTRA_SCROLL)).toContain('calc(');
      await user.click(screen.getByRole('button', { name: 'switch' }));
      const second = scroller(2);
      await new Promise((resolve) => setTimeout(resolve, 50));
      expect(second?.style.getPropertyValue(CANVAS_EXTRA_SCROLL)).toContain('calc(');
      unmount();
      expect(second?.style.getPropertyValue(CANVAS_EXTRA_SCROLL)).toBe('');
    });
  });
});
