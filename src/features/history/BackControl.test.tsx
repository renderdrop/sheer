// @vitest-environment jsdom
import { act, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { useDocuments } from '../../stores/documents';
import { resetDocuments } from '../../stores/documents.testutil';
import { usePages } from '../../stores/pages';
import { useView } from '../../stores/view';
import { openTooltip, setup } from '../../test/render';
import { BackControl } from './BackControl';
import { useHistoryStore } from './store';

const back = vi.hoisted(() => vi.fn());
vi.mock('./actions', async (original) => ({ ...(await original<typeof import('./actions')>()), back }));

function resize(width: number): void {
  Object.defineProperty(window, 'innerWidth', { value: width, configurable: true });
  act(() => void window.dispatchEvent(new Event('resize')));
}

beforeEach(() => {
  resetDocuments();
  useHistoryStore.setState({ byDoc: {} });
  usePages.setState({ slotsByDoc: {}, byDoc: {} });
  useDocuments.getState().add({ id: 1, pageCount: 12, displayName: 'a.pdf' });
  useView.setState({ byDoc: {} });
  useView.getState().open(1, 12);
  back.mockReset();
  resize(1280);
});

const button = () => document.querySelector<HTMLElement>('[data-toolbar-item="history-back"]') as HTMLElement;

describe('the Back control', () => {
  it('keeps its 96 px slot and is disabled with the empty tooltip when there is no history', async () => {
    const { user } = setup(<BackControl />);
    expect(document.querySelector('[data-slot="history-back"]')).not.toBeNull();
    expect(button().getAttribute('aria-disabled')).toBe('true');
    expect(button().getAttribute('aria-label')).toBe('Nothing to go back to yet');
    await user.click(button());
    expect(back).not.toHaveBeenCalled();
  });

  it('shows the page it returns to from 1100 px and the icon only below', async () => {
    useHistoryStore.getState().push(1, { pageId: 3, xPt: 0, yPt: 0, zoom: 1, fit: 'none' }, 800);
    const { user } = setup(<BackControl />);
    expect(screen.getByText('p. 4')).not.toBeNull();
    expect(button().getAttribute('aria-label')).toBe('Back to previous view');
    resize(1000);
    expect(screen.queryByText('p. 4')).toBeNull();
    await user.click(button());
    expect(back).toHaveBeenCalledWith(1);
  });

  it('shows the Back tooltip with the key chip', async () => {
    useHistoryStore.getState().push(1, { pageId: 3, xPt: 0, yPt: 0, zoom: 1, fit: 'none' }, 800);
    const { user } = setup(<BackControl />);
    await user.hover(button());
    await vi.waitFor(() => expect(openTooltip()?.textContent).toContain('Back to previous view'));
    expect(openTooltip()?.textContent).toContain('Alt');
  });
});
