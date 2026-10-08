// @vitest-environment jsdom
import { within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { useDocuments } from '../../stores/documents';
import { resetDocuments } from '../../stores/documents.testutil';
import { useUi } from '../../stores/ui';
import { useView } from '../../stores/view';
import { setup } from '../../test/render';
import { useToolInspector } from '../inspector/toolInspector';
import { TopBar } from './TopBar';

vi.mock('../save/commands', () => ({ saveNow: vi.fn(), saveActive: vi.fn(), needsSavePrompt: () => false }));
vi.mock('../viewer/useViewer', () => ({
  useViewer: Object.assign((select: (state: unknown) => unknown) => select({ rendering: false }), {
    getState: () => ({ rendering: false }),
  }),
}));

const bar = () => within(document.querySelector<HTMLElement>('[data-slot="tabstrip"]') as HTMLElement);

function open(...names: string[]): void {
  names.forEach((name, index) => {
    useDocuments.getState().add({ id: index + 1, pageCount: 12, displayName: name });
    useView.getState().open(index + 1, 12);
  });
}

beforeEach(() => {
  resetDocuments();
  useView.setState({ byDoc: {} });
  useToolInspector.setState({ open: null });
  useUi.getState().setView('editor');
});

describe('the tab strip row (DESIGN 3.18 E3)', () => {
  it('shows the document as a tab even with one document, with the tour anchor on the name', () => {
    open('Report.pdf');
    setup(<TopBar trafficLightInset={false} />);
    expect(bar().getByRole('tablist', { name: 'Open documents' })).not.toBeNull();
    expect(bar().getByText('Report.pdf').getAttribute('data-tour-anchor')).toBe('topbar-file-name');
  });

  it('is 42 high and a drag region; macOS insets it for the traffic lights', () => {
    open('Report.pdf');
    const { unmount } = setup(<TopBar trafficLightInset={false} />);
    const row = document.querySelector('[data-slot="tabstrip"]');
    expect(row?.className).toContain('h-tabstrip');
    expect(row?.getAttribute('data-tauri-drag-region')).toBe('deep');
    unmount();
    setup(<TopBar trafficLightInset />);
    expect(document.querySelector('[data-slot="tabstrip"]')?.className).toContain('ps-chrome-inset');
  });

  it('the Back chevron shows Home', async () => {
    open('Report.pdf');
    const { user } = setup(<TopBar trafficLightInset={false} />);
    await user.click(bar().getByRole('button', { name: 'Back to Home' }));
    expect(useUi.getState().view).toBe('home');
  });

  it('has Undo, Redo, History and Search on the right, and nothing of the old top row', () => {
    open('Report.pdf');
    setup(<TopBar trafficLightInset={false} />);
    for (const name of ['Undo', 'Redo', 'History'])
      expect(bar().getByRole('button', { name: new RegExp(name) }), name).not.toBeNull();
    expect(bar().getByRole('button', { name: /Search|Find/ })).not.toBeNull();
    for (const name of ['Export', 'More', 'Close', 'Minimize', 'Done', 'Hide sidebar', 'Show sidebar'])
      expect(bar().queryByRole('button', { name }), name).toBeNull();
    expect(bar().queryByRole('textbox')).toBeNull();
    expect(document.querySelector('[data-save-status]')).toBeNull();
  });

  it('History toggles the inspector slot and shows pressed while it is open', async () => {
    open('Report.pdf');
    const { user } = setup(<TopBar trafficLightInset={false} />);
    const history = bar().getByRole('button', { name: 'History' });
    expect(history.getAttribute('aria-pressed')).toBe('false');
    await user.click(history);
    expect(useToolInspector.getState().open).toBe('history');
    expect(bar().getByRole('button', { name: 'History' }).getAttribute('aria-pressed')).toBe('true');
    await user.click(bar().getByRole('button', { name: 'History' }));
    expect(useToolInspector.getState().open).toBeNull();
  });
});
