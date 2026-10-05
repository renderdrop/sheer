// @vitest-environment jsdom
import { act, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  clearSignatureLibrary,
  deleteSignature,
  listSignatures,
  renameSignature,
  type LibraryItem,
  type SignatureLibrary,
} from '../../../api/library';
import { setup } from '../../../test/render';
import { SignatureLibraryDialog } from './SignatureLibraryDialog';
import { pathData } from './SignaturePreview';
import { UNDO_MS, closeSignatureLibrary, openSignatureLibrary, setLibraryHandlers, useSignatureLibrary } from './state';

vi.mock('../../../api/library', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../api/library')>()),
  listSignatures: vi.fn(),
  renameSignature: vi.fn(() => Promise.resolve()),
  deleteSignature: vi.fn(() => Promise.resolve()),
  clearSignatureLibrary: vi.fn(() => Promise.resolve()),
}));

const list = vi.mocked(listSignatures);
const initial = useSignatureLibrary.getState();

function item(
  n: number,
  role: 'signature' | 'initials' = 'signature',
  kind: 'vector' | 'raster' = 'vector',
): LibraryItem {
  return {
    id: n.toString(16).padStart(32, '0'),
    role,
    name: `Name ${n}`,
    created: 1_700_000_000,
    aspect: 3,
    kind,
    preview:
      kind === 'vector'
        ? {
            vector: {
              w: 30,
              h: 10,
              paths: [[['M', 0, 0], ['L', 10, 0], ['L', 10, 10], ['Z']]],
            },
          }
        : null,
  };
}

function answer(value: SignatureLibrary): void {
  list.mockResolvedValue(value);
}

beforeEach(() => {
  useSignatureLibrary.setState({ ...initial, open: false, items: [], deleted: new Set<string>(), handlers: {} }, true);
  list.mockReset();
  vi.mocked(renameSignature).mockClear();
  vi.mocked(deleteSignature).mockClear();
  vi.mocked(clearSignatureLibrary).mockClear();
});

afterEach(() => {
  vi.useRealTimers();
  act(() => closeSignatureLibrary());
});

function Fixture() {
  return (
    <>
      <div id="root">
        <button type="button">elsewhere</button>
      </div>
      <SignatureLibraryDialog />
    </>
  );
}

const dialog = () => screen.getByRole('dialog', { name: 'Signatures' });

async function openWith(value: SignatureLibrary) {
  answer(value);
  const view = setup(<Fixture />);
  act(() => openSignatureLibrary());
  await waitFor(() => expect(useSignatureLibrary.getState().loaded).toBe(true));
  return view;
}

describe('pathData', () => {
  it('writes one closed path per polygon and skips degenerate ones', () => {
    expect(pathData([[['M', 0, 0], ['L', 4, 0], ['L', 4, 2], ['Z']]])).toBe('M0 0L4 0L4 2Z');
  });
});

describe('the signature library', () => {
  it('shows the empty state with the stored-on-device note', async () => {
    await openWith({ status: 'ready', items: [] });
    expect(within(dialog()).getByText('No saved signatures')).not.toBeNull();
    expect(within(dialog()).getByText('Stored encrypted on this device.')).not.toBeNull();
  });

  it('marks the scrolling list as a list and keeps the buttons outside it (Q7)', async () => {
    await openWith({ status: 'ready', items: [item(1), item(2)] });
    const list = dialog().querySelector('[data-scroll="list"]');
    expect(list).not.toBeNull();
    expect(list?.contains(within(dialog()).getByRole('button', { name: 'Close' }))).toBe(false);
  });

  it('the list element clips its rows with its own overflow (Q7)', async () => {
    await openWith({ status: 'ready', items: [item(1), item(2)] });
    const list = dialog().querySelector('[data-scroll="list"]');
    expect(list?.className).toContain('overflow-y-auto');
    expect(list?.className).toContain('max-h-lib-list');
  });

  it('lists entries per kind with a vector preview and a placeholder for raster art', async () => {
    await openWith({
      status: 'ready',
      items: [item(1), item(2, 'signature', 'raster'), item(3, 'initials')],
    });
    expect(within(dialog()).getByRole('heading', { name: 'Initials' })).not.toBeNull();
    expect(dialog().querySelectorAll('[data-lib-row]')).toHaveLength(3);
    expect(dialog().querySelectorAll('svg[viewBox="0 0 30 10"] path')).toHaveLength(2);
    expect(within(dialog()).getByRole('img', { name: 'No preview for images yet' })).not.toBeNull();
  });

  it('says the library is full at 8 entries of a kind', async () => {
    await openWith({ status: 'ready', items: Array.from({ length: 8 }, (_, i) => item(i + 1)) });
    expect(within(dialog()).getByText('Library full (8)')).not.toBeNull();
  });

  it('renames in place on Enter and keeps the old name on Esc', async () => {
    const { user } = await openWith({ status: 'ready', items: [item(1)] });
    await user.click(within(dialog()).getByRole('button', { name: 'Rename' }));
    const field = within(dialog()).getByRole('textbox', { name: 'Name' });
    await user.clear(field);
    await user.type(field, 'My sign{Enter}');
    expect(renameSignature).toHaveBeenCalledWith(item(1).id, 'My sign');
    await waitFor(() => expect(within(dialog()).getByText('My sign')).not.toBeNull());

    await user.click(within(dialog()).getByRole('button', { name: 'Rename' }));
    await user.type(within(dialog()).getByRole('textbox', { name: 'Name' }), 'zzz{Escape}');
    expect(renameSignature).toHaveBeenCalledTimes(1);
    expect(within(dialog()).getByText('My sign')).not.toBeNull();
  });

  it('deletes with an inline Undo and sends the delete when the window ends', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const { user } = await openWith({ status: 'ready', items: [item(1), item(2)] });
    await user.click(within(dialog()).getAllByRole('button', { name: 'Delete' })[0] as HTMLElement);
    expect(within(dialog()).getByRole('status').textContent).toBe('Name 1 deleted');
    expect(deleteSignature).not.toHaveBeenCalled();
    await user.click(within(dialog()).getByRole('button', { name: 'Undo' }));
    expect(within(dialog()).queryByText('Name 1 deleted')).toBeNull();

    await user.click(within(dialog()).getAllByRole('button', { name: 'Delete' })[0] as HTMLElement);
    act(() => {
      vi.advanceTimersByTime(UNDO_MS + 10);
    });
    expect(deleteSignature).toHaveBeenCalledWith(item(1).id);
  });

  it('commits a pending delete when the dialog closes', async () => {
    const { user } = await openWith({ status: 'ready', items: [item(1)] });
    await user.click(within(dialog()).getByRole('button', { name: 'Delete' }));
    act(() => closeSignatureLibrary());
    expect(deleteSignature).toHaveBeenCalledWith(item(1).id);
  });

  it('asks before forgetting everything', async () => {
    const { user } = await openWith({ status: 'ready', items: [item(1)] });
    await user.click(within(dialog()).getByRole('button', { name: 'Forget all' }));
    expect(clearSignatureLibrary).not.toHaveBeenCalled();
    await user.click(within(dialog()).getByRole('button', { name: 'Cancel' }));
    expect(clearSignatureLibrary).not.toHaveBeenCalled();
    await user.click(within(dialog()).getByRole('button', { name: 'Forget all' }));
    await user.click(within(dialog()).getByRole('button', { name: 'Remove all' }));
    expect(clearSignatureLibrary).toHaveBeenCalledTimes(1);
  });

  it('warns that entries are session only without a keychain, and drops the encrypted note', async () => {
    await openWith({ status: 'unavailable', items: [item(1)] });
    expect(within(dialog()).getByText(/keychain isn't available/)).not.toBeNull();
    expect(within(dialog()).getByText('This session only')).not.toBeNull();
    expect(within(dialog()).queryByText('Stored encrypted on this device.')).toBeNull();
  });

  it('offers the way out of a locked library after a confirm', async () => {
    const { user } = await openWith({ status: 'locked', items: [] });
    expect(within(dialog()).getByText("Some saved signatures can't be unlocked.")).not.toBeNull();
    await user.click(within(dialog()).getByRole('button', { name: 'Remove them' }));
    await user.click(within(dialog()).getByRole('button', { name: 'Remove all' }));
    expect(clearSignatureLibrary).toHaveBeenCalledTimes(1);
  });

  it('moves between rows with the arrows and deletes with the Delete key', async () => {
    await openWith({ status: 'ready', items: [item(1), item(2)] });
    const rows = () => Array.from(dialog().querySelectorAll<HTMLElement>('[data-lib-row]'));
    act(() => rows()[0]?.focus());
    fireEvent.keyDown(rows()[0] as HTMLElement, { key: 'ArrowDown' });
    expect(document.activeElement).toBe(rows()[1]);
    fireEvent.keyDown(rows()[1] as HTMLElement, { key: 'Delete' });
    expect(within(dialog()).getByRole('status').textContent).toBe('Name 2 deleted');
  });

  it('places on Enter only when a placer is registered, closing first', async () => {
    await openWith({ status: 'ready', items: [item(1)] });
    const row = () => dialog().querySelector<HTMLElement>('[data-lib-row]') as HTMLElement;
    fireEvent.keyDown(row(), { key: 'Enter' });
    expect(useSignatureLibrary.getState().open).toBe(true);
    const place = vi.fn();
    act(() => setLibraryHandlers({ place }));
    fireEvent.keyDown(row(), { key: 'Enter' });
    expect(place).toHaveBeenCalledWith(item(1));
    expect(useSignatureLibrary.getState().open).toBe(false);
  });

  it('shows Add buttons only with a create handler', async () => {
    await openWith({ status: 'ready', items: [item(1)] });
    expect(within(dialog()).queryByRole('button', { name: 'Add signature…' })).toBeNull();
    const create = vi.fn();
    act(() => setLibraryHandlers({ create }));
    fireEvent.click(await within(dialog()).findByRole('button', { name: 'Add initials…' }));
    expect(create).toHaveBeenCalledWith('initials');
  });

  it('closes on Esc', async () => {
    await openWith({ status: 'ready', items: [] });
    fireEvent.keyDown(document.body, { key: 'Escape' });
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
  });
});
