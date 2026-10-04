// @vitest-environment jsdom
import { act, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import * as api from '../../../api/annotations';
import type { Annotation, ChangeSet } from '../../../api/annotations';
import { EMPTY_HISTORY, useAnnotations } from '../../../stores/annotations';
import { useSettings } from '../../../stores/settings';
import { useUi } from '../../../stores/ui';
import { setup } from '../../../test/render';
import { formatAnnotationDate, parseAnnotationDate } from './date';
import { FreeTextEditor, linesOf } from './FreeTextEditor';
import { NotePopover } from './NotePopover';

vi.mock('../../../api/annotations', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../api/annotations')>()),
  applyCommand: vi.fn(),
  undo: vi.fn(),
}));
const applyMock = vi.mocked(api.applyCommand);
const undoMock = vi.mocked(api.undo);

const annotationsInitial = useAnnotations.getState();
const settingsInitial = useSettings.getState();

function note(id: number, extra: Record<string, unknown> = {}): Annotation {
  return {
    id,
    pageId: 0,
    rect: { x: 0, y: 0, w: 24, h: 24 },
    color: [240, 228, 66],
    opacity: 1,
    contents: '',
    author: 'Ada',
    modified: '2026-10-03T12:00:00Z',
    inReplyTo: null,
    locked: false,
    sync: 'new',
    kind: 'note',
    at: { x: 5, y: 6 },
    icon: 'note',
    ...extra,
  } as Annotation;
}

function freeText(id: number, lines: string[]): Extract<Annotation, { kind: 'freeText' }> {
  return {
    ...note(id),
    kind: 'freeText',
    box: { x: 10, y: 20, w: 160, h: 36 },
    lines,
    fontSize: 12,
    fill: null,
    borderWidth: 0,
  } as unknown as Extract<Annotation, { kind: 'freeText' }>;
}

function load(annotations: Annotation[], undoLabel: string | null = null) {
  useAnnotations.setState({
    byDoc: {
      1: {
        rev: 1,
        byId: Object.fromEntries(annotations.map((a) => [a.id, a])),
        loaded: { 0: true },
        removed: {},
        history: { ...EMPTY_HISTORY, canUndo: undoLabel !== null, undoLabel },
      },
    },
  });
}

const changeSet = (upserted: Annotation[] = [], removed: number[] = []): ChangeSet => ({
  rev: 2,
  upserted,
  removed,
  pages: null,
  history: EMPTY_HISTORY,
});

beforeEach(() => {
  useAnnotations.setState({ ...annotationsInitial }, true);
  useSettings.setState({ ...settingsInitial, authorName: 'Ada' }, true);
  useUi.setState({ banner: null });
  applyMock.mockReset().mockResolvedValue(changeSet());
  undoMock.mockReset().mockResolvedValue(changeSet());
});

function Fixture({ isNew = false, onClose = () => undefined }: { isNew?: boolean; onClose?: () => void }) {
  return (
    <>
      <button type="button" data-testid="anchor">
        anchor
      </button>
      <NotePopover
        docId={1}
        noteId={1}
        anchor={document.querySelector<HTMLElement>('[data-testid="anchor"]')}
        open
        isNew={isNew}
        onClose={onClose}
      />
    </>
  );
}

function render(props: { isNew?: boolean; onClose?: () => void } = {}) {
  const view = setup(<Fixture {...props} />);
  // The anchor exists after the first render; render again so the popover can attach to it.
  view.rerender(<Fixture {...props} />);
  return view;
}

describe('annotation dates', () => {
  it('reads ISO and PDF dates and nothing else', () => {
    expect(parseAnnotationDate('2026-10-03T12:00:00Z')?.toISOString()).toBe('2026-10-03T12:00:00.000Z');
    expect(parseAnnotationDate("D:20261003120000+02'00'")?.toISOString()).toBe('2026-10-03T10:00:00.000Z');
    expect(parseAnnotationDate('D:2026')?.getUTCFullYear()).toBe(2026);
    expect(parseAnnotationDate('yesterday')).toBeNull();
    expect(parseAnnotationDate(null)).toBeNull();
    expect(formatAnnotationDate('garbage', 'en')).toBe('');
    expect(formatAnnotationDate('2026-10-03T12:00:00Z', 'en')).toContain('2026');
  });
});

describe('the note popover', () => {
  it('is a dialog named after the author, with the text and a reply field', () => {
    load([note(1, { contents: 'Check this' })]);
    render();
    const dialog = screen.getByRole('dialog', { name: 'Note by Ada' });
    expect(dialog).not.toBeNull();
    expect((screen.getByRole('textbox', { name: 'Note text' }) as HTMLTextAreaElement).value).toBe('Check this');
    expect(screen.getByRole('textbox', { name: 'Write a reply' })).not.toBeNull();
  });

  it('puts focus in the body of a new note', () => {
    load([note(1)]);
    render({ isNew: true });
    expect(document.activeElement).toBe(screen.getByRole('textbox', { name: 'Note text' }));
  });

  it('commits the body on blur as one update with a coalesce key', async () => {
    load([note(1)]);
    const { user } = render({ isNew: true });
    await user.type(screen.getByRole('textbox', { name: 'Note text' }), 'Hello');
    await user.tab();
    expect(applyMock).toHaveBeenCalledTimes(1);
    expect(applyMock).toHaveBeenCalledWith(1, {
      type: 'updateAnnotation',
      id: 1,
      patch: { contents: 'Hello' },
      coalesce: 'note.contents',
    });
  });

  it('closes on Esc and writes the text that was typed', async () => {
    load([note(1)]);
    const onClose = vi.fn();
    const { user } = render({ isNew: true, onClose });
    await user.type(screen.getByRole('textbox', { name: 'Note text' }), 'Kept');
    await user.keyboard('{Escape}');
    expect(onClose).toHaveBeenCalled();
    expect(applyMock).toHaveBeenCalledWith(
      1,
      expect.objectContaining({ type: 'updateAnnotation', patch: { contents: 'Kept' } }),
    );
    expect(undoMock).not.toHaveBeenCalled();
  });

  it('takes back a new note that is closed empty with Undo of its creation, so no step is left', async () => {
    load([note(1)], 'annotation.create');
    const { user } = render({ isNew: true });
    await user.keyboard('{Escape}');
    await waitFor(() => expect(undoMock).toHaveBeenCalledWith(1));
    expect(applyMock).not.toHaveBeenCalled();
  });

  it('deletes an empty new note when its creation is not the last step', async () => {
    load([note(1)], 'annotation.update');
    const { user } = render({ isNew: true });
    await user.keyboard('{Escape}');
    await waitFor(() => expect(applyMock).toHaveBeenCalledWith(1, { type: 'deleteAnnotations', ids: [1] }));
  });

  it('keeps an existing note that is closed empty', async () => {
    load([note(1)]);
    const { user } = render();
    await user.keyboard('{Escape}');
    expect(applyMock).not.toHaveBeenCalled();
    expect(undoMock).not.toHaveBeenCalled();
  });

  it('posts a reply with Enter as an /IRT note by the settings author; Shift+Enter is a newline', async () => {
    load([note(1, { contents: 'x' })]);
    const { user } = render();
    const field = screen.getByRole('textbox', { name: 'Write a reply' }) as HTMLTextAreaElement;
    await user.type(field, 'Agreed{Shift>}{Enter}{/Shift}more');
    expect(field.value).toBe('Agreed\nmore');
    expect(applyMock).not.toHaveBeenCalled();
    await user.keyboard('{Enter}');
    expect(applyMock).toHaveBeenCalledWith(1, {
      type: 'createAnnotation',
      draft: expect.objectContaining({
        kind: 'note',
        inReplyTo: 1,
        author: 'Ada',
        contents: 'Agreed\nmore',
        pageId: 0,
      }),
    });
    await waitFor(() => expect(field.value).toBe(''));
  });

  it('keeps the reply button aria-disabled while the reply is empty', async () => {
    load([note(1)]);
    const { user } = render();
    const button = screen.getByRole('button', { name: 'Reply' });
    expect(button.getAttribute('aria-disabled')).toBe('true');
    await user.click(button);
    expect(applyMock).not.toHaveBeenCalled();
    await user.type(screen.getByRole('textbox', { name: 'Write a reply' }), 'ok');
    expect(button.getAttribute('aria-disabled')).toBeNull();
  });

  it('shows replies, editable only when they are the own', () => {
    load([
      note(1),
      note(2, { inReplyTo: 1, author: 'Bob', contents: 'from Bob' }),
      note(3, { inReplyTo: 1, author: 'Ada', contents: 'from me' }),
    ]);
    render();
    expect((screen.getByRole('textbox', { name: 'Reply by Bob' }) as HTMLTextAreaElement).readOnly).toBe(true);
    expect((screen.getByRole('textbox', { name: 'Reply by Ada' }) as HTMLTextAreaElement).readOnly).toBe(false);
  });

  it('renders file text as text, never as markup', () => {
    load([note(1, { author: '<img src=x onerror=alert(1)>', contents: '<b>bold</b>' })]);
    render();
    expect(document.querySelector('img')).toBeNull();
    expect(document.querySelector('b')).toBeNull();
  });

  it('deletes the note together with its replies', async () => {
    load([note(1), note(2, { inReplyTo: 1 })]);
    const onClose = vi.fn();
    const { user } = render({ onClose });
    await user.click(screen.getByRole('button', { name: 'Delete note' }));
    expect(applyMock).toHaveBeenCalledWith(1, { type: 'deleteAnnotations', ids: [1, 2] });
    expect(onClose).toHaveBeenCalled();
  });
});

describe('the free text editor', () => {
  const lines = (text: string) => linesOf(text);

  it('splits and joins lines', () => {
    expect(lines('')).toEqual([]);
    expect(lines('a\r\nb\nc')).toEqual(['a', 'b', 'c']);
  });

  function renderEditor(text: string[], isNew = false, onDone = vi.fn()) {
    const annotation = freeText(1, text);
    load([annotation], isNew ? 'annotation.create' : null);
    const view = setup(<FreeTextEditor docId={1} annotation={annotation} scale={2} isNew={isNew} onDone={onDone} />);
    return { ...view, onDone };
  }

  it('takes focus, sits over the box in screen pixels and scales the font', () => {
    renderEditor(['hello']);
    const field = screen.getByRole('textbox', { name: 'Edit text' }) as HTMLTextAreaElement;
    expect(document.activeElement).toBe(field);
    expect(field.value).toBe('hello');
    expect(field.style.left).toBe('20px');
    expect(field.style.top).toBe('40px');
    expect(field.style.width).toBe('320px');
    expect(field.style.fontSize).toBe('24px');
  });

  it('commits on Esc; Shift+Enter breaks the line', async () => {
    const { user, onDone } = renderEditor(['hello']);
    await user.keyboard('{Shift>}{Enter}{/Shift}world{Escape}');
    await waitFor(() => expect(onDone).toHaveBeenCalled());
    // Two lines need more than the 36 pt high box: the box grows downward in the same patch.
    const patch: unknown = expect.objectContaining({
      lines: ['hello', 'world'],
      box: expect.objectContaining({ w: 160 }),
    });
    expect(applyMock).toHaveBeenCalledWith(1, { type: 'updateAnnotation', id: 1, patch });
  });

  it('commits on Enter (DESIGN 3.5 B4)', async () => {
    const { user, onDone } = renderEditor(['hello']);
    await user.keyboard('!{Enter}');
    await waitFor(() => expect(onDone).toHaveBeenCalled());
    expect(applyMock).toHaveBeenCalledWith(1, { type: 'updateAnnotation', id: 1, patch: { lines: ['hello!'] } });
  });

  it('commits on blur (a click outside)', async () => {
    const { user, onDone } = renderEditor(['a']);
    await user.type(screen.getByRole('textbox', { name: 'Edit text' }), 'b');
    act(() => screen.getByRole('textbox', { name: 'Edit text' }).blur());
    await waitFor(() => expect(onDone).toHaveBeenCalled());
    expect(applyMock).toHaveBeenCalledWith(1, { type: 'updateAnnotation', id: 1, patch: { lines: ['ab'] } });
    void user;
  });

  it('writes nothing when the text did not change', async () => {
    const { user, onDone } = renderEditor(['same']);
    await user.keyboard('{Escape}');
    await waitFor(() => expect(onDone).toHaveBeenCalled());
    expect(applyMock).not.toHaveBeenCalled();
  });

  it('removes an annotation left empty; a new one by Undo of its creation', async () => {
    const { user, onDone } = renderEditor([], true);
    await user.keyboard('{Escape}');
    await waitFor(() => expect(onDone).toHaveBeenCalled());
    expect(undoMock).toHaveBeenCalledWith(1);
    expect(applyMock).not.toHaveBeenCalled();
  });

  it('deletes an existing text that was emptied', async () => {
    const { user, onDone } = renderEditor(['gone']);
    await user.clear(screen.getByRole('textbox', { name: 'Edit text' }));
    await user.keyboard('{Escape}');
    await waitFor(() => expect(onDone).toHaveBeenCalled());
    expect(applyMock).toHaveBeenCalledWith(1, { type: 'deleteAnnotations', ids: [1] });
  });
});
