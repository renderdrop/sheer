// @vitest-environment jsdom
import { act, fireEvent, screen, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { useDocuments } from '../../stores/documents';
import { resetDocuments } from '../../stores/documents.testutil';
import { useUi } from '../../stores/ui';
import { useView } from '../../stores/view';
import { setup } from '../../test/render';
import { useGoToPage } from './goToState';
import { TopBar } from './TopBar';

const save = vi.hoisted(() => ({ saveNow: vi.fn(), saveActive: vi.fn() }));
vi.mock('../save/commands', () => save);
const goToPage = vi.hoisted(() => vi.fn());
vi.mock('../viewer/useViewer', () => ({
  useViewer: Object.assign((select: (state: unknown) => unknown) => select({ goToPage, rendering: false }), {
    getState: () => ({ goToPage, rendering: false }),
  }),
}));

const doc = (id: number, name: string, pageCount = 12) => ({ id, pageCount, displayName: name });
const bar = () => within(document.querySelector<HTMLElement>('[data-slot="topbar"]') as HTMLElement);

function open(...names: string[]): void {
  const base = useDocuments.getState().order.length;
  names.forEach((name, index) => {
    useDocuments.getState().add(doc(base + index + 1, name));
    useView.getState().open(base + index + 1, 12);
  });
}

beforeEach(() => {
  resetDocuments();
  useView.setState({ byDoc: {} });
  useUi.getState().setView('editor');
  save.saveNow.mockReset().mockResolvedValue(true);
  goToPage.mockReset();
});

describe('the top bar', () => {
  it('shows the file name with the tour anchors, and tabs from two documents on', () => {
    open('Report.pdf');
    setup(<TopBar trafficLightInset={false} captionControls={null} />);
    expect(bar().getByText('Report.pdf').getAttribute('data-tour-anchor')).toBe('status-file-name');
    expect(bar().queryByRole('tablist')).toBeNull();
    expect(document.querySelector('[data-tour-anchor="status-page-button"]')).not.toBeNull();
    expect(document.querySelector('[data-toolbar-item="zoom-in"]')).not.toBeNull();
    expect(document.querySelector('[data-toolbar-item="more"]')).not.toBeNull();
    act(() => open('Other.pdf'));
    expect(bar().getByRole('tablist', { name: 'Open documents' })).not.toBeNull();
  });

  it('the Back chevron shows Home', async () => {
    open('Report.pdf');
    const { user } = setup(<TopBar trafficLightInset={false} captionControls={null} />);
    await user.click(bar().getByRole('button', { name: 'Back to Home' }));
    expect(useUi.getState().view).toBe('home');
  });

  it('Done goes straight to Home without changes, and saves first with them', async () => {
    open('Report.pdf');
    const { user } = setup(<TopBar trafficLightInset={false} captionControls={null} />);
    await user.click(bar().getByRole('button', { name: 'Done' }));
    expect(save.saveNow).not.toHaveBeenCalled();
    expect(useUi.getState().view).toBe('home');

    useUi.getState().setView('editor');
    act(() =>
      useDocuments.setState((state) => ({
        byId: { ...state.byId, 1: { ...doc(1, 'Report.pdf'), kind: 'recovered' } },
      })),
    );
    expect(bar().getByText('Edited')).not.toBeNull();
    save.saveNow.mockResolvedValueOnce(false);
    await user.click(bar().getByRole('button', { name: 'Done' }));
    expect(save.saveNow).toHaveBeenCalledWith(1);
    expect(useUi.getState().view).toBe('editor');
    await user.click(bar().getByRole('button', { name: 'Done' }));
    expect(useUi.getState().view).toBe('home');
  });

  it('a double click on the name is Save As', () => {
    open('Report.pdf');
    setup(<TopBar trafficLightInset={false} captionControls={null} />);
    fireEvent.doubleClick(bar().getByText('Report.pdf'));
    expect(save.saveActive).toHaveBeenCalledWith(true);
  });

  it('the page field goes to the typed page, refuses a wrong one, and the go-to-page action focuses it', async () => {
    open('Report.pdf');
    const { user } = setup(<TopBar trafficLightInset={false} captionControls={null} />);
    const field = bar().getByRole('textbox', { name: 'Go to page' }) as HTMLInputElement;
    expect(field.value).toBe('1');
    expect(field.parentElement?.textContent).toBe('/ 12');
    await user.click(field);
    await user.keyboard('{Control>}a{/Control}13{Enter}');
    expect(goToPage).not.toHaveBeenCalled();
    expect(field.getAttribute('aria-invalid')).toBe('true');
    await user.keyboard('{Control>}a{/Control}5{Enter}');
    expect(goToPage).toHaveBeenCalledWith(4);
    field.blur();
    act(() => useGoToPage.getState().setOpen(true));
    expect(document.activeElement).toBe(field);
    expect(useGoToPage.getState().open).toBe(false);
  });

  it('the menus hold the commands of the old Windows menu bar', async () => {
    open('Report.pdf');
    const { user } = setup(<TopBar trafficLightInset={false} captionControls={null} />);
    await user.click(bar().getByRole('button', { name: 'More' }));
    const more = within(screen.getByRole('menu', { name: 'More' }));
    for (const name of ['Document properties', 'Save As…', 'Settings']) {
      expect(more.getByRole('menuitem', { name: new RegExp(name) }), name).not.toBeNull();
    }
    await user.keyboard('{Escape}');
    await user.click(bar().getByRole('button', { name: /Zoom level/ }));
    const zoom = within(screen.getByRole('menu', { name: 'Zoom' }));
    expect(zoom.getByText('Scrolling')).not.toBeNull();
    expect(zoom.getByText('Rotate view')).not.toBeNull();
  });
});
