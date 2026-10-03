// @vitest-environment jsdom
import { act, screen, waitFor } from '@testing-library/react';
import { MotionGlobalConfig } from 'motion/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { ChangeSet } from '../../api/annotations';
import type { DocMetadata } from '../../api/metadata';
import { useAnnotations } from '../../stores/annotations';
import { useDocuments } from '../../stores/documents';
import { useUi } from '../../stores/ui';
import { setup } from '../../test/render';
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

beforeEach(() => {
  useDocuments.setState({
    byId: { 1: { id: 1, pageCount: 3, displayName: 'a.pdf', kind: 'user' } },
    order: [1],
    activeId: 1,
  });
  useAnnotations.setState({ byDoc: {} });
  useUi.setState({ propsOpen: true, toast: null, banner: null });
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
