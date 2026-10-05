// @vitest-environment jsdom
import { act, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { setup } from '../../test/render';
import { CoachMark } from './CoachMark';
import { useTour } from './store';
import { TourPill } from './TourPill';

vi.mock('motion/react', async (importOriginal) => ({
  ...(await importOriginal<typeof import('motion/react')>()),
  useReducedMotion: () => true,
}));

afterEach(() => useTour.getState().end('restart'));

describe('the tour with reduced motion', () => {
  it('fades the card without a scale and shows the pill without a rise', async () => {
    setup(
      <>
        <span data-tour-anchor="topbar-file-name">Welcome.pdf</span>
        <TourPill />
        <CoachMark />
      </>,
    );
    act(() => useTour.getState().start(1));
    await screen.findByRole('region');
    const card = document.querySelector<HTMLElement>('[data-tour-card]');
    expect(card?.style.transform ?? '').not.toContain('scale(0.98)');
    const pill = document.querySelector<HTMLElement>('[data-tour-pill]');
    expect(pill?.parentElement?.style.transform ?? '').not.toContain('translateY(8px)');
  });
});
