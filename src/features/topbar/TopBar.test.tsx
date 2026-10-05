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
    setup(<TopBar trafficLightInset={false} />);
    expect(bar().getByText('Report.pdf').getAttribute('data-tour-anchor')).toBe('topbar-file-name');
    expect(bar().queryByRole('tablist')).toBeNull();
    expect(document.querySelector('[data-tour-anchor="topbar-page-field"]')).not.toBeNull();
    expect(document.querySelector('[data-toolbar-item="zoom-in"]')).not.toBeNull();
    act(() => open('Other.pdf'));
    expect(bar().getByRole('tablist', { name: 'Open documents' })).not.toBeNull();
  });

  it('the Back chevron shows Home', async () => {
    open('Report.pdf');
    const { user } = setup(<TopBar trafficLightInset={false} />);
    await user.click(bar().getByRole('button', { name: 'Back to Home' }));
    expect(useUi.getState().view).toBe('home');
  });

  it('a double click on the name is Save As', () => {
    open('Report.pdf');
    setup(<TopBar trafficLightInset={false} />);
    fireEvent.doubleClick(bar().getByText('Report.pdf'));
    expect(save.saveActive).toHaveBeenCalledWith(true);
  });

  it('the page field goes to the typed page, refuses a wrong one, and the go-to-page action focuses it', async () => {
    open('Report.pdf');
    const { user } = setup(<TopBar trafficLightInset={false} />);
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

  it('has Undo, Redo and Search on the right, and no Done, Export, More or caption buttons', () => {
    open('Report.pdf');
    setup(<TopBar trafficLightInset={false} />);
    for (const name of ['Undo', 'Redo'])
      expect(bar().getByRole('button', { name: new RegExp(name) }), name).not.toBeNull();
    expect(bar().getByRole('button', { name: /Search|Find/ })).not.toBeNull();
    for (const name of ['Export', 'More', 'Close', 'Minimize', 'Done'])
      expect(bar().queryByRole('button', { name }), name).toBeNull();
  });

  it('the zoom menu holds the scroll modes and the rotation', async () => {
    open('Report.pdf');
    const { user } = setup(<TopBar trafficLightInset={false} />);
    await user.click(bar().getByRole('button', { name: /Zoom level/ }));
    const zoom = within(screen.getByRole('menu', { name: 'Zoom' }));
    expect(zoom.getByText('Scrolling')).not.toBeNull();
    expect(zoom.getByText('Rotate view')).not.toBeNull();
  });
});
