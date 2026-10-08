// @vitest-environment jsdom
import { act, screen, waitFor } from '@testing-library/react';
import { MotionGlobalConfig } from 'motion/react';
import { beforeEach, describe, expect, it } from 'vitest';

import { armStamp, useStamp } from '../annotations/stamps/store';
import { FIRST_CHOICE } from '../annotations/stamps/model';
import { useDocuments } from '../../stores/documents';
import { useUi } from '../../stores/ui';
import { setup } from '../../test/render';
import { useOcr } from '../ocr/store';
import { ToolInspector, useToolInspectorOpen } from './ToolInspectorPanel';
import { useToolInspector } from './toolInspector';

MotionGlobalConfig.skipAnimations = true;

const uiInitial = useUi.getState();

function Fixture() {
  const open = useToolInspectorOpen();
  return (
    <>
      <button type="button" data-testid="opener">
        tool item
      </button>
      <div data-testid="column" data-open={open}>
        <ToolInspector />
      </div>
    </>
  );
}

beforeEach(() => {
  useUi.setState({ ...uiInitial }, true);
  useDocuments.setState({ byId: {}, order: [], activeId: null });
  useStamp.setState({ choice: FIRST_CHOICE, recent: [], pickerOpen: false, keyboard: false, changing: null });
  useToolInspector.setState({ open: null });
  useOcr.setState({ dialog: null });
});

describe('the tool inspector', () => {
  it('is closed by default and takes no content', () => {
    setup(<Fixture />);
    expect(screen.queryByRole('complementary')).toBeNull();
    expect(screen.getByTestId('column').getAttribute('data-open')).toBe('false');
  });

  it('shows the stamp form without a footer when the stamp tool is armed', () => {
    setup(<Fixture />);
    act(() => armStamp());
    expect(useToolInspector.getState().open).toBe('stamp');
    expect(screen.getByRole('complementary', { name: 'Stamp' })).toBeTruthy();
    expect(screen.getByRole('radio', { name: 'DRAFT' })).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Apply' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Reset' })).toBeNull();
  });

  it('choosing a stamp closes the column and keeps the tool armed for placing', async () => {
    const { user } = setup(<Fixture />);
    act(() => armStamp());
    await user.click(screen.getByRole('radio', { name: 'APPROVED' }));
    expect(useToolInspector.getState().open).toBeNull();
    expect(useStamp.getState().pickerOpen).toBe(false);
    expect(useUi.getState().activeTool).toBe('stamp');
  });

  it('Esc and Close release the stamp tool and return focus to the tool item', async () => {
    const { user } = setup(<Fixture />);
    const opener = screen.getByTestId('opener');
    opener.focus();
    act(() => armStamp());
    await waitFor(() => expect(document.activeElement).not.toBe(opener));
    await user.keyboard('{Escape}');
    expect(useUi.getState().activeTool).toBe('select');
    expect(useStamp.getState().pickerOpen).toBe(false);
    expect(useToolInspector.getState().open).toBeNull();
    expect(document.activeElement).toBe(opener);

    act(() => armStamp());
    await user.click(screen.getByRole('button', { name: 'Close' }));
    expect(useUi.getState().activeTool).toBe('select');
  });

  it('one inspector at a time: opening another ends the first', () => {
    useDocuments.setState({ byId: { 1: { id: 1, pageCount: 1, displayName: 'a.pdf' } }, order: [1], activeId: 1 });
    setup(<Fixture />);
    act(() => armStamp());
    act(() => useOcr.getState().openDialog({ docId: 1, preselectSelected: false }));
    expect(useToolInspector.getState().open).toBe('ocr');
    expect(useStamp.getState().pickerOpen).toBe(false);
    expect(useUi.getState().activeTool).toBe('select');
  });

  it('history opens the column with the change list', () => {
    setup(<Fixture />);
    act(() => useToolInspector.getState().openToolInspector('history'));
    expect(screen.queryByRole('complementary')).not.toBeNull();
    expect(screen.getByTestId('column').getAttribute('data-open')).toBe('true');
  });
});
