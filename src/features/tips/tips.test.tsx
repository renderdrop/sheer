// @vitest-environment jsdom
import { act, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { updateSettings, type Settings } from '../../api/app';
import { useSettings } from '../../stores/settings';
import { useUi } from '../../stores/ui';
import { setup } from '../../test/render';
import { useTour } from '../tour/store';
import { TIP_IDS, mayShow, tipFor, tipOfTool, toolbarItemOf, withSeen } from './model';
import { bindTips, maybeShowTip, resetSession, resetTips } from './runtime';
import { useTips } from './store';
import { Tip } from './Tip';

vi.mock('../../api/app', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../api/app')>()),
  updateSettings: vi.fn(),
}));

const updateSettingsMock = vi.mocked(updateSettings);
const settingsInitial = useSettings.getState();
const uiInitial = useUi.getState();
const tourInitial = useTour.getState();

const context = { loaded: true, seen: [], session: new Set<string>(), tourRunning: false, tipVisible: false };

beforeEach(() => {
  resetSession();
  useSettings.setState({ ...settingsInitial, loaded: true }, true);
  useUi.setState({ ...uiInitial }, true);
  useTour.setState({ ...tourInitial }, true);
  useTips.setState({ current: null });
  updateSettingsMock.mockReset();
  updateSettingsMock.mockImplementation((patch) => {
    const { language, leftPanelWidth, welcomeTour, authorName, authorPrompt, tipsSeen } = useSettings.getState();
    const current: Settings = { language, leftPanelWidth, welcomeTour, authorName, authorPrompt };
    return Promise.resolve({ ...current, ...(tipsSeen === undefined ? {} : { tipsSeen }), ...patch });
  });
});

afterEach(() => {
  useTour.getState().end('restart');
  useTips.setState({ current: null });
});

describe('the seen-state logic', () => {
  it('has a tip for the tools of the spec and for no other tool', () => {
    expect(TIP_IDS).toHaveLength(14);
    expect(tipOfTool('select')).toBeNull();
    expect(tipOfTool('form')).toBeNull();
    expect(tipOfTool('image')).toBeNull();
    expect(tipOfTool('signature')).toBe('sign');
    expect(tipOfTool('textBox')).toBe('insertText');
    expect(tipFor({ activeTool: 'select', redactMode: true })).toBe('redact');
    expect(tipFor({ activeTool: 'crop', redactMode: false })).toBe('crop');
    expect(toolbarItemOf('sign')).toBe('signature');
    expect(toolbarItemOf('draw')).toBe('draw');
    expect(toolbarItemOf('text')).toBe('freeText');
    expect(toolbarItemOf('pages')).toBe('organize');
  });

  it('shows an unseen tip once settings are known, with no tour and no other tip', () => {
    expect(mayShow('draw', context)).toBe(true);
    expect(mayShow('draw', { ...context, loaded: false })).toBe(false);
    expect(mayShow('draw', { ...context, seen: ['draw'] })).toBe(false);
    expect(mayShow('draw', { ...context, session: new Set(['draw']) })).toBe(false);
    expect(mayShow('draw', { ...context, tourRunning: true })).toBe(false);
    expect(mayShow('draw', { ...context, tipVisible: true })).toBe(false);
  });

  it('adds an id once and keeps at most 32', () => {
    expect(withSeen(['a'], 'b')).toEqual(['a', 'b']);
    expect(withSeen(['a', 'b'], 'a')).toEqual(['b', 'a']);
    const many = Array.from({ length: 32 }, (_, index) => `t${index}`);
    const next = withSeen(many, 'new');
    expect(next).toHaveLength(32);
    expect(next.at(-1)).toBe('new');
    expect(next).not.toContain('t0');
  });
});

describe('when a tip shows', () => {
  it('writes the id to the setting before the tip shows, and never shows it twice', async () => {
    await maybeShowTip();
    expect(updateSettingsMock).not.toHaveBeenCalled();
    useUi.setState({ activeTool: 'draw' });
    const shown = maybeShowTip();
    // Marked seen first: the write is under way while nothing shows yet.
    expect(updateSettingsMock).toHaveBeenCalledWith({ tipsSeen: ['draw'] });
    expect(useTips.getState().current).toBeNull();
    await shown;
    expect(useTips.getState().current).toBe('draw');
    expect(useSettings.getState().tipsSeen).toEqual(['draw']);
    useTips.getState().dismiss();
    await maybeShowTip();
    expect(useTips.getState().current).toBeNull();
    expect(updateSettingsMock).toHaveBeenCalledTimes(1);
  });

  it('does not repeat in the session even when the write fails', async () => {
    updateSettingsMock.mockRejectedValue({ code: 'invalid_argument', retryable: false });
    useUi.setState({ activeTool: 'shapes' });
    await maybeShowTip();
    expect(useTips.getState().current).toBe('shapes');
    useTips.getState().dismiss();
    await maybeShowTip();
    expect(useTips.getState().current).toBeNull();
  });

  it('stays quiet during a tour, and does not mark the tool as seen', async () => {
    useTour.getState().start(1);
    useUi.setState({ activeTool: 'highlight' });
    await maybeShowTip();
    expect(useTips.getState().current).toBeNull();
    expect(updateSettingsMock).not.toHaveBeenCalled();
    expect(useSettings.getState().tipsSeen ?? []).toEqual([]);
  });

  it('skips a tool whose tip was seen in an earlier session', async () => {
    useSettings.setState({ tipsSeen: ['crop'] });
    useUi.setState({ activeTool: 'crop' });
    await maybeShowTip();
    expect(useTips.getState().current).toBeNull();
    expect(updateSettingsMock).not.toHaveBeenCalled();
  });

  it('does not show a tip for a tool released while the write was in flight', async () => {
    useUi.setState({ activeTool: 'text' });
    const shown = maybeShowTip();
    useUi.setState({ activeTool: 'select' });
    await shown;
    expect(useTips.getState().current).toBeNull();
  });

  it('follows the tools: shows on activation, goes when the tool is released or changed, and when a tour starts', async () => {
    const unbind = bindTips();
    act(() => useUi.setState({ activeTool: 'draw' }));
    await waitFor(() => expect(useTips.getState().current).toBe('draw'));
    act(() => useUi.setState({ activeTool: 'select' }));
    expect(useTips.getState().current).toBeNull();
    act(() => useUi.setState({ activeTool: 'note' }));
    await waitFor(() => expect(useTips.getState().current).toBe('note'));
    act(() => useUi.setState({ activeTool: 'highlight' }));
    expect(useTips.getState().current).toBeNull();
    await waitFor(() => expect(useTips.getState().current).toBe('highlight'));
    act(() => useTour.getState().start(1));
    expect(useTips.getState().current).toBeNull();
    unbind();
  });

  it('shows Redact mode its tip', async () => {
    useUi.setState({ redactMode: true });
    await maybeShowTip();
    expect(useTips.getState().current).toBe('redact');
  });

  it('shows the tips again after "show tips again"', async () => {
    useUi.setState({ activeTool: 'draw' });
    await maybeShowTip();
    useTips.getState().dismiss();
    await resetTips();
    expect(updateSettingsMock).toHaveBeenLastCalledWith({ tipsSeen: [] });
    expect(useSettings.getState().tipsSeen).toEqual([]);
    await maybeShowTip();
    expect(useTips.getState().current).toBe('draw');
  });
});

function Fixture() {
  return (
    <>
      <div role="toolbar" aria-label="Tools">
        <button type="button" data-toolbar-item="draw">
          Draw
        </button>
      </div>
      <div data-action-scope="canvas">
        <div role="region" tabIndex={-1} aria-label="Canvas" />
      </div>
      <Tip />
    </>
  );
}

describe('the session cap', () => {
  it('shows at most three tips per session, even after "show tips again"', async () => {
    for (const tool of ['highlight', 'note', 'text'] as const) {
      useUi.setState({ activeTool: tool });
      await maybeShowTip();
      expect(useTips.getState().current).toBe(tool);
      useTips.getState().dismiss();
    }
    useUi.setState({ activeTool: 'draw' });
    await maybeShowTip();
    expect(useTips.getState().current).toBeNull();
    await resetTips();
    await maybeShowTip();
    expect(useTips.getState().current).toBeNull();
    expect(mayShow('draw', { ...context, shownCount: 3 })).toBe(false);
    expect(mayShow('draw', { ...context, shownCount: 2 })).toBe(true);
  });

  it('fires each trigger once: every tool of the spec shows its tip a single time', async () => {
    for (const tool of ['highlight', 'note', 'text'] as const) {
      useUi.setState({ activeTool: tool });
      await maybeShowTip();
      useTips.getState().dismiss();
      await maybeShowTip();
      expect(useTips.getState().current).toBeNull();
    }
    expect(useSettings.getState().tipsSeen).toEqual(['highlight', 'note', 'text']);
  });

  it('stays quiet while a tour is paused or running, and keeps the cap untouched', async () => {
    useTour.getState().start(1);
    useTour.getState().hide();
    for (const tool of ['highlight', 'note', 'text', 'draw'] as const) {
      useUi.setState({ activeTool: tool });
      await maybeShowTip();
    }
    expect(useTips.getState().current).toBeNull();
    useTour.getState().end('skipped');
    useUi.setState({ activeTool: 'crop' });
    await maybeShowTip();
    expect(useTips.getState().current).toBe('crop');
  });
});

describe('the tip card', () => {
  it('is a labelled region with the text, describes its tool, never takes focus, and dismisses with x', async () => {
    const { user } = setup(<Fixture />);
    expect(screen.queryByRole('region', { name: 'Tip' })).toBeNull();
    act(() => useTips.getState().show('draw'));
    const card = await screen.findByRole('region', { name: 'Tip' });
    expect(card.textContent).toContain(
      'Circles, rectangles, lines and arrows straighten when you let go. Ctrl+Z brings the stroke back.',
    );
    const tool = screen.getByRole('button', { name: 'Draw' });
    expect(tool.getAttribute('aria-describedby')).toBe(card.querySelector('p')?.id);
    expect(document.activeElement).toBe(document.body);
    await user.click(screen.getByRole('button', { name: 'Dismiss tip' }));
    await waitFor(() => expect(screen.queryByRole('region', { name: 'Tip' })).toBeNull());
    expect(useTips.getState().current).toBeNull();
    expect(tool.hasAttribute('aria-describedby')).toBe(false);
  });

  it('dismisses with Esc inside it and returns focus to the canvas', async () => {
    const { user } = setup(<Fixture />);
    act(() => useTips.getState().show('draw'));
    await screen.findByRole('region', { name: 'Tip' });
    screen.getByRole('button', { name: 'Dismiss tip' }).focus();
    await user.keyboard('{Escape}');
    await waitFor(() => expect(screen.queryByRole('region', { name: 'Tip' })).toBeNull());
    expect(document.activeElement).toBe(screen.getByRole('region', { name: 'Canvas' }));
  });

  it('goes for good when a menu or dialog opens after it showed', async () => {
    setup(<Fixture />);
    act(() => useTips.getState().show('draw'));
    await screen.findByRole('region', { name: 'Tip' });
    act(() => {
      const menu = document.createElement('div');
      menu.setAttribute('role', 'menu');
      document.body.append(menu);
    });
    await waitFor(() => expect(useTips.getState().current).toBeNull());
    document.querySelector('[role="menu"]')?.remove();
  });
});
