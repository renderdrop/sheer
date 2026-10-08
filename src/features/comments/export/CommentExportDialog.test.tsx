// @vitest-environment jsdom
import { act, screen, waitFor } from '@testing-library/react';
import { MotionGlobalConfig } from 'motion/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { AnnotationSummary } from '../../../api/annotations';
import { setup } from '../../../test/render';
import { resetViewer, showDocument } from '../../viewer/viewer.testutil';
import { buildThreads } from '../model';
import { useComments } from '../store';
import { CommentExportDialog } from './CommentExportDialog';
import { closeCommentExport, openCommentExport } from './runtime';
import { useCommentExport } from './store';

const exportComments = vi.hoisted(() => vi.fn());
vi.mock('../../../api/commentExport', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../api/commentExport')>()),
  exportComments,
}));

const note = (id: number): AnnotationSummary => ({
  id,
  pageId: 0,
  kind: 'note',
  color: [255, 235, 0],
  contents: `Text ${id}`,
  author: 'Ann',
  modified: '2024-01-01T00:00:00Z',
  inReplyTo: null,
});

const seedComments = (summaries: readonly AnnotationSummary[]) =>
  useComments.setState({
    byDoc: { 1: { status: 'ready', token: 1, summaries, threads: buildThreads(summaries) } },
    views: {},
    editing: {},
  });

beforeEach(() => {
  MotionGlobalConfig.skipAnimations = true;
  exportComments.mockReset();
  useCommentExport.setState({ dialog: null });
  resetViewer();
  showDocument({ id: 1, pageCount: 3, displayName: 'Book.pdf' });
  seedComments([note(1)]);
});

afterEach(() => {
  MotionGlobalConfig.skipAnimations = false;
  useCommentExport.setState({ dialog: null });
});

describe('the comment export dialog', () => {
  it('opens for the active tab with Export enabled, and is hidden again after closing', async () => {
    setup(<CommentExportDialog />);
    expect(screen.queryByRole('dialog')).toBeNull();
    act(() => openCommentExport());
    const dialog = await screen.findByRole('dialog');
    expect(dialog.querySelector('[data-surface="comment-export"]')).not.toBeNull();
    expect(screen.getByRole('button', { name: 'Export…' }).getAttribute('aria-disabled')).not.toBe('true');
    act(() => closeCommentExport());
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
  });

  it('Cancel closes it without exporting', async () => {
    const { user } = setup(<CommentExportDialog />);
    act(() => openCommentExport());
    await screen.findByRole('dialog');
    await user.click(screen.getByRole('button', { name: 'Cancel' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(exportComments).not.toHaveBeenCalled();
    expect(useCommentExport.getState().dialog).toBeNull();
  });

  it('Esc closes it', async () => {
    const { user } = setup(<CommentExportDialog />);
    act(() => openCommentExport());
    await screen.findByRole('dialog');
    await user.keyboard('{Escape}');
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(exportComments).not.toHaveBeenCalled();
  });
});
