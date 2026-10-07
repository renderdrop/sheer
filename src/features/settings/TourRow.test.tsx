// @vitest-environment jsdom
import { act, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { openWelcomeDocument, type DocumentInfo } from '../../api/documents';
import { EMPTY_HISTORY, useAnnotations } from '../../stores/annotations';
import { useDocuments } from '../../stores/documents';
import { useView } from '../../stores/view';
import { openTooltip, setup } from '../../test/render';
import { useSettings } from '../../stores/settings';
import { useTour } from '../tour/store';
import { SettingsPopover } from './SettingsPopover';
import { openSettings, useSettingsPopover } from './state';

vi.mock('../../api/documents', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../api/documents')>()),
  openWelcomeDocument: vi.fn(),
  closeDocument: vi.fn(() => Promise.resolve()),
}));

const openWelcomeMock = vi.mocked(openWelcomeDocument);
const documentsInitial = useDocuments.getState();
const viewInitial = useView.getState();
const tourInitial = useTour.getState();
const annotationsInitial = useAnnotations.getState();
const WELCOME: DocumentInfo = { id: 7, pageCount: 4, displayName: 'Welcome', kind: 'welcome' };

beforeEach(() => {
  useDocuments.setState({ ...documentsInitial }, true);
  useView.setState({ ...viewInitial }, true);
  useTour.setState({ ...tourInitial }, true);
  useAnnotations.setState({ ...annotationsInitial }, true);
  useSettingsPopover.setState({ open: false });
  openWelcomeMock.mockReset();
  openWelcomeMock.mockResolvedValue({ type: 'opened', document: WELCOME });
});

afterEach(() => {
  useTour.getState().end('restart');
  useSettingsPopover.setState({ open: false });
});

function Fixture() {
  return (
    <>
      <div role="toolbar" aria-label="Tools">
        <button type="button" data-menubar-item="file">
          File
        </button>
      </div>
      <SettingsPopover />
    </>
  );
}

describe('the Welcome tour row', () => {
  it('offers Start tour with its hint, and Restart tour while a tour runs', () => {
    setup(<Fixture />);
    act(() => openSettings());
    expect(screen.getByText('Tour & tips')).toBeTruthy();
    expect(screen.getByText('Opens the welcome document.')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Start tour' })).toBeTruthy();
    act(() => useTour.getState().start(1));
    expect(screen.getByRole('button', { name: 'Restart tour' })).toBeTruthy();
  });

  it('closes the popover with focus on the menu title, keeps the dirty document and opens the welcome document in a new tab', async () => {
    const { user } = setup(<Fixture />);
    useView.getState().open(3, 2);
    useDocuments.getState().add({ id: 3, pageCount: 2, displayName: 'a.pdf', kind: 'user' });
    useAnnotations.setState({
      byDoc: {
        3: { rev: 1, byId: {}, loaded: {}, removed: {}, history: { ...EMPTY_HISTORY, canUndo: true, dirty: true } },
      },
    });
    openWelcomeMock.mockImplementation(() => {
      useView.getState().open(WELCOME.id, WELCOME.pageCount);
      useDocuments.getState().add(WELCOME);
      return Promise.resolve({ type: 'opened', document: WELCOME });
    });
    act(() => openSettings());
    await user.click(screen.getByRole('button', { name: 'Start tour' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'File' }));
    expect(useAnnotations.getState().byDoc[3]?.history).toMatchObject({ dirty: true, canUndo: true });
    expect(useDocuments.getState().byId[3]).toBeDefined();
    expect(useDocuments.getState().activeId).toBe(WELCOME.id);
    expect(useDocuments.getState().order).toEqual([3, WELCOME.id]);
    expect(openWelcomeMock).toHaveBeenCalledTimes(1);
  });

  it('activates an open welcome tab and restarts the tour there without opening another', async () => {
    const { user } = setup(<Fixture />);
    useView.getState().open(WELCOME.id, WELCOME.pageCount);
    useDocuments.getState().add(WELCOME);
    useView.getState().open(3, 2);
    useDocuments.getState().add({ id: 3, pageCount: 2, displayName: 'a.pdf', kind: 'user' });
    act(() => openSettings());
    await user.click(screen.getByRole('button', { name: 'Start tour' }));
    await waitFor(() => expect(useDocuments.getState().activeId).toBe(WELCOME.id));
    expect(openWelcomeMock).not.toHaveBeenCalled();
    expect(useTour.getState()).toMatchObject({ docId: WELCOME.id, index: 0 });
    expect(useDocuments.getState().byId[3]).toBeDefined();
  });
});

describe('the Show tips again button', () => {
  const settingsInitial = useSettings.getState();
  afterEach(() => useSettings.setState({ ...settingsInitial }, true));

  it('is aria-disabled while no tip was seen, and does nothing then', async () => {
    const update = vi.fn(() => Promise.resolve());
    useSettings.setState({ ...settingsInitial, update, tipsSeen: [] }, true);
    const { user } = setup(<Fixture />);
    act(() => openSettings());
    const button = screen.getByRole('button', { name: 'Show tips again' });
    expect(button.getAttribute('aria-disabled')).toBe('true');
    await user.click(button);
    expect(update).not.toHaveBeenCalled();
  });

  it('clears the seen tips and says so politely in the hint', async () => {
    const update = vi.fn(() => Promise.resolve());
    useSettings.setState({ ...settingsInitial, update, tipsSeen: ['draw', 'crop'] }, true);
    const { user } = setup(<Fixture />);
    act(() => openSettings());
    const hint = screen.getByText('Opens the welcome document.');
    expect(hint.getAttribute('aria-live')).toBe('polite');
    await user.click(screen.getByRole('button', { name: 'Show tips again' }));
    expect(update).toHaveBeenCalledWith({ tipsSeen: [] });
    expect(screen.getByText('Tips will show again.').getAttribute('aria-live')).toBe('polite');
  });
});

describe('the Show tips switch (DESIGN 3.13 C5)', () => {
  const settingsInitial = useSettings.getState();
  afterEach(() => useSettings.setState({ ...settingsInitial }, true));

  it('is on by default, named by its label, and writes tipsEnabled', async () => {
    const update = vi.fn(() => Promise.resolve());
    useSettings.setState({ ...settingsInitial, update, tipsSeen: ['draw'] }, true);
    const { user } = setup(<Fixture />);
    act(() => openSettings());
    const toggle = screen.getByRole('switch', { name: 'Show tips' });
    expect(toggle.getAttribute('aria-checked')).toBe('true');
    await user.click(toggle);
    expect(update).toHaveBeenCalledWith({ tipsEnabled: false });
  });

  it('clicking the label toggles the switch', async () => {
    const update = vi.fn(() => Promise.resolve());
    useSettings.setState({ ...settingsInitial, update, tipsSeen: ['draw'] }, true);
    const { user } = setup(<Fixture />);
    act(() => openSettings());
    await user.click(screen.getByText('Show tips'));
    expect(update).toHaveBeenCalledWith({ tipsEnabled: false });
  });

  it('off: hovering "Show tips again" shows the off hint as tooltip', async () => {
    useSettings.setState(
      { ...settingsInitial, update: vi.fn(() => Promise.resolve()), tipsSeen: ['draw'], tipsEnabled: false },
      true,
    );
    const { user } = setup(<Fixture />);
    act(() => openSettings());
    await user.hover(screen.getByRole('button', { name: 'Show tips again' }));
    await waitFor(() => expect(openTooltip()?.textContent).toContain('Tips are off'));
  });

  it('off: "Show tips again" is aria-disabled and the hint says why; the tour button still works', async () => {
    const update = vi.fn(() => Promise.resolve());
    useSettings.setState({ ...settingsInitial, update, tipsSeen: ['draw'], tipsEnabled: false }, true);
    const { user } = setup(<Fixture />);
    act(() => openSettings());
    expect(screen.getByRole('switch', { name: 'Show tips' }).getAttribute('aria-checked')).toBe('false');
    const button = screen.getByRole('button', { name: 'Show tips again' });
    expect(button.getAttribute('aria-disabled')).toBe('true');
    await user.click(button);
    expect(update).not.toHaveBeenCalled();
    expect(screen.getByText('Tips are off. The tour still works.').getAttribute('aria-live')).toBe('polite');
    expect(screen.getByRole('button', { name: /tour/i }).getAttribute('aria-disabled')).not.toBe('true');
  });
});
