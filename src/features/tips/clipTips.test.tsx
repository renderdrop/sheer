// @vitest-environment jsdom
import { act, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { updateSettings } from '../../api/app';
import type { FormField } from '../../api/forms';
import { useNotices, resetNotices } from '../../components/notices';
import { useDocuments } from '../../stores/documents';
import { useSettings } from '../../stores/settings';
import { useUi } from '../../stores/ui';
import { setup } from '../../test/render';
import { useForms } from '../forms/store';
import { useTour } from '../tour/store';
import { clipOf } from './clips';
import { isClipTip, mayShow } from './model';
import { bindTips, maybeShowTip, resetSession } from './runtime';
import { useTips } from './store';
import { Tip } from './Tip';

// Reduced motion is a switch of the test: motion reads it through one hook.
let reduceMotion = false;
vi.mock('motion/react', async (importOriginal) => ({
  ...(await importOriginal<typeof import('motion/react')>()),
  useReducedMotion: () => reduceMotion,
}));
// The clip assets are recorded by another package: the tests bring their own.
vi.mock('./clips', () => ({ clipOf: vi.fn(() => null) }));
vi.mock('../../api/app', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../api/app')>()),
  updateSettings: vi.fn(),
}));

const updateSettingsMock = vi.mocked(updateSettings);
const settingsInitial = useSettings.getState();
const uiInitial = useUi.getState();
const tourInitial = useTour.getState();

const FIELD = { id: 'f1', name: 'Name', kind: 'text', readOnly: false } as unknown as FormField;
const CLIP = { src: '/clip.png', poster: '/poster.png' };

beforeEach(() => {
  reduceMotion = false;
  resetSession();
  resetNotices();
  useSettings.setState({ ...settingsInitial, loaded: true }, true);
  useUi.setState({ ...uiInitial }, true);
  useTour.setState({ ...tourInitial }, true);
  useTips.setState({ current: null });
  useDocuments.setState({ activeId: null });
  useForms.setState({ byDoc: {} });
  vi.mocked(clipOf).mockReturnValue(CLIP);
  updateSettingsMock.mockReset();
  updateSettingsMock.mockImplementation((patch) => {
    const { language, leftPanelWidth, welcomeTour, authorName, authorPrompt, tipsSeen, tipsEnabled } =
      useSettings.getState();
    return Promise.resolve({
      language,
      leftPanelWidth,
      welcomeTour,
      authorName,
      authorPrompt,
      ...(tipsSeen === undefined ? {} : { tipsSeen }),
      ...(tipsEnabled === undefined ? {} : { tipsEnabled }),
      ...patch,
    });
  });
});

afterEach(() => {
  useTour.getState().end('restart');
  useTips.setState({ current: null });
  useDocuments.setState({ activeId: null });
  useForms.setState({ byDoc: {} });
});

function Fixture() {
  return (
    <>
      <div role="toolbar" aria-label="Tools">
        <button type="button" data-toolbar-item="highlight">
          Highlight
        </button>
        <button type="button" data-toolbar-item="draw">
          Draw
        </button>
      </div>
      <button type="button" data-tour-anchor="mode-fill">
        Fill and sign
      </button>
      <div data-action-scope="canvas">
        <div role="region" tabIndex={-1} aria-label="Canvas" />
      </div>
      <Tip />
    </>
  );
}

function openForm(docId: number, fields: readonly FormField[]): void {
  useDocuments.setState({ activeId: docId });
  useForms.setState({ byDoc: { [docId]: { status: 'ready', fields, hasScripts: false } } });
}

describe('the form tip situation', () => {
  it('shows for a document with a fillable field that becomes the active tab, once', async () => {
    const unbind = bindTips();
    act(() => openForm(1, [FIELD]));
    await waitFor(() => expect(useTips.getState().current).toBe('formClip'));
    expect(useSettings.getState().tipsSeen).toEqual(['formClip']);
    act(() => useTips.getState().dismiss());
    act(() => useDocuments.setState({ activeId: 2 }));
    act(() => useDocuments.setState({ activeId: 1 }));
    await Promise.resolve();
    expect(useTips.getState().current).toBeNull();
    unbind();
  });

  it('never triggers for a document without fields, read-only fields only, or in Seiten mode', async () => {
    const unbind = bindTips();
    act(() => openForm(1, []));
    act(() => openForm(2, [{ ...FIELD, readOnly: true }]));
    // The mode is restored per tab on a switch, so Seiten is chosen after the tab is active, then the form arrives.
    act(() => openForm(3, []));
    act(() => useUi.setState({ mode: 'pages' }));
    act(() => openForm(3, [FIELD]));
    await Promise.resolve();
    expect(useTips.getState().current).toBeNull();
    expect(updateSettingsMock).not.toHaveBeenCalled();
    // Leaving Seiten brings the situation back.
    act(() => useUi.setState({ mode: 'read' }));
    await waitFor(() => expect(useTips.getState().current).toBe('formClip'));
    unbind();
  });

  it('goes with the tab, with Seiten and with the first committed value', async () => {
    const unbind = bindTips();
    act(() => openForm(1, [FIELD]));
    await waitFor(() => expect(useTips.getState().current).toBe('formClip'));
    act(() => useDocuments.setState({ activeId: 2 }));
    expect(useTips.getState().current).toBeNull();
    resetSession();
    useSettings.setState({ tipsSeen: [] });
    act(() => openForm(1, [FIELD]));
    await waitFor(() => expect(useTips.getState().current).toBe('formClip'));
    act(() => useUi.setState({ mode: 'pages' }));
    expect(useTips.getState().current).toBeNull();
    resetSession();
    useSettings.setState({ tipsSeen: [] });
    act(() => useUi.setState({ mode: 'read' }));
    await waitFor(() => expect(useTips.getState().current).toBe('formClip'));
    act(() => useForms.setState({ byDoc: { 1: { status: 'ready', fields: [{ ...FIELD }], hasScripts: false } } }));
    expect(useTips.getState().current).toBeNull();
    unbind();
  });

  it('points at the Fill & Sign segment when the banner is absent, and at the banner link when it is there', async () => {
    const { rerender } = setup(<Fixture />);
    act(() => openForm(1, [FIELD]));
    act(() => useTips.getState().show('formClip'));
    const card = await screen.findByRole('region', { name: 'This document is a form' });
    const segment = screen.getByRole('button', { name: 'Fill and sign' });
    expect(segment.getAttribute('aria-describedby')).toBe(card.querySelector('p')?.id);
    rerender(
      <>
        <div data-banner="form">
          <button type="button">First field</button>
        </div>
        <Fixture />
      </>,
    );
    await waitFor(() =>
      expect(screen.getByRole('button', { name: 'First field' }).getAttribute('aria-describedby')).not.toBeNull(),
    );
  });
});

describe('tips switched off and the queue', () => {
  it('shows nothing and writes nothing while tipsEnabled is false; resumes when it is on again', async () => {
    useSettings.setState({ tipsEnabled: false });
    useUi.setState({ activeTool: 'highlight' });
    await maybeShowTip();
    expect(useTips.getState().current).toBeNull();
    expect(updateSettingsMock).not.toHaveBeenCalled();
    expect(
      mayShow('draw', {
        loaded: true,
        seen: [],
        session: new Set(),
        tourRunning: false,
        tipVisible: false,
        enabled: false,
      }),
    ).toBe(false);
    const unbind = bindTips();
    act(() => useSettings.setState({ tipsEnabled: true }));
    await waitFor(() => expect(useTips.getState().current).toBe('highlightClip'));
    act(() => useSettings.setState({ tipsEnabled: false }));
    expect(useTips.getState().current).toBeNull();
    unbind();
  });

  it('writes tipsSeen only when the tip really shows: a visible notice holds it back, a gone situation drops it unseen', async () => {
    useNotices.getState().request({ id: 'toast', kind: 'info' });
    const unbind = bindTips();
    act(() => useUi.setState({ activeTool: 'highlight' }));
    await Promise.resolve();
    expect(updateSettingsMock).not.toHaveBeenCalled();
    act(() => useUi.setState({ activeTool: 'select' }));
    act(() => useNotices.getState().release('toast'));
    await Promise.resolve();
    expect(useTips.getState().current).toBeNull();
    expect(useSettings.getState().tipsSeen ?? []).toEqual([]);
    // Still on when the notice ends: it shows then.
    useNotices.getState().request({ id: 'toast', kind: 'info' });
    act(() => useUi.setState({ activeTool: 'highlight' }));
    act(() => useNotices.getState().release('toast'));
    await waitFor(() => expect(useTips.getState().current).toBe('highlightClip'));
    unbind();
  });

  it('waits while a dialog is open (the signature sheet) and shows when it closes', async () => {
    const dialog = document.createElement('div');
    dialog.setAttribute('role', 'dialog');
    document.body.append(dialog);
    const unbind = bindTips();
    act(() => useUi.setState({ activeTool: 'signature' }));
    await Promise.resolve();
    expect(useTips.getState().current).toBeNull();
    expect(updateSettingsMock).not.toHaveBeenCalled();
    act(() => dialog.remove());
    await waitFor(() => expect(useTips.getState().current).toBe('signClip'));
    unbind();
  });

  it('counts clip tips toward the cap and leaves a capped tip unseen', async () => {
    for (const tool of ['highlight', 'note', 'text'] as const) {
      useUi.setState({ activeTool: tool });
      await maybeShowTip();
      useTips.getState().dismiss();
    }
    useUi.setState({ activeTool: 'signature' });
    await maybeShowTip();
    expect(useTips.getState().current).toBeNull();
    expect(useSettings.getState().tipsSeen).not.toContain('signClip');
  });
});

describe('the clip card', () => {
  it('is a region named by its title with the clip, text, Replay and Hide; replay re-keys the image', async () => {
    const { user } = setup(<Fixture />);
    act(() => useTips.getState().show('highlightClip'));
    const card = await screen.findByRole('region', { name: 'Highlight text' });
    expect(card.getAttribute('data-surface')).toBe('tip');
    expect(card.getAttribute('data-tip-id')).toBe('highlightClip');
    expect(card.textContent).toContain('Drag across text.');
    expect(document.activeElement).toBe(document.body);
    const first = await screen.findByRole('img', {
      name: 'Animation: the pointer drags across a sentence and it turns highlighted.',
    });
    expect(first.getAttribute('src')).toBe('/clip.png');
    await user.click(screen.getByRole('button', { name: 'Play again' }));
    const second = await screen.findByRole('img');
    expect(second).not.toBe(first);
    expect(second.getAttribute('src')).toBe('/clip.png');
    await user.click(screen.getByRole('button', { name: 'Dismiss tip' }));
    await waitFor(() => expect(useTips.getState().current).toBeNull());
  });

  it('with reduced motion shows the poster and has no Replay', async () => {
    reduceMotion = true;
    setup(<Fixture />);
    act(() => useTips.getState().show('highlightClip'));
    const image = await screen.findByRole('img');
    expect(image.getAttribute('src')).toBe('/poster.png');
    expect(screen.queryByRole('button', { name: 'Play again' })).toBeNull();
  });

  it('falls back to the poster when the animation fails to load', async () => {
    setup(<Fixture />);
    act(() => useTips.getState().show('highlightClip'));
    const image = await screen.findByRole('img');
    act(() => {
      image.dispatchEvent(new Event('error'));
    });
    await waitFor(() => expect(screen.getByRole('img').getAttribute('src')).toBe('/poster.png'));
  });

  it('is the text-only card with the same body and no title when the clip is missing', async () => {
    vi.mocked(clipOf).mockReturnValue(null);
    setup(<Fixture />);
    act(() => useTips.getState().show('highlightClip'));
    const card = await screen.findByRole('region', { name: 'Tip' });
    expect(card.textContent).toContain('Drag across text.');
    expect(card.textContent).not.toContain('Highlight text');
    expect(screen.queryByRole('img')).toBeNull();
    expect(screen.queryByRole('button', { name: 'Play again' })).toBeNull();
  });

  it('has a clip only for the four situations', async () => {
    expect(isClipTip('signClip') && isClipTip('pagesClip') && isClipTip('formClip') && isClipTip('highlightClip')).toBe(
      true,
    );
    expect(isClipTip('draw')).toBe(false);
    setup(<Fixture />);
    act(() => useTips.getState().show('draw'));
    await screen.findByRole('region', { name: 'Tip' });
    expect(screen.queryByRole('img')).toBeNull();
  });
});
