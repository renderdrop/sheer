// @vitest-environment jsdom
import { act, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { actionOf } from '../../actions/registry';
import type { DocumentInfo } from '../../api/documents';
import { useUi } from '../../stores/ui';
import { useView } from '../../stores/view';
import { setup } from '../../test/render';
import { useViewer } from '../viewer/useViewer';
import { EmptyStateSlot } from './EmptyStateSlot';

const documentsApi = vi.hoisted(() => ({
  openDocumentDialog: vi.fn(),
  renderPage: vi.fn(),
  closeDocument: vi.fn(),
}));

vi.mock('../../api/documents', () => documentsApi);

const uiInitial = useUi.getState();
const viewerInitial = useViewer.getState();
const REPORT: DocumentInfo = { id: 1, pageCount: 10, displayName: 'Report.pdf' };

function reset() {
  useUi.setState({ ...uiInitial }, true);
  useViewer.setState({ ...viewerInitial }, true);
  useView.setState({ byDoc: {} });
}

beforeEach(() => {
  reset();
  documentsApi.openDocumentDialog.mockReset().mockResolvedValue(REPORT);
  documentsApi.closeDocument.mockReset().mockResolvedValue(undefined);
});

afterEach(() => {
  vi.restoreAllMocks();
  reset();
});

const openButton = () => screen.getByRole('button', { name: 'Open…' });

describe('the empty state in its slot', () => {
  it('shows the platform shortcut of Open from the registry', () => {
    setup(<EmptyStateSlot platform="windows" />);
    expect(openButton().getAttribute('aria-keyshortcuts')).toBe('Control+O');
    expect(screen.getByText('Ctrl+O')).not.toBeNull();
  });

  it('Open runs the registry action, like the key, More and the menu bar, and opens the document', async () => {
    const run = vi.spyOn(actionOf('open'), 'run');
    const { user } = setup(<EmptyStateSlot platform="windows" />);
    await user.click(openButton());
    expect(run).toHaveBeenCalledTimes(1);
    expect(documentsApi.openDocumentDialog).toHaveBeenCalledTimes(1);
    expect(useViewer.getState().doc).toEqual(REPORT);
  });

  it('asks the registry first: a disabled Open action does not open anything', async () => {
    const { user } = setup(<EmptyStateSlot platform="windows" />);
    vi.spyOn(actionOf('open'), 'enabled').mockReturnValue(false);
    await user.click(openButton());
    expect(documentsApi.openDocumentDialog).not.toHaveBeenCalled();
    expect(useViewer.getState().doc).toBeNull();
  });

  it('Enter and Space on the focused button open it too, once each', async () => {
    const run = vi.spyOn(actionOf('open'), 'run');
    const { user } = setup(<EmptyStateSlot platform="windows" />);
    openButton().focus();
    await user.keyboard('{Enter}');
    await act(async () => undefined);
    await user.keyboard(' ');
    expect(run).toHaveBeenCalledTimes(2);
  });

  it('says "Opening…" while a document is being opened and refuses a second click (the viewer guards it)', async () => {
    let finish: (info: DocumentInfo | null) => void = () => undefined;
    documentsApi.openDocumentDialog.mockReturnValueOnce(
      new Promise<DocumentInfo | null>((resolve) => {
        finish = resolve;
      }),
    );
    const { user } = setup(<EmptyStateSlot platform="windows" />);
    await user.click(openButton());
    const busy = screen.getByRole('button', { name: 'Opening…' });
    expect(busy.getAttribute('aria-disabled')).toBe('true');
    await user.click(busy);
    expect(documentsApi.openDocumentDialog).toHaveBeenCalledTimes(1);
    await act(async () => finish(null));
    expect(screen.getByRole('button', { name: 'Open…' })).not.toBeNull();
  });
});
