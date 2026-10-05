// @vitest-environment jsdom
import { readFileSync } from 'node:fs';
import { act, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { useDocuments } from '../../stores/documents';
import { resetDocuments } from '../../stores/documents.testutil';
import { useUi } from '../../stores/ui';
import { setup } from '../../test/render';
import { useSave } from '../save/state';
import { CHECK_DRAW_S, SaveStatus, SAVING_DELAY_MS } from './SaveStatus';

const edit = vi.hoisted(() => ({ edited: false }));
vi.mock('./useEdited', () => ({ useActiveEdited: () => edit.edited }));
const actions = vi.hoisted(() => ({ runAction: vi.fn() }));
vi.mock('../../actions/dispatch', () => actions);

const button = () => document.querySelector<HTMLElement>('[data-save-status]') as HTMLElement;

beforeEach(() => {
  resetDocuments();
  useDocuments.getState().add({ id: 1, pageCount: 3, displayName: 'A.pdf' });
  useUi.getState().setView('editor');
  useSave.setState({ saving: {}, saved: null, failed: {} });
  edit.edited = false;
  actions.runAction.mockReset();
});
afterEach(() => vi.useRealTimers());

describe('the save status (DESIGN 3.5 B1)', () => {
  it('Saved: a check and "Saved", inactive', async () => {
    const { user } = setup(<SaveStatus />);
    expect(button().dataset.saveStatus).toBe('saved');
    expect(button().getAttribute('aria-label')).toBe('Saved');
    expect(button().getAttribute('aria-disabled')).toBe('true');
    await user.click(button());
    expect(actions.runAction).not.toHaveBeenCalled();
  });

  it('Edited: an Ink dot, a click saves, the tooltip names the shortcut', async () => {
    edit.edited = true;
    const { user } = setup(<SaveStatus />);
    expect(button().dataset.saveStatus).toBe('edited');
    expect(button().textContent).toBe('Edited');
    expect(button().querySelector('[data-edited]')).not.toBeNull();
    expect(button().getAttribute('aria-keyshortcuts')).toMatch(/S/);
    await user.click(button());
    expect(actions.runAction).toHaveBeenCalledWith('save');
  });

  it('Not saved yet for a recovered document', () => {
    useDocuments.setState((state) => ({ byId: { ...state.byId, 1: { ...state.byId[1]!, kind: 'recovered' } } }));
    edit.edited = true;
    setup(<SaveStatus />);
    expect(button().dataset.saveStatus).toBe('new');
    expect(button().textContent).toBe('Not saved yet');
  });

  it('Saving… shows only after 200 ms', () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    edit.edited = true;
    setup(<SaveStatus />);
    act(() => useSave.getState().setSaving(1, true));
    expect(button().dataset.saveStatus).toBe('edited');
    act(() => void vi.advanceTimersByTime(SAVING_DELAY_MS));
    expect(button().dataset.saveStatus).toBe('saving');
    expect(button().getAttribute('aria-disabled')).toBe('true');
    act(() => useSave.getState().setSaving(1, false));
    expect(button().dataset.saveStatus).toBe('edited');
  });

  it('Failed: "Not saved" with a warning glyph, a click retries', async () => {
    edit.edited = true;
    useSave.setState({ failed: { 1: { code: 'save_failed', key: 'error.save_failed', retryable: true } } });
    const { user } = setup(<SaveStatus />);
    expect(button().dataset.saveStatus).toBe('failed');
    expect(button().textContent).toBe('Not saved');
    await user.click(button());
    expect(actions.runAction).toHaveBeenCalledWith('save');
  });

  it('a just finished save draws the check', () => {
    act(() => useSave.setState({ saved: 1 }));
    setup(<SaveStatus />);
    expect(within(button()).queryByText('Saved')).not.toBeNull();
    expect(button().querySelector('[data-drawn-check]')).not.toBeNull();
    expect(screen.queryByRole('button', { name: 'Edited' })).toBeNull();
  });
});

describe('Saved motion (MOTION spell 6)', () => {
  it('right after a save: the dot fades out, the check is drawn and "Saved" fades in', () => {
    setup(<SaveStatus />);
    act(() => useSave.setState({ saved: 1 }));
    expect(button().querySelector('[data-drawn-check]')).not.toBeNull();
    expect(button().querySelector('[data-dot-out]')).not.toBeNull();
    expect(button().querySelector('[data-saved-text]')?.textContent).toBe('Saved');
  });

  it('at rest: a plain check and no dot', () => {
    setup(<SaveStatus />);
    expect(button().querySelector('[data-drawn-check]')).toBeNull();
    expect(button().querySelector('[data-dot-out]')).toBeNull();
  });

  it('the check draws in --motion-check (240 ms)', () => {
    const css = readFileSync('src/styles/tokens.css', 'utf8');
    expect(css).toContain(`--motion-check: ${Math.round(CHECK_DRAW_S * 1000)}ms;`);
  });
});
