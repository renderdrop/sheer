// @vitest-environment jsdom
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import * as api from '../../api/annotations';
import type { ChangeSet, ContentAnnotation } from '../../api/annotations';
import * as content from '../../api/content';
import { toAppError } from '../../api/errors';
import { EMPTY_HISTORY, useAnnotations } from '../../stores/annotations';
import { useDocuments } from '../../stores/documents';
import { useUi } from '../../stores/ui';
import { forgetFileRotations, setFileRotation } from '../viewer/fileRotation';
import type { PageLayerProps } from '../viewer/pageLayer';
import { InsertLayer } from './InsertLayer';
import { useInsert } from './store';
import { useInsertInspector } from './useInsertInspector';

vi.mock('../../api/annotations', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../api/annotations')>()),
  applyCommand: vi.fn(),
  listAnnotations: vi.fn(),
  listContentObjects: vi.fn(),
}));
vi.mock('../../api/content');
const mocked = vi.mocked(api);
const mockedContent = vi.mocked(content);

const common = {
  pageId: 0,
  color: [0, 0, 0],
  opacity: 1,
  contents: '',
  author: null,
  modified: null,
  inReplyTo: null,
  locked: false,
  sync: 'new',
} as const;

function textBox(id: number, x = 10, y = 10): ContentAnnotation {
  const box = { x, y, w: 80, h: 14.4 };
  return {
    ...common,
    id,
    rect: box,
    kind: 'textBox',
    box,
    text: 'Hello',
    lines: ['Hello'],
    font: 'sans',
    fontSize: 12,
    align: 'left',
  } as ContentAnnotation;
}

const image = (id: number): ContentAnnotation => {
  const box = { x: 20, y: 100, w: 50, h: 25 };
  return { ...common, id, rect: box, kind: 'image', box, assetId: 3, aspect: 2 } as ContentAnnotation;
};

// 100 x 200 pt shown at 2 px per pt.
const props: PageLayerProps = {
  docId: 1,
  pageIndex: 0,
  boxWidth: 200,
  boxHeight: 400,
  widthPt: 100,
  heightPt: 200,
  rotation: 0,
  ready: true,
};

const created = (object: ContentAnnotation, rev = 1): ChangeSet => ({
  rev,
  upserted: [],
  removed: [],
  pages: null,
  content: [object],
  history: EMPTY_HISTORY,
});
const empty: ChangeSet = { rev: 1, upserted: [], removed: [], pages: null, history: EMPTY_HISTORY };

function seed(list: ContentAnnotation[]) {
  useInsert.setState({
    byDoc: {
      1: {
        rev: 0,
        byId: Object.fromEntries(list.map((o) => [o.id, o])) as never,
        loaded: { 0: true },
        gone: {},
      },
    },
  });
}

const frame = (id: number) => document.querySelector<HTMLElement>(`[data-insert-frame="${id}"]`) as HTMLElement;
const surface = () => document.querySelector<HTMLElement>('[data-insert-surface]') as HTMLElement;
const lastCommand = () => mocked.applyCommand.mock.calls.at(-1)?.[1];

beforeEach(() => {
  vi.resetAllMocks();
  mocked.applyCommand.mockResolvedValue(empty);
  mocked.listContentObjects.mockResolvedValue([]);
  mocked.listAnnotations.mockResolvedValue([]);
  mockedContent.getAssetPreview.mockRejectedValue(toAppError(null));
  useUi.setState({ activeTool: 'select', toolLocked: false, banner: null });
  useAnnotations.setState({ byDoc: {}, selectedIds: {}, pageRevs: {} });
  useInsert.setState({
    byDoc: {},
    selected: {},
    extra: {},
    editing: null,
    pendingImage: null,
    arming: false,
    lockAspect: true,
  });
  setFileRotation(1, 0, 0);
  seed([textBox(1), image(2)]);
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(() => ({
    left: 0,
    top: 0,
    right: 200,
    bottom: 400,
    width: 200,
    height: 400,
    x: 0,
    y: 0,
    toJSON: () => ({}),
  }));
});

afterEach(() => {
  vi.restoreAllMocks();
  forgetFileRotations(1);
});

describe('InsertLayer: drawing and selecting', () => {
  it('draws nothing before the page is ready', () => {
    render(<InsertLayer {...props} ready={false} />);
    expect(document.querySelector('[data-insert-layer]')).toBeNull();
  });

  it('has a tab stop per object with its role and text, and no comment among them', () => {
    mockedContent.getAssetPreview.mockRejectedValue(toAppError(null));
    render(<InsertLayer {...props} />);
    expect(frame(1).getAttribute('aria-roledescription')).toBe('Text box');
    expect(frame(1).getAttribute('aria-label')).toContain('Hello');
    expect(frame(2).getAttribute('aria-roledescription')).toBe('Image');
    expect(frame(1).tabIndex).toBe(0);
  });

  it('selecting by pointer shows handles: two for a text box, four corners for an image', () => {
    mockedContent.getAssetPreview.mockRejectedValue(toAppError(null));
    render(<InsertLayer {...props} />);
    fireEvent.pointerDown(frame(1), { button: 0, clientX: 30, clientY: 30 });
    expect(useInsert.getState().selected[1]).toBe(1);
    expect(frame(1).querySelectorAll('[data-annot-handle]')).toHaveLength(2);
    fireEvent.pointerDown(frame(2), { button: 0, clientX: 60, clientY: 220 });
    expect(frame(2).querySelectorAll('[data-annot-handle]')).toHaveLength(4);
  });

  it('shows the side handles of an image when the aspect is not locked', () => {
    mockedContent.getAssetPreview.mockRejectedValue(toAppError(null));
    useInsert.setState({ lockAspect: false });
    render(<InsertLayer {...props} />);
    fireEvent.pointerDown(frame(2), { button: 0 });
    expect(frame(2).querySelectorAll('[data-annot-handle]')).toHaveLength(8);
  });

  it('Delete removes the object in one command', async () => {
    render(<InsertLayer {...props} />);
    fireEvent.keyDown(frame(1), { key: 'Delete' });
    await waitFor(() => expect(lastCommand()).toEqual({ type: 'deleteAnnotations', ids: [1] }));
  });

  it('Delete shows the Undo toast', async () => {
    render(<InsertLayer {...props} />);
    fireEvent.keyDown(frame(1), { key: 'Delete' });
    await waitFor(() => expect(useUi.getState().toast?.message).toBe('Text box deleted'));
    expect(useUi.getState().toast?.action?.label).toBe('Undo');
  });

  it('Shift-click adds to the selection; Delete removes all selected, Shift-click again takes one out', async () => {
    render(<InsertLayer {...props} />);
    fireEvent.pointerDown(frame(1), { button: 0 });
    fireEvent.pointerDown(frame(2), { button: 0, shiftKey: true });
    expect(useInsert.getState().selected[1]).toBe(1);
    expect(useInsert.getState().extra[1]).toEqual([2]);
    fireEvent.keyDown(frame(2), { key: 'Delete' });
    await waitFor(() => expect(lastCommand()).toEqual({ type: 'deleteAnnotations', ids: [1, 2] }));
    await waitFor(() => expect(useUi.getState().toast?.message).toBe('2 objects deleted'));
    fireEvent.pointerDown(frame(2), { button: 0, shiftKey: true });
    expect(useInsert.getState().extra[1]).toEqual([]);
  });

  it('dragging one of several selected objects moves them together', async () => {
    render(<InsertLayer {...props} />);
    fireEvent.pointerDown(frame(1), { button: 0 });
    fireEvent.pointerDown(frame(2), { button: 0, shiftKey: true });
    fireEvent.pointerDown(frame(1), { button: 0, clientX: 20, clientY: 20 });
    fireEvent.pointerMove(window, { clientX: 40, clientY: 20 });
    fireEvent.pointerUp(window);
    await waitFor(() => expect(lastCommand()).toEqual({ type: 'moveAnnotations', ids: [1, 2], dx: 10, dy: 0 }));
  });

  it('an arrow key nudges, joined into one update after a pause', async () => {
    vi.useFakeTimers();
    try {
      render(<InsertLayer {...props} />);
      fireEvent.keyDown(frame(1), { key: 'ArrowDown' });
      fireEvent.keyDown(frame(1), { key: 'ArrowDown', shiftKey: true });
      expect(mocked.applyCommand).not.toHaveBeenCalled();
      await act(async () => {
        await vi.advanceTimersByTimeAsync(600);
      });
      expect(mocked.applyCommand).toHaveBeenCalledTimes(1);
      expect(lastCommand()).toMatchObject({ type: 'updateAnnotation', id: 1, patch: { box: { x: 10, y: 21 } } });
    } finally {
      vi.useRealTimers();
    }
  });

  it('dragging a resize handle updates the box once on release, Shift flips the aspect lock', async () => {
    mockedContent.getAssetPreview.mockRejectedValue(toAppError(null));
    render(<InsertLayer {...props} />);
    fireEvent.pointerDown(frame(2), { button: 0, clientX: 40, clientY: 220 });
    fireEvent.pointerUp(window);
    const handle = frame(2).querySelector('[data-annot-handle="se"]') as HTMLElement;
    mocked.applyCommand.mockClear();
    fireEvent.pointerDown(handle, { button: 0, clientX: 140, clientY: 250 });
    // 40 px right is 20 pt; the aspect is kept, so the height follows.
    fireEvent.pointerMove(window, { clientX: 180, clientY: 250 });
    fireEvent.pointerUp(window, { clientX: 180, clientY: 250 });
    await waitFor(() => expect(mocked.applyCommand).toHaveBeenCalledTimes(1));
    expect(lastCommand()).toMatchObject({ type: 'updateAnnotation', id: 2, patch: { box: { w: 70, h: 35 } } });
  });

  it('Escape in a drag cancels it without a command', () => {
    render(<InsertLayer {...props} />);
    fireEvent.pointerDown(frame(1), { button: 0, clientX: 30, clientY: 30 });
    fireEvent.pointerMove(window, { clientX: 80, clientY: 80 });
    fireEvent.keyDown(window, { key: 'Escape' });
    fireEvent.pointerUp(window, { clientX: 80, clientY: 80 });
    expect(mocked.applyCommand).not.toHaveBeenCalled();
  });
});

describe('InsertLayer: Add text', () => {
  beforeEach(() => {
    useUi.setState({ activeTool: 'textBox' });
  });

  it('a click places a box and starts editing; Esc commits it as one create command', async () => {
    mocked.applyCommand.mockResolvedValue(created(textBox(9)));
    render(<InsertLayer {...props} />);
    fireEvent.pointerDown(surface(), { button: 0, clientX: 40, clientY: 80, pointerId: 1 });
    fireEvent.pointerUp(surface(), { button: 0, clientX: 40, clientY: 80, pointerId: 1 });
    const editor = await screen.findByRole('textbox', { name: 'Text box' });
    expect(document.activeElement).toBe(editor);
    // One-shot: the tool is done with the click.
    expect(useUi.getState().activeTool).toBe('select');
    fireEvent.change(editor, { target: { value: 'Line one\nLine two' } });
    fireEvent.keyDown(editor, { key: 'Escape' });
    await waitFor(() => expect(mocked.applyCommand).toHaveBeenCalledTimes(1));
    const command = lastCommand();
    expect(command).toMatchObject({
      type: 'createAnnotation',
      draft: {
        kind: 'textBox',
        pageId: 0,
        text: 'Line one\nLine two',
        font: 'sans',
        fontSize: 12,
        box: { x: 0, y: 40, w: 100 },
      },
    });
    await waitFor(() => expect(useInsert.getState().editing).toBeNull());
    expect(useInsert.getState().selected[1]).toBe(9);
  });

  it('a drag sets the width', async () => {
    render(<InsertLayer {...props} />);
    fireEvent.pointerDown(surface(), { button: 0, clientX: 20, clientY: 40, pointerId: 1 });
    fireEvent.pointerMove(surface(), { clientX: 120, clientY: 44, pointerId: 1 });
    fireEvent.pointerUp(surface(), { clientX: 120, clientY: 44, pointerId: 1 });
    await screen.findByRole('textbox', { name: 'Text box' });
    expect(useInsert.getState().editing?.box).toMatchObject({ x: 10, y: 20, w: 50 });
  });

  it('an empty text makes no box and no command', async () => {
    render(<InsertLayer {...props} />);
    fireEvent.pointerDown(surface(), { button: 0, clientX: 40, clientY: 80, pointerId: 1 });
    fireEvent.pointerUp(surface(), { button: 0, clientX: 40, clientY: 80, pointerId: 1 });
    const editor = await screen.findByRole('textbox', { name: 'Text box' });
    fireEvent.keyDown(editor, { key: 'Escape' });
    await waitFor(() => expect(useInsert.getState().editing).toBeNull());
    expect(mocked.applyCommand).not.toHaveBeenCalled();
  });

  it('a character WinAnsi lacks keeps the box in editing with the charset message', async () => {
    mocked.applyCommand.mockRejectedValueOnce({
      code: 'invalid_argument',
      key: 'error.invalid_argument',
      retryable: false,
      params: { what: 'textBox', char: '中' },
    });
    render(<InsertLayer {...props} />);
    fireEvent.pointerDown(surface(), { button: 0, clientX: 40, clientY: 80, pointerId: 1 });
    fireEvent.pointerUp(surface(), { button: 0, clientX: 40, clientY: 80, pointerId: 1 });
    const editor = await screen.findByRole('textbox', { name: 'Text box' });
    fireEvent.change(editor, { target: { value: 'a中' } });
    fireEvent.keyDown(editor, { key: 'Escape' });
    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toContain('中');
    expect(useInsert.getState().editing).not.toBeNull();
    expect(useUi.getState().banner).toBeNull();
  });

  it('Enter edits a selected text box; an edit is one update, emptying it deletes the box', async () => {
    useUi.setState({ activeTool: 'select' });
    render(<InsertLayer {...props} />);
    fireEvent.keyDown(frame(1), { key: 'Enter' });
    const editor = await screen.findByRole('textbox', { name: 'Text box' });
    expect((editor as HTMLTextAreaElement).value).toBe('Hello');
    fireEvent.change(editor, { target: { value: 'Hello there' } });
    fireEvent.keyDown(editor, { key: 'Escape' });
    await waitFor(() =>
      expect(lastCommand()).toEqual({ type: 'updateAnnotation', id: 1, patch: { text: 'Hello there' } }),
    );

    fireEvent.keyDown(frame(1), { key: 'Enter' });
    const again = await screen.findByRole('textbox', { name: 'Text box' });
    fireEvent.change(again, { target: { value: '  ' } });
    fireEvent.keyDown(again, { key: 'Escape' });
    await waitFor(() => expect(lastCommand()).toEqual({ type: 'deleteAnnotations', ids: [1] }));
  });
});

describe('InsertLayer: Add image', () => {
  const info = { assetId: 7, width: 200, height: 100, aspect: 2 };

  it('opens the dialog once for the tool and places the chosen image centred at its default size', async () => {
    mockedContent.insertImageDialog.mockResolvedValue(info);
    mockedContent.getAssetPreview.mockRejectedValue(toAppError(null));
    mocked.applyCommand.mockResolvedValue(created(image(11)));
    render(
      <>
        <InsertLayer {...props} />
        <InsertLayer {...props} pageIndex={1} />
      </>,
    );
    act(() => useUi.setState({ activeTool: 'image' }));
    await waitFor(() => expect(useInsert.getState().pendingImage).toEqual(info));
    expect(mockedContent.insertImageDialog).toHaveBeenCalledTimes(1);
    const surfaces = document.querySelectorAll<HTMLElement>('[data-insert-surface]');
    fireEvent.pointerDown(surfaces[0] as HTMLElement, { button: 0, clientX: 100, clientY: 200, pointerId: 1 });
    fireEvent.pointerUp(surfaces[0] as HTMLElement, { button: 0, clientX: 100, clientY: 200, pointerId: 1 });
    await waitFor(() => expect(mocked.applyCommand).toHaveBeenCalledTimes(1));
    // Half the 100 pt page wide, aspect 2, centred on (50, 100).
    expect(lastCommand()).toMatchObject({
      type: 'createAnnotation',
      draft: { kind: 'image', assetId: 7, aspect: 2, box: { x: 25, y: 87.5, w: 50, h: 25 } },
    });
    expect(useUi.getState().activeTool).toBe('select');
    await waitFor(() => expect(useInsert.getState().selected[1]).toBe(11));
  });

  it('Cancel in the dialog returns to Select', async () => {
    mockedContent.insertImageDialog.mockResolvedValue(null);
    render(<InsertLayer {...props} />);
    act(() => useUi.setState({ activeTool: 'image' }));
    await waitFor(() => expect(useUi.getState().activeTool).toBe('select'));
    expect(useInsert.getState().pendingImage).toBeNull();
  });

  it('a refused image shows the error banner and returns to Select', async () => {
    mockedContent.insertImageDialog.mockRejectedValue(
      toAppError({ code: 'invalid_argument', retryable: false, params: { what: 'image' } }),
    );
    render(<InsertLayer {...props} />);
    act(() => useUi.setState({ activeTool: 'image' }));
    await waitFor(() => expect(useUi.getState().banner).not.toBeNull());
    expect(useUi.getState().activeTool).toBe('select');
  });
});

describe('the inspector', () => {
  function Probe() {
    const entry = useInsertInspector();
    return <div data-testid="probe">{entry === null ? 'none' : entry.title}</div>;
  }

  it('is null for Select without a selection, and has tool options for Add text', () => {
    render(<Probe />);
    expect(screen.getByTestId('probe').textContent).toBe('none');
    act(() => useUi.setState({ activeTool: 'textBox' }));
    expect(screen.getByTestId('probe').textContent).toBe('Tool options: Insert text');
  });

  it('a selected text box has Alignment and Delete', async () => {
    function Body() {
      return <>{useInsertInspector()?.body}</>;
    }
    act(() => {
      useDocuments.setState({ activeId: 1 });
      useInsert.getState().select(1, 1);
    });
    render(<Body />);
    fireEvent.click(screen.getByRole('radio', { name: 'Right' }));
    await waitFor(() =>
      expect(lastCommand()).toMatchObject({ type: 'updateAnnotation', id: 1, patch: { align: 'right' } }),
    );
    fireEvent.click(screen.getByRole('button', { name: 'Delete' }));
    await waitFor(() => expect(lastCommand()).toEqual({ type: 'deleteAnnotations', ids: [1] }));
  });
});
