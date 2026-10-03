// @vitest-environment jsdom
import { act, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { setup } from '../../test/render';
import { CoachMark } from './CoachMark';
import { useTour } from './store';
import { TourPill } from './TourPill';

const tourInitial = useTour.getState();

/** The status bar's anchors and the toolbar's zoom button, as the shell renders them, plus the coach mark and the pill. */
function Fixture() {
  return (
    <>
      <button type="button" data-toolbar-item="zoom-in">
        +
      </button>
      <button type="button">elsewhere</button>
      <footer>
        <span data-tour-anchor="status-file-name">Welcome.pdf</span>
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
    expect(screen.getByText('Step 1 of 3')).toBeTruthy();
  });

  it('describes its anchor by the instruction while the step is on, and lets go of it after', async () => {
    setup(<Fixture />);
    act(() => useTour.getState().start(1));
    const region = await screen.findByRole('region');
    const anchor = document.querySelector('[data-tour-anchor="status-file-name"]');
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
    const pill = screen.getByRole('button', { name: /Welcome tour, step 1 of 3/ });
    expect(pill.getAttribute('aria-expanded')).toBe('false');
    await user.click(pill);
    expect(useTour.getState().hidden).toBe(false);
    await screen.findByRole('region');
    // The pill's activation puts focus on the card's first control.
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Hide hint' }));
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

  it('shows the done state without actions', async () => {
    setup(<Fixture />);
    act(() => useTour.getState().start(1));
    await screen.findByRole('region');
    act(() => useTour.getState().complete());
    expect(await screen.findByRole('heading', { name: 'Done: Open a PDF' })).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Skip tour' })).toBeNull();
  });

  it('points at More and says so when the zoom button has moved into the overflow', async () => {
    setup(
      <>
        <button type="button" data-toolbar-item="more">
          More
        </button>
        <CoachMark />
      </>,
    );
    act(() => useTour.getState().start(1));
    act(() => useTour.setState({ index: 2 }));
    const region = await screen.findByRole('region', { name: 'Zoom in' });
    expect(region.textContent).toContain('You find it under More.');
  });

  it('falls back to the status bar when the anchor and More are both missing, so Skip stays reachable', async () => {
    setup(
      <>
        <span data-tour-anchor="status-page-button">1 / 4</span>
        <CoachMark />
      </>,
    );
    act(() => useTour.getState().start(1));
    act(() => useTour.setState({ index: 2 }));
    const region = await screen.findByRole('region', { name: 'Zoom in' });
    expect(region.textContent).not.toContain('You find it under More.');
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
});
