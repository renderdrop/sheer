// @vitest-environment jsdom
import { act, screen, waitFor, within } from '@testing-library/react';
import { MotionGlobalConfig } from 'motion/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { ChangeSet } from '../../api/annotations';
import { emptyBibRecord, type BibliographyInfo } from '../../api/citations';
import type { DocMetadata } from '../../api/metadata';
import { useAnnotations } from '../../stores/annotations';
import { useDocuments } from '../../stores/documents';
import { useUi } from '../../stores/ui';
import { setup } from '../../test/render';
import { openReferenceDetails, usePropertiesTabRequest } from './openReference';
import { PropertiesDialog } from './PropertiesDialog';
import { buildPatch, formatDate } from './rules';

const api = vi.hoisted(() => ({
  getMetadata: vi.fn(),
  setMetadata: vi.fn(),
  removeMetadata: vi.fn(),
  getProtection: vi.fn(),
}));
vi.mock('../../api/metadata', () => ({
  getMetadata: api.getMetadata,
  setMetadata: api.setMetadata,
  removeMetadata: api.removeMetadata,
  MAX_METADATA_FIELD_CHARS: 1000,
}));
vi.mock('../../api/protection', () => ({ getProtection: api.getProtection }));

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
const metadata: DocMetadata = {
  title: 'Old <b>title</b>',
  author: null,
  subject: null,
  keywords: null,
  creator: 'Writer',
  producer: 'Engine',
  created: '2024-03-01T10:00:00Z',
  modified: null,
  pdfVersion: '1.7',
  fileBytes: 1500,
  xmp: { present: true, bytes: 10 },
  truncated: false,
  pending: 'none',
};

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
  useUi.setState({ propsOpen: true, toast: null, banner: null });
  bib.state = { info: bibInfo, loading: false };
  bib.invalidate.mockReset();
  bib.setBibliography.mockReset().mockResolvedValue(changes);
  usePropertiesTabRequest.setState({ tab: null });
  api.getMetadata.mockReset().mockResolvedValue(metadata);
  api.setMetadata.mockReset().mockResolvedValue(changes);
  api.removeMetadata.mockReset().mockResolvedValue(changes);
  api.getProtection.mockReset().mockResolvedValue({ encrypted: false });
});

function Fixture() {
  return (
    <>
      <div id="root" />
      <PropertiesDialog />
    </>
  );
}

const apply = () => screen.getByRole('button', { name: 'Apply' });
const title = () => screen.getByLabelText('Title') as HTMLInputElement;
const loaded = () => waitFor(() => expect(title().value).not.toBe(''));

describe('rules', () => {
  it('patches only changed fields and clears emptied ones', () => {
    const before = { title: 'a', author: 'b', subject: '', keywords: '' };
    expect(buildPatch(before, before)).toEqual({});
    expect(buildPatch(before, { ...before, title: 'c', author: '' })).toEqual({ title: 'c', author: null });
  });
  it('formats dates in the locale and falls back', () => {
    expect(formatDate(null, 'en', '-')).toBe('-');
    expect(formatDate('garbage', 'en', '-')).toBe('garbage');
    expect(formatDate('2024-03-01T10:00:00Z', 'en', '-')).toContain('2024');
  });
});

describe('the Document properties dialog', () => {
  it('lays the fields and facts out in two columns so the panel never scrolls (Q7)', async () => {
    setup(<Fixture />);
    await loaded();
    expect(screen.getByTestId('props-fields').className).toContain('grid-cols-2');
    expect(screen.getByTestId('props-facts').className).toContain('grid-cols-[max-content_1fr_max-content_1fr]');
  });

  it('shows file text as text and the read-only values', async () => {
    setup(<Fixture />);
    await loaded();
    expect(title().value).toBe('Old <b>title</b>');
    expect(document.activeElement).toBe(title());
    expect(screen.getByText('Writer')).toBeTruthy();
    expect(screen.getByText('1.5 KB')).toBeTruthy();
    expect(screen.getByText('3')).toBeTruthy();
    expect(screen.getByText(/XMP metadata/)).toBeTruthy();
    expect(document.querySelector('dl b')).toBeNull();
    expect(apply().getAttribute('aria-disabled')).toBe('true');
  });

  it('applies an edit as one patch with only the changed field', async () => {
    const { user } = setup(<Fixture />);
    await loaded();
    await user.type(screen.getByLabelText('Author'), 'Ann{Enter}');
    await waitFor(() => expect(api.setMetadata).toHaveBeenCalledWith(1, { author: 'Ann' }));
    await waitFor(() => expect(useUi.getState().propsOpen).toBe(false));
    expect(useUi.getState().toast).toBeNull();
  });

  it('limits the length of a field', async () => {
    setup(<Fixture />);
    await loaded();
    expect(screen.getByLabelText('Keywords').getAttribute('maxlength')).toBe('1000');
  });

  it('changes nothing before Apply, then removes everything with a toast', async () => {
    const { user } = setup(<Fixture />);
    await loaded();
    await user.click(screen.getByRole('button', { name: 'Remove all metadata' }));
    expect(api.removeMetadata).not.toHaveBeenCalled();
    expect(title().value).toBe('');
    expect(screen.getAllByText('Will be removed').length).toBeGreaterThan(0);
    expect(screen.getByRole('status').textContent).toContain('Document metadata is removed');
    await user.click(apply());
    await waitFor(() => expect(api.removeMetadata).toHaveBeenCalledWith(1));
    await waitFor(() => expect(useUi.getState().toast?.message).toBe('Metadata removed'));
    expect(useUi.getState().toast?.action?.label).toBe('Undo');
  });

  it('discards on Esc', async () => {
    const { user } = setup(<Fixture />);
    await loaded();
    await user.click(screen.getByRole('button', { name: 'Remove all metadata' }));
    await user.keyboard('{Escape}');
    await waitFor(() => expect(useUi.getState().propsOpen).toBe(false));
    expect(api.removeMetadata).not.toHaveBeenCalled();
    act(() => useUi.getState().setPropsOpen(true));
    await waitFor(() => expect(title().value).toBe('Old <b>title</b>'));
  });
});

describe('the Reference tab', () => {
  const tab = (name: string) => screen.getByRole('tab', { name });

  it('has General and Reference tabs and starts on General', async () => {
    setup(<Fixture />);
    await loaded();
    expect(tab('General').getAttribute('aria-selected')).toBe('true');
    expect(tab('Reference').getAttribute('aria-selected')).toBe('false');
  });

  it('opens on Reference through openReferenceDetails and shows the prefilled fields', async () => {
    act(() => {
      useUi.getState().setPropsOpen(false);
      openReferenceDetails(1);
    });
    setup(<Fixture />);
    await waitFor(() => expect(tab('Reference').getAttribute('aria-selected')).toBe('true'));
    expect((screen.getByLabelText('Title') as HTMLInputElement).value).toBe('On things');
    expect((screen.getByLabelText('Year') as HTMLInputElement).value).toBe('2021');
    expect(screen.getAllByText('from the file').length).toBeGreaterThan(0);
    expect(usePropertiesTabRequest.getState().tab).toBeNull();
  });

  it('shows a skeleton while the record loads', async () => {
    bib.state = { info: undefined, loading: true };
    const { user } = setup(<Fixture />);
    await loaded();
    await user.click(tab('Reference'));
    expect(document.querySelector('[aria-busy="true"]')).not.toBeNull();
    expect(screen.queryByLabelText('Year')).toBeNull();
  });

  it('keeps Apply disabled for an invalid value and enables it for a valid edit', async () => {
    const { user } = setup(<Fixture />);
    await loaded();
    await user.click(tab('Reference'));
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

  it('applies the record with setBibliography, then invalidates it', async () => {
    const { user } = setup(<Fixture />);
    await loaded();
    await user.click(tab('Reference'));
    await user.type(screen.getByLabelText('Volume'), '5');
    await user.click(apply());
    await waitFor(() => expect(bib.setBibliography).toHaveBeenCalledTimes(1));
    const [docId, record] = bib.setBibliography.mock.calls[0] as [number, { volume: string; title: string }];
    expect(docId).toBe(1);
    expect(record.volume).toBe('5');
    expect(record.title).toBe('On things');
    expect(api.setMetadata).not.toHaveBeenCalled();
    expect(bib.invalidate).toHaveBeenCalledWith(1);
    await waitFor(() => expect(useUi.getState().propsOpen).toBe(false));
  });

  it('writes both tabs when both changed', async () => {
    const { user } = setup(<Fixture />);
    await loaded();
    await user.type(screen.getByLabelText('Author'), 'Ann');
    await user.click(tab('Reference'));
    await user.type(screen.getByLabelText('Volume'), '5');
    await user.click(apply());
    await waitFor(() => expect(bib.setBibliography).toHaveBeenCalled());
    expect(api.setMetadata).toHaveBeenCalledWith(1, { author: 'Ann' });
  });

  it('shows read-only fields on a document that forbids edits', async () => {
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
    const { user } = setup(<Fixture />);
    await loaded();
    await user.click(tab('Reference'));
    const panel = screen.getByRole('tabpanel');
    expect(within(panel).getByText("This document can't be edited.")).toBeTruthy();
    expect(screen.getByLabelText('Title').hasAttribute('readonly')).toBe(true);
    expect(apply().getAttribute('aria-disabled')).toBe('true');
  });

  it('starts from an empty, editable record when nothing was found', async () => {
    bib.state = { info: { ...bibInfo, record: emptyBibRecord(), sources: {} }, loading: false };
    const { user } = setup(<Fixture />);
    await loaded();
    await user.click(tab('Reference'));
    expect(screen.getByText('Nothing found in the file. Fill in what you know.')).toBeTruthy();
    expect(screen.getByLabelText('Title').hasAttribute('readonly')).toBe(false);
  });
});
