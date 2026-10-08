// @vitest-environment jsdom
import { act, screen, waitFor } from '@testing-library/react';
import { MotionGlobalConfig } from 'motion/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { ChangeSet } from '../../api/annotations';
import { emptyBibRecord, type BibliographyInfo } from '../../api/citations';
import { useAnnotations } from '../../stores/annotations';
import { useDocuments } from '../../stores/documents';
import { useUi } from '../../stores/ui';
import { setup } from '../../test/render';
import { ToolInspector } from '../inspector/ToolInspectorPanel';
import { useToolInspector } from '../inspector/toolInspector';
import { closeReferenceInspector, openReferenceDetails, useReferenceInspector } from './openReference';

const bib = vi.hoisted(() => ({
  state: { info: undefined, loading: true } as { info: unknown; loading: boolean; error?: unknown },
  invalidate: vi.fn(),
  setBibliography: vi.fn(),
}));
vi.mock('../citations/bibliography', () => ({
  useBibliography: () => bib.state,
  invalidateBibliography: bib.invalidate,
}));
vi.mock('../../api/citations', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../api/citations')>()),
  setBibliography: bib.setBibliography,
}));

MotionGlobalConfig.skipAnimations = true;

const HISTORY = { canUndo: true, canRedo: false, undoLabel: 'Edit', redoLabel: null, dirty: true };
const changes: ChangeSet = { rev: 2, upserted: [], removed: [], pages: null, history: HISTORY };
const bibInfo: BibliographyInfo = {
  record: {
    ...emptyBibRecord(),
    kind: 'article',
    authors: [{ family: 'Müller', given: 'Anna' }],
    title: 'On things',
    year: '2021',
    containerTitle: 'Journal of Things',
  },
  sources: { title: 'xmp', year: 'info', authors: 'heuristic', containerTitle: 'xmp', kind: 'xmp' },
  pending: false,
  droppedByStrip: false,
};

beforeEach(() => {
  useDocuments.setState({
    byId: { 1: { id: 1, pageCount: 3, displayName: 'a.pdf', kind: 'user' } },
    order: [1],
    activeId: 1,
  });
  useAnnotations.setState({ byDoc: {} });
  useUi.setState({ toast: null, banner: null });
  useToolInspector.setState({ open: null });
  closeReferenceInspector();
  bib.state = { info: bibInfo, loading: false };
  bib.invalidate.mockReset();
  bib.setBibliography.mockReset().mockResolvedValue(changes);
});

const apply = () => screen.getByRole('button', { name: 'Apply' });

describe('the Quellenangabe inspector', () => {
  it('opens through openReferenceDetails and shows the prefilled fields', async () => {
    setup(<ToolInspector />);
    act(() => openReferenceDetails(1));
    expect(useToolInspector.getState().open).toBe('reference');
    expect(await screen.findByRole('complementary', { name: 'Reference' })).toBeTruthy();
    expect((screen.getByLabelText('Title') as HTMLInputElement).value).toBe('On things');
    expect((screen.getByLabelText('Year') as HTMLInputElement).value).toBe('2021');
    expect(screen.getAllByText('from the file').length).toBeGreaterThan(0);
    await waitFor(() => expect(document.activeElement).not.toBe(document.body));
  });

  it('shows a skeleton while the record loads', () => {
    bib.state = { info: undefined, loading: true };
    setup(<ToolInspector />);
    act(() => openReferenceDetails(1));
    expect(document.querySelector('[aria-busy="true"]')).not.toBeNull();
    expect(screen.queryByLabelText('Year')).toBeNull();
  });

  it('keeps Apply disabled for an invalid value and enables it for a valid edit', async () => {
    const { user } = setup(<ToolInspector />);
    act(() => openReferenceDetails(1));
    expect(apply().getAttribute('aria-disabled')).toBe('true');
    const year = screen.getByLabelText('Year');
    await user.clear(year);
    await user.type(year, '21');
    await user.tab();
    expect(year.getAttribute('aria-invalid')).toBe('true');
    expect(apply().getAttribute('aria-disabled')).toBe('true');
    await user.clear(year);
    await user.type(year, '2022');
    expect(apply().hasAttribute('aria-disabled')).toBe(false);
  });

  it('applies the record with setBibliography, invalidates it and closes', async () => {
    const { user } = setup(<ToolInspector />);
    act(() => openReferenceDetails(1));
    await user.type(screen.getByLabelText('Volume'), '5');
    await user.click(apply());
    await waitFor(() => expect(bib.setBibliography).toHaveBeenCalledTimes(1));
    const [docId, record] = bib.setBibliography.mock.calls[0] as [number, { volume: string; title: string }];
    expect(docId).toBe(1);
    expect(record.volume).toBe('5');
    expect(record.title).toBe('On things');
    expect(bib.invalidate).toHaveBeenCalledWith(1);
    await waitFor(() => expect(useToolInspector.getState().open).toBeNull());
  });

  it('Reset restores the loaded record; Esc discards without writing', async () => {
    const { user } = setup(<ToolInspector />);
    act(() => openReferenceDetails(1));
    expect(screen.getByRole('button', { name: 'Reset' }).getAttribute('aria-disabled')).toBe('true');
    await user.type(screen.getByLabelText('Volume'), '5');
    await user.click(screen.getByRole('button', { name: 'Reset' }));
    expect((screen.getByLabelText('Volume') as HTMLInputElement).value).toBe('');
    await user.type(screen.getByLabelText('Volume'), '5');
    await user.keyboard('{Escape}');
    expect(useToolInspector.getState().open).toBeNull();
    expect(useReferenceInspector.getState().docId).toBeNull();
    expect(bib.setBibliography).not.toHaveBeenCalled();
  });

  it('shows read-only fields on a document that forbids edits', () => {
    useDocuments.setState({
      byId: {
        1: {
          id: 1,
          pageCount: 3,
          displayName: 'a.pdf',
          kind: 'user',
          flags: { encrypted: true, xfa: false, hasForms: false, signed: false, permissions: ['print'] },
        },
      },
    });
    setup(<ToolInspector />);
    act(() => openReferenceDetails(1));
    expect(screen.getByText("This document can't be edited.")).toBeTruthy();
    expect(screen.getByLabelText('Title').hasAttribute('readonly')).toBe(true);
    expect(apply().getAttribute('aria-disabled')).toBe('true');
  });

  it('starts from an empty, editable record when nothing was found', () => {
    bib.state = { info: { ...bibInfo, record: emptyBibRecord(), sources: {} }, loading: false };
    setup(<ToolInspector />);
    act(() => openReferenceDetails(1));
    expect(screen.getByText('Nothing found in the file. Fill in what you know.')).toBeTruthy();
    expect(screen.getByLabelText('Title').hasAttribute('readonly')).toBe(false);
  });

  it('closes when another tab becomes active', () => {
    useDocuments.setState({
      byId: {
        1: { id: 1, pageCount: 3, displayName: 'a.pdf', kind: 'user' },
        2: { id: 2, pageCount: 3, displayName: 'b.pdf', kind: 'user' },
      },
      order: [1, 2],
    });
    setup(<ToolInspector />);
    act(() => openReferenceDetails(1));
    act(() => useDocuments.setState({ activeId: 2 }));
    expect(useToolInspector.getState().open).toBeNull();
  });
});
