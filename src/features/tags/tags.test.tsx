// @vitest-environment jsdom
import { act, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { Annotation, AnnotationSummary } from '../../api/annotations';
import { DEFAULT_SETTINGS, type Settings } from '../../api/app';
import { TAG_PALETTE, type TagDef } from '../../api/cite';
import { useAnnotations } from '../../stores/annotations';
import { useDocuments } from '../../stores/documents';
import { useSettings } from '../../stores/settings';
import { useUi } from '../../stores/ui';
import { setup } from '../../test/render';
import { useComments } from '../comments/store';
import { createTag, currentTags, deleteTag, nextTagColor, recolorTag, renameTag, tagNameProblem } from './store';
import { TagChips } from './TagChips';
import { TagManager } from './TagManager';
import { TagPickerButton } from './TagPicker';

const updateSettings = vi.hoisted(() => vi.fn());
const listDocumentAnnotations = vi.hoisted(() => vi.fn());
vi.mock('../../api/app', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../api/app')>()),
  updateSettings,
}));
vi.mock('../../api/annotations', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../api/annotations')>()),
  listDocumentAnnotations,
}));

const [SOLAR, MINT] = TAG_PALETTE as [TagDef['color'], TagDef['color']];
let stored: Settings;
const apply = vi.fn();

const summary = (id: number, tags: string[]): AnnotationSummary => ({
  id,
  pageId: 0,
  kind: 'highlight',
  color: [255, 248, 77],
  contents: '',
  author: null,
  modified: null,
  inReplyTo: null,
  ...(tags.length > 0 ? { tags } : {}),
});

function seedTags(tags: TagDef[]) {
  stored = { ...stored, tags };
  useSettings.setState({ tags });
}

function seedAnnotation(id: number, tags: string[]) {
  const annotation = { id, pageId: 0, kind: 'highlight', tags } as unknown as Annotation;
  useAnnotations.setState({
    byDoc: {
      1: {
        rev: 1,
        byId: { [id]: annotation },
        loaded: {},
        removed: {},
        history: useAnnotations.getState().byDoc[1]?.history as never,
      },
    },
  });
}

beforeEach(() => {
  stored = { ...DEFAULT_SETTINGS };
  updateSettings.mockReset().mockImplementation((patch: Partial<Settings>) => {
    stored = { ...stored, ...patch };
    return Promise.resolve(stored);
  });
  listDocumentAnnotations.mockReset().mockResolvedValue([]);
  apply.mockReset().mockResolvedValue({});
  useSettings.setState({ ...DEFAULT_SETTINGS, tags: [] });
  useAnnotations.setState({ byDoc: {}, selectedIds: {}, apply });
  useComments.setState({ byDoc: {}, views: {}, editing: {} });
  useUi.setState({ toast: null, banner: null });
  useDocuments.setState({ byId: { 1: { id: 1, pageCount: 1, displayName: 'a.pdf' } }, order: [1], activeId: 1 });
});

afterEach(() => {
  useDocuments.setState({ byId: {}, order: [], activeId: null });
});

describe('tag names', () => {
  it('mirrors the Rust rules: 1 to 40 characters, unique ignoring case', () => {
    const tags: TagDef[] = [{ name: 'Method', color: SOLAR }];
    expect(tagNameProblem('', tags)).toBe('empty');
    expect(tagNameProblem('   ', tags)).toBe('empty');
    expect(tagNameProblem('x'.repeat(40), tags)).toBeNull();
    expect(tagNameProblem('x'.repeat(41), tags)).toBe('long');
    expect(tagNameProblem('methOD', tags)).toBe('duplicate');
    expect(tagNameProblem('method', tags, 'Method')).toBeNull();
    expect(tagNameProblem('a\nb', tags)).toBe('control');
  });

  it('takes the next palette colour in order', () => {
    expect(nextTagColor([])).toEqual(TAG_PALETTE[0]);
    const six = Array.from({ length: 6 }, (_, i) => ({ name: `t${i}`, color: SOLAR }));
    expect(nextTagColor(six)).toEqual(TAG_PALETTE[1]);
  });
});

describe('tag store', () => {
  it('creates, persists through update_settings and refuses a duplicate', async () => {
    expect(await createTag(' Method ')).toEqual({ ok: true, name: 'Method' });
    expect(updateSettings).toHaveBeenCalledWith({ tags: [{ name: 'Method', color: SOLAR }] });
    expect(currentTags()).toEqual([{ name: 'Method', color: SOLAR }]);
    expect(await createTag('METHOD')).toEqual({ ok: false, problem: 'duplicate' });
    expect(updateSettings).toHaveBeenCalledTimes(1);
  });

  it('stops at 64 tags', async () => {
    seedTags(Array.from({ length: 64 }, (_, i) => ({ name: `t${i}`, color: SOLAR })));
    expect(await createTag('one more')).toEqual({ ok: false, problem: 'limit' });
  });

  it('recolours', async () => {
    seedTags([{ name: 'A', color: SOLAR }]);
    expect((await recolorTag('A', MINT)).ok).toBe(true);
    expect(currentTags()[0]?.color).toEqual(MINT);
  });

  it('renames and rewrites the assignments of the open documents', async () => {
    seedTags([{ name: 'A', color: SOLAR }]);
    listDocumentAnnotations.mockResolvedValue([summary(7, ['A', 'B']), summary(8, [])]);
    expect(await renameTag('A', 'Alpha')).toEqual({ ok: true, name: 'Alpha' });
    expect(currentTags()[0]?.name).toBe('Alpha');
    expect(apply).toHaveBeenCalledWith(1, { type: 'updateAnnotation', id: 7, patch: { tags: ['B', 'Alpha'] } });
  });

  it('refuses a rename to a taken name', async () => {
    seedTags([
      { name: 'A', color: SOLAR },
      { name: 'B', color: MINT },
    ]);
    expect(await renameTag('A', 'b')).toEqual({ ok: false, problem: 'duplicate' });
  });

  it('deletes, takes the name off the annotations and Undo restores both', async () => {
    seedTags([
      { name: 'A', color: SOLAR },
      { name: 'B', color: MINT },
    ]);
    listDocumentAnnotations.mockResolvedValue([summary(7, ['A', 'B'])]);
    expect(await deleteTag('A')).toBe(true);
    expect(currentTags().map((t) => t.name)).toEqual(['B']);
    expect(apply).toHaveBeenCalledWith(1, { type: 'updateAnnotation', id: 7, patch: { tags: ['B'] } });
    const toast = useUi.getState().toast;
    expect(toast?.message).toBe('Tag “A” deleted');
    listDocumentAnnotations.mockResolvedValue([summary(7, ['B'])]);
    act(() => toast?.action?.run());
    await waitFor(() => expect(currentTags().map((t) => t.name)).toEqual(['A', 'B']));
    await waitFor(() =>
      expect(apply).toHaveBeenLastCalledWith(1, { type: 'updateAnnotation', id: 7, patch: { tags: ['B', 'A'] } }),
    );
  });
});

describe('TagChips', () => {
  it('shows a chip per tag, three at most, then +n with the rest in the tooltip', () => {
    seedTags([{ name: 'A', color: SOLAR }]);
    setup(<TagChips names={['A', 'B', 'C', 'D', 'E']} />);
    expect(screen.getAllByRole('listitem')).toHaveLength(4);
    const more = screen.getByText('+2');
    expect(more.getAttribute('title')).toBe('D, E');
  });

  it('shows an unknown name with a neutral dot and nothing for no names', () => {
    const { container } = setup(<TagChips names={['Ghost']} />);
    expect(screen.getByText('Ghost')).toBeTruthy();
    expect(container.querySelector('.bg-subtle')).not.toBeNull();
    const none = setup(<TagChips names={[]} />);
    expect(none.container.innerHTML).toBe('');
  });
});

describe('TagPickerButton', () => {
  it('creates a tag from the input and assigns it', async () => {
    seedAnnotation(5, []);
    const { user } = setup(<TagPickerButton docId={1} annotIds={[5]} />);
    await user.click(screen.getByRole('button', { name: 'Tags' }));
    await user.type(screen.getByRole('textbox', { name: 'Find or create tag' }), 'Idea');
    await user.click(screen.getByRole('button', { name: 'Create “Idea”' }));
    await waitFor(() =>
      expect(apply).toHaveBeenCalledWith(1, { type: 'updateAnnotation', id: 5, patch: { tags: ['Idea'] } }),
    );
    expect(currentTags()[0]?.name).toBe('Idea');
  });

  it('toggles an existing tag on and off', async () => {
    seedTags([{ name: 'A', color: SOLAR }]);
    seedAnnotation(5, ['A']);
    const { user } = setup(<TagPickerButton docId={1} annotIds={[5]} />);
    await user.click(screen.getByRole('button', { name: 'Tags' }));
    const item = screen.getByRole('checkbox', { name: 'A' });
    expect(item.getAttribute('aria-checked')).toBe('true');
    await user.click(item);
    expect(apply).toHaveBeenCalledWith(1, { type: 'updateAnnotation', id: 5, patch: { tags: [] } });
  });

  it('does not add a ninth tag', async () => {
    const names = Array.from({ length: 8 }, (_, i) => `t${i}`);
    seedTags([...names, 'extra'].map((name) => ({ name, color: SOLAR })));
    seedAnnotation(5, names);
    const { user } = setup(<TagPickerButton docId={1} annotIds={[5]} />);
    await user.click(screen.getByRole('button', { name: 'Tags' }));
    const item = screen.getByRole('checkbox', { name: 'extra' });
    expect(item.getAttribute('aria-disabled')).toBe('true');
    await user.click(item);
    expect(apply).not.toHaveBeenCalled();
  });

  it('is disabled on a read-only document', async () => {
    useDocuments.setState({
      byId: { 1: { id: 1, pageCount: 1, displayName: 'a.pdf', kind: 'welcome' } },
    });
    const { user } = setup(<TagPickerButton docId={1} annotIds={[5]} />);
    const button = screen.getByRole('button', { name: 'Tags' });
    expect(button.getAttribute('aria-disabled')).toBe('true');
    await user.click(button);
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('opens the manager in the same popover', async () => {
    seedTags([{ name: 'A', color: SOLAR }]);
    seedAnnotation(5, []);
    const { user } = setup(<TagPickerButton docId={1} annotIds={[5]} />);
    await user.click(screen.getByRole('button', { name: 'Tags' }));
    await user.click(screen.getByRole('button', { name: 'Manage tags…' }));
    expect(screen.getByRole('heading', { name: 'Tags' })).toBeTruthy();
    expect(screen.getAllByRole('dialog')).toHaveLength(1);
  });
});

describe('TagManager', () => {
  it('says there are no tags and adds one', async () => {
    const { user } = setup(<TagManager docId={1} />);
    expect(screen.getByText('No tags yet.')).toBeTruthy();
    await user.click(screen.getByRole('button', { name: 'New tag' }));
    await waitFor(() => expect(currentTags().map((t) => t.name)).toEqual(['New tag']));
    expect(await screen.findByRole('textbox', { name: 'Tag name' })).toBeTruthy();
  });

  it('renames on blur, reverts an empty name and says a duplicate', async () => {
    seedTags([
      { name: 'A', color: SOLAR },
      { name: 'B', color: MINT },
    ]);
    const { user } = setup(<TagManager docId={1} />);
    const [first] = screen.getAllByRole('textbox', { name: 'Tag name' }) as [HTMLInputElement];
    await user.clear(first);
    await user.tab();
    expect(updateSettings).not.toHaveBeenCalled();
    expect(first.value).toBe('A');
    await user.clear(first);
    await user.type(first, 'Alpha');
    await user.tab();
    await waitFor(() => expect(currentTags()[0]?.name).toBe('Alpha'));
  });

  it('recolours from the colour menu', async () => {
    seedTags([{ name: 'A', color: SOLAR }]);
    const { user } = setup(<TagManager docId={1} />);
    await user.click(screen.getByRole('button', { name: 'Colour: A' }));
    await user.click(await screen.findByRole('menuitemradio', { name: 'Mint' }));
    await waitFor(() => expect(currentTags()[0]?.color).toEqual(MINT));
  });

  it('counts the usage and deletes with an Undo toast', async () => {
    seedTags([{ name: 'A', color: SOLAR }]);
    useComments.setState({
      byDoc: { 1: { status: 'ready', token: 1, summaries: [summary(1, ['A']), summary(2, ['a'])], threads: [] } },
    });
    const { user } = setup(<TagManager docId={1} />);
    expect(screen.getByLabelText('2')).toBeTruthy();
    await user.click(screen.getByRole('button', { name: 'Delete tag: A' }));
    await waitFor(() => expect(currentTags()).toEqual([]));
    const toast = useUi.getState().toast;
    expect(toast?.action?.label).toBe('Undo');
    act(() => toast?.action?.run());
    await waitFor(() => expect(currentTags().map((t) => t.name)).toEqual(['A']));
    expect(within(document.body).queryByText('A')).toBeNull();
  });
});
