// @vitest-environment jsdom
import { act, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { openWelcomeDocument, type DocumentInfo } from '../../api/documents';
import { useDocuments } from '../../stores/documents';
import { useView } from '../../stores/view';
import { setup } from '../../test/render';
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
const WELCOME: DocumentInfo = { id: 7, pageCount: 4, displayName: 'Welcome', kind: 'welcome' };

beforeEach(() => {
  useDocuments.setState({ ...documentsInitial }, true);
  useView.setState({ ...viewInitial }, true);
  useTour.setState({ ...tourInitial }, true);
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
        <button type="button" data-toolbar-item="more">
          More
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
    expect(screen.getByText('Welcome tour')).toBeTruthy();
    expect(screen.getByText('Opens the welcome document.')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Start tour' })).toBeTruthy();
    act(() => useTour.getState().start(1));
    expect(screen.getByRole('button', { name: 'Restart tour' })).toBeTruthy();
  });

  it('closes the popover with focus on More, closes the open document and opens the welcome document', async () => {
    const { user } = setup(<Fixture />);
    useView.getState().open(3, 2);
    useDocuments.getState().add({ id: 3, pageCount: 2, displayName: 'a.pdf', kind: 'user' });
    act(() => openSettings());
    await user.click(screen.getByRole('button', { name: 'Start tour' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'More' }));
    expect(useDocuments.getState().byId[3]).toBeUndefined();
    expect(openWelcomeMock).toHaveBeenCalledTimes(1);
  });
});
