// @vitest-environment jsdom
import { screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { resetNotices } from '../../components/notices';
import { setup } from '../../test/render';
import { FallbackNotice } from './FallbackNotice';
import { listChars } from './model';
import { TextEditBar } from './TextEditBar';
import { useTextEdit, type EditSession } from './store';

const actions = vi.hoisted(() => ({ commitEdit: vi.fn(), cancelEdit: vi.fn(), retryEdit: vi.fn() }));
vi.mock('./actions', () => actions);

function session(patch: Partial<EditSession> = {}): EditSession {
  return {
    docId: 1,
    pageId: 0,
    pageNumber: 1,
    line: {
      key: { rev: 0, line: 0 },
      text: 'Hello',
      box: { x: 0, y: 0, w: 10, h: 10 },
      paragraph: 0,
      justified: false,
      font: { name: 'Helvetica-Bold', size: 11, embedded: false },
      editable: { type: 'same' },
    },
    draft: 'Hello',
    status: 'editing',
    overflowPt: 0,
    fallback: null,
    ...patch,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  resetNotices();
  useTextEdit.getState().reset();
});
afterEach(() => useTextEdit.getState().reset());

describe('listChars', () => {
  it('lists up to five distinct characters, then the count', () => {
    expect(listChars(['a', 'b', 'a'])).toBe('a b');
    expect(listChars(['a', 'b', 'c', 'd', 'e'])).toBe('a b c d e');
    expect(listChars(['a', 'b', 'c', 'd', 'e', 'f', 'g'])).toBe('a b c d e …+2');
  });
});

describe('TextEditBar', () => {
  it('shows the size, applies and cancels', async () => {
    useTextEdit.setState({ session: session() });
    const { user } = setup(<TextEditBar />);
    expect(document.querySelector('[data-surface="textedit-bar"]')).not.toBeNull();
    expect(screen.getByText('11 pt')).toBeTruthy();
    await user.click(screen.getByRole('button', { name: 'Apply (Enter)' }));
    expect(actions.commitEdit).toHaveBeenCalledOnce();
    await user.click(screen.getByRole('button', { name: 'Cancel (Esc)' }));
    expect(actions.cancelEdit).toHaveBeenCalledOnce();
  });

  it('shows the overflow caption only when overflowing', () => {
    useTextEdit.setState({ session: session({ overflowPt: 12 }) });
    const { unmount } = setup(<TextEditBar />);
    expect(screen.getByText('12 pt too wide')).toBeTruthy();
    unmount();
    useTextEdit.setState({ session: session() });
    setup(<TextEditBar />);
    expect(screen.queryByText(/too wide/)).toBeNull();
  });

  it('shows busy with Apply disabled', () => {
    useTextEdit.setState({ session: session({ status: 'busy' }) });
    setup(<TextEditBar />);
    expect(screen.getByText('Applying…')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Apply (Enter)' }).getAttribute('aria-disabled')).toBe('true');
  });

  it('shows the error with Retry', async () => {
    useTextEdit.setState({ session: session({ status: 'error' }) });
    const { user } = setup(<TextEditBar />);
    expect(screen.getByRole('alert').textContent).toContain("Couldn't change the line.");
    await user.click(screen.getByRole('button', { name: 'Retry' }));
    expect(actions.retryEdit).toHaveBeenCalledOnce();
  });

  it('opens the font popover with the name as text and the substitute rows', async () => {
    useTextEdit.setState({ session: session({ fallback: { face: 'sans', chars: ['é', 'ü', 'é'] } }) });
    const { user } = setup(<TextEditBar />);
    await user.click(screen.getByRole('button', { name: 'Font' }));
    const popover = document.querySelector('[data-surface="textedit-font-popover"]');
    expect(popover?.textContent).toContain('Helvetica-Bold');
    expect(popover?.textContent).toContain('Not embedded');
    expect(popover?.textContent).toContain('Arimo');
    expect(popover?.textContent).toContain('2');
  });
});

describe('FallbackNotice', () => {
  it('shows the missing-glyph notice next to the Font button and hides on request', async () => {
    useTextEdit.setState({
      session: session({ fallback: { face: 'serif', chars: ['é'] } }),
      notice: { kind: 'missingGlyphs', font: 'X', face: 'serif', chars: ['é', 'ü'] },
    });
    const { user } = setup(
      <>
        <TextEditBar />
        <FallbackNotice />
      </>,
    );
    const notice = await screen.findByRole('region', { name: /./ });
    expect(notice.getAttribute('data-surface')).toBe('textedit-notice');
    expect(notice.textContent).toContain('é ü');
    expect(notice.textContent).toContain('Tinos');
    await user.click(screen.getByRole('button', { name: 'Dismiss tip' }));
    expect(useTextEdit.getState().notice).toBeNull();
    expect(document.querySelector('[data-surface="textedit-notice"]')).toBeNull();
  });
  it('shows after Apply, anchored to the closed box, and protects that rect', async () => {
    useTextEdit.setState({
      session: null,
      anchor: null,
      noticeAnchor: { x: 100, y: 200, w: 80, h: 14 },
      notice: { kind: 'notEmbedded', font: 'Helvetica-Bold', face: 'sans', chars: [] },
    });
    const { user } = setup(<FallbackNotice />);
    const notice = await screen.findByRole('region', { name: /./ });
    expect(notice.textContent).toContain('Arimo');
    const guard = document.querySelector<HTMLElement>('[data-protect="notice"]');
    expect(guard?.style.left).toBe('100px');
    expect(guard?.style.width).toBe('80px');
    await user.click(screen.getByRole('button', { name: 'Dismiss tip' }));
    expect(useTextEdit.getState().notice).toBeNull();
    expect(useTextEdit.getState().noticeAnchor).toBeNull();
    expect(document.querySelector('[data-surface="textedit-notice"]')).toBeNull();
  });
});
