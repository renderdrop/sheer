// @vitest-environment jsdom
import { act, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { actionOf } from '../../actions/registry';
import type { DocumentInfo } from '../../api/documents';
import { activeDocument, opened, resetDocuments } from '../../stores/documents.testutil';
import { useUi } from '../../stores/ui';
import { useView } from '../../stores/view';
import { setup } from '../../test/render';
import { useViewer } from '../viewer/useViewer';
import { EmptyStateSlot } from './EmptyStateSlot';

const documentsApi = vi.hoisted(() => ({
  openDocumentDialog: vi.fn(),
  closeDocument: vi.fn(),
}));

vi.mock('../../api/documents', () => documentsApi);
vi.mock('../../api/render', () => ({
  renderPage: vi.fn(),
  setViewport: vi.fn().mockResolvedValue(undefined),
  getPageSizes: vi.fn().mockResolvedValue([]),
}));

const uiInitial = useUi.getState();
const viewerInitial = useViewer.getState();
const REPORT: DocumentInfo = { id: 1, pageCount: 10, displayName: 'Report.pdf' };

function reset() {
  useUi.setState({ ...uiInitial }, true);
  useViewer.setState({ ...viewerInitial }, true);
  resetDocuments();
  useView.setState({ byDoc: {} });
}

beforeEach(() => {
  reset();
  documentsApi.openDocumentDialog.mockReset().mockResolvedValue([opened(REPORT)]);
  documentsApi.closeDocument.mockReset().mockResolvedValue(undefined);
});

afterEach(() => {
  vi.restoreAllMocks();
  reset();
});

const openButton = () => screen.getByRole('button', { name: 'Open' });

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
    expect(activeDocument()).toEqual(REPORT);
  });

  it('asks the registry first: a disabled Open action does not open anything', async () => {
    const { user } = setup(<EmptyStateSlot platform="windows" />);
    vi.spyOn(actionOf('open'), 'enabled').mockReturnValue(false);
    await user.click(openButton());
    expect(documentsApi.openDocumentDialog).not.toHaveBeenCalled();
    expect(activeDocument()).toBeNull();
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

  it('shows the Open card busy while a document is being opened and refuses a second click (the viewer guards it)', async () => {
    let finish: (info: DocumentInfo[]) => void = () => undefined;
    documentsApi.openDocumentDialog.mockReturnValueOnce(
      new Promise<DocumentInfo[]>((resolve) => {
        finish = resolve;
      }),
    );
    const { user } = setup(<EmptyStateSlot platform="windows" />);
    await user.click(openButton());
    const busy = openButton();
    expect(busy.getAttribute('aria-busy')).toBe('true');
    expect(busy.getAttribute('aria-disabled')).toBe('true');
    await user.click(busy);
    expect(documentsApi.openDocumentDialog).toHaveBeenCalledTimes(1);
    await act(async () => finish([]));
    expect(openButton().getAttribute('aria-busy')).toBeNull();
  });
});

describe('the drop target (MOTION 4.5)', () => {
  const card = () => document.querySelector('[data-drop-card]');

  it('shows no preview card until a file is dragged over, then a card that holds a moment after the drag left', async () => {
    setup(<EmptyStateSlot platform="windows" />);
    expect(card()).toBeNull();
    act(() => useUi.getState().setDropHover(true));
    expect(card()).not.toBeNull();
    expect(screen.getByText('PDF')).not.toBeNull();
    act(() => useUi.getState().setDropHover(false));
    // Held for DROP_HOLD_MS (a drop that is accepted lets it fall), then it fades out and goes.
    expect(card()).not.toBeNull();
    await waitFor(() => expect(card()).toBeNull());
  });
});

vi.mock('../../api/pages', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../api/pages')>()),
  getPages: vi.fn().mockResolvedValue([]),
}));
