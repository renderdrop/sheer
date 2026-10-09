// @vitest-environment jsdom
import { act, fireEvent, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { LAYOUT } from '../../components/tokens';
import { bodyHeight } from '../../lib/layout';
import { useDocuments } from '../../stores/documents';
import { resetDocuments } from '../../stores/documents.testutil';
import { useSettings } from '../../stores/settings';
import { useUi } from '../../stores/ui';
import { openTooltip, setup } from '../../test/render';
import { Tooltip } from '../../components';
import { ModeCard } from '.';

const uiInitial = useUi.getState();

beforeEach(() => {
  window.innerWidth = 1440;
  useUi.setState({ ...uiInitial }, true);
  useSettings.setState({ showToolLabels: false });
  resetDocuments();
  act(() => useDocuments.getState().add({ id: 1, pageCount: 6, displayName: 'd.pdf' }));
});

afterEach(() => {
  resetDocuments();
  useSettings.setState({ showToolLabels: false });
  vi.useRealTimers();
});

let run = 0;
/** Timers and Date only (animation frames stay real); far from the previous test, as the tooltips share a group clock. */
function fakeClock() {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
  run += 1;
  vi.setSystemTime(new Date(2_000_000_000_000 + run * 1_000_000));
}

const toolbar = () => screen.getByRole('toolbar');

describe('the tool card labels (F21.6)', () => {
  it('shows icons only by default in all five modes, with the name in aria-label', () => {
    setup(<ModeCard />);
    for (const mode of ['read', 'comment', 'fill', 'pages', 'edit'] as const) {
      act(() => useUi.setState({ mode }));
      const buttons = within(toolbar())
        .getAllByRole('button')
        .filter((button) => !button.hasAttribute('data-mode-caption'));
      expect(buttons.length).toBeGreaterThan(1);
      expect(toolbar().querySelector('[data-label]')).toBeNull();
      for (const button of buttons) expect(button.getAttribute('aria-label')).toBeTruthy();
    }
    expect(document.documentElement.dataset.toolLabels).toBe('off');
  });

  it('shows the labels when "Show labels" is on, live', () => {
    setup(<ModeCard />);
    expect(toolbar().querySelector('[data-label]')).toBeNull();
    act(() => useSettings.setState({ showToolLabels: true }));
    expect(toolbar().querySelector('[data-label]')).not.toBeNull();
    expect(document.documentElement.dataset.toolLabels).toBe('on');
  });

  it('the card height has two values and the layout constants follow (8-pt grid)', () => {
    expect(LAYOUT.modeCard).toBe(72);
    expect(LAYOUT.modeCardLabels).toBe(96);
    expect(LAYOUT.modeCard % 8).toBe(0);
    expect(LAYOUT.modeCardLabels % 8).toBe(0);
    const structure = { mode: 'document', leftCollapsed: false, menuRow: false, inspector: false } as const;
    expect(bodyHeight(structure, 800) - bodyHeight(structure, 800, true)).toBe(24);
  });

  it('tooltips in the card open after 150 ms', () => {
    fakeClock();
    setup(<ModeCard />);
    const first = within(toolbar()).getAllByRole('button')[0];
    if (first === undefined) throw new Error('no tool');
    fireEvent.pointerEnter(first, { pointerType: 'mouse' });
    act(() => vi.advanceTimersByTime(140));
    expect(openTooltip()).toBeNull();
    act(() => vi.advanceTimersByTime(20));
    expect(openTooltip()).not.toBeNull();
  });

  it('a tooltip outside the card keeps 400 ms', () => {
    fakeClock();
    setup(
      <Tooltip label="Elsewhere">
        <button type="button">outside</button>
      </Tooltip>,
    );
    fireEvent.pointerEnter(screen.getByText('outside'), { pointerType: 'mouse' });
    act(() => vi.advanceTimersByTime(200));
    expect(openTooltip()).toBeNull();
    act(() => vi.advanceTimersByTime(250));
    expect(openTooltip()).not.toBeNull();
  });
});
