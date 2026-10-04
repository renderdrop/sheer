// @vitest-environment jsdom
import { act, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { runAction } from '../../actions/dispatch';
import { ActionKeys } from '../../actions/keys';
import { actionOf } from '../../actions/registry';
import type { DocumentInfo } from '../../api/documents';
import { useSettings } from '../../stores/settings';
import { useDocuments } from '../../stores/documents';
import { resetDocuments } from '../../stores/documents.testutil';
import { useUi } from '../../stores/ui';
import { useView } from '../../stores/view';
import { setup } from '../../test/render';
import { useAboutDialog } from '../about/state';
import { useSettingsPopover } from '../settings/state';
import { useViewer } from '../viewer/useViewer';
import { ToolbarSlot } from './ToolbarSlot';

const uiInitial = useUi.getState();
const viewerInitial = useViewer.getState();
const settingsInitial = useSettings.getState();
const REPORT: DocumentInfo = { id: 1, pageCount: 10, displayName: 'Report.pdf' };

function reset() {
  useUi.setState({ ...uiInitial }, true);
  useViewer.setState({ ...viewerInitial }, true);
  resetDocuments();
  useView.setState({ byDoc: {} });
  useSettings.setState({ ...settingsInitial, platform: null, version: '1.2.3' }, true);
  useSettingsPopover.setState({ open: false });
  useAboutDialog.setState({ open: false });
}

beforeEach(reset);
afterEach(() => {
  vi.restoreAllMocks();
  reset();
});

function openDocument() {
  act(() => {
    useView.getState().open(REPORT.id, REPORT.pageCount);
    useDocuments.getState().add(REPORT);
  });
}

/** The toolbar as the shell mounts it, with the window's key handler, which the shell mounts beside it. */
function Toolbar({ hasDocument = true }: { hasDocument?: boolean }) {
  return (
    <>
      <ActionKeys />
      <ToolbarSlot
        platform="windows"
        hasDocument={hasDocument}
        leftPanelVisible
        inspectorVisible={false}
        trafficLightInset={false}
      />
    </>
  );
}

const toolbar = () => screen.getByRole('toolbar', { name: 'Tools' });
const tool = (name: string) => within(toolbar()).getByRole('button', { name });
const pressed = (name: string) => tool(name).getAttribute('aria-pressed');

describe('a click on a tool goes through the action registry', () => {
  beforeEach(openDocument);

  it('activates the tool, and a click on the active tool releases it back to Select', async () => {
    const { user } = setup(<Toolbar />);
    expect(pressed('Select')).toBe('true');
    await user.click(tool('Highlight'));
    expect(useUi.getState().activeTool).toBe('highlight');
    expect(pressed('Highlight')).toBe('true');
    await user.click(tool('Comment'));
    expect(useUi.getState().activeTool).toBe('note');
    expect(pressed('Highlight')).toBe('false');
    await user.click(tool('Comment'));
    expect(useUi.getState().activeTool).toBe('select');
    expect(pressed('Select')).toBe('true');
  });

  it('a click on Select with another tool active goes back to Select, and on Select itself changes nothing', async () => {
    const { user } = setup(<Toolbar />);
    await user.click(tool('Draw'));
    await user.click(tool('Select'));
    expect(useUi.getState()).toMatchObject({ activeTool: 'select', toolLocked: false });
    await user.click(tool('Select'));
    expect(useUi.getState()).toMatchObject({ activeTool: 'select', toolLocked: false });
  });

  it('a double click locks the tool, and a click on a locked tool releases it', async () => {
    const { user } = setup(<Toolbar />);
    await user.dblClick(tool('Draw'));
    expect(useUi.getState()).toMatchObject({ activeTool: 'draw', toolLocked: true });
    await user.click(tool('Draw'));
    expect(useUi.getState()).toMatchObject({ activeTool: 'select', toolLocked: false });
  });

  it('Shift+Enter locks the tool from the keyboard', async () => {
    const { user } = setup(<Toolbar />);
    tool('Highlight').focus();
    await user.keyboard('{Shift>}{Enter}{/Shift}');
    expect(useUi.getState()).toMatchObject({ activeTool: 'highlight', toolLocked: true });
  });

  it('runs the tool through runAction, so the registry answers whether it can run now', async () => {
    const run = vi.spyOn(actionOf('tool-highlight'), 'run');
    const { user } = setup(<Toolbar />);
    await user.click(tool('Highlight'));
    expect(run).toHaveBeenCalledTimes(1);
    // A click on the active tool releases it through Select's action.
    const select = vi.spyOn(actionOf('tool-select'), 'run');
    await user.click(tool('Highlight'));
    expect(select).toHaveBeenCalledTimes(1);
    expect(useUi.getState().activeTool).toBe('select');
  });

  it('does nothing when the registry says the tool cannot run now, whatever the button looked like when it was clicked', async () => {
    // The toolbar was drawn with a document, so the button is enabled; by the time of the click the registry says no.
    const { user } = setup(<Toolbar />);
    expect(tool('Highlight').getAttribute('aria-disabled')).toBeNull();
    vi.spyOn(actionOf('tool-highlight'), 'enabled').mockReturnValue(false);
    vi.spyOn(actionOf('tool-draw'), 'enabled').mockReturnValue(false);
    await user.click(tool('Highlight'));
    expect(useUi.getState().activeTool).toBe('select');
    await user.dblClick(tool('Draw'));
    expect(useUi.getState()).toMatchObject({ activeTool: 'select', toolLocked: false });
    tool('Highlight').focus();
    await user.keyboard('{Shift>}{Enter}{/Shift}');
    expect(useUi.getState()).toMatchObject({ activeTool: 'select', toolLocked: false });
  });

  it('does nothing without a document: the document closed after the toolbar was drawn', async () => {
    const { user } = setup(<Toolbar />);
    act(() => useDocuments.getState().remove(REPORT.id));
    await user.click(tool('Highlight'));
    await user.dblClick(tool('Comment'));
    expect(useUi.getState()).toMatchObject({ activeTool: 'select', toolLocked: false });
  });
});

describe('Settings and About, from the toolbar row', () => {
  it('the Settings command opens the popover under the toolbar, with focus on its first control, and Esc closes it', async () => {
    const { user } = setup(<Toolbar hasDocument={false} />);
    act(() => void runAction('settings'));
    const popover = await screen.findByRole('dialog', { name: 'Settings' });
    expect(popover.className).toContain('bg-panel border border-border-subtle shadow-floating');
    await waitFor(() =>
      expect(document.activeElement).toBe(
        within(within(popover).getByRole('radiogroup', { name: 'Theme' })).getByRole('radio', {
          name: 'System',
          checked: true,
        }),
      ),
    );
    await user.keyboard('{Escape}');
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
  });

  it('Ctrl+Comma opens it with focus anywhere, also without a document', async () => {
    setup(<Toolbar hasDocument={false} />);
    fireEvent.keyDown(window, { key: ',', code: 'Comma', ctrlKey: true });
    expect(await screen.findByRole('dialog', { name: 'Settings' })).not.toBeNull();
  });

  it('the About command opens the dialog; Esc closes it', async () => {
    const { user } = setup(<Toolbar hasDocument={false} />);
    act(() => void runAction('about'));
    const dialog = await screen.findByRole('dialog', { name: 'About Sheer' });
    expect(within(dialog).getByText('Version 1.2.3')).not.toBeNull();
    await user.keyboard('{Escape}');
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
  });

  it('while the dialog is open the shortcuts of the app are off: Ctrl+Comma does not open the popover over it', async () => {
    setup(<Toolbar hasDocument={false} />);
    act(() => useAboutDialog.getState().setOpen(true));
    const dialog = await screen.findByRole('dialog', { name: 'About Sheer' });
    fireEvent.keyDown(within(dialog).getByRole('button', { name: 'Close' }), { key: ',', ctrlKey: true });
    expect(useSettingsPopover.getState().open).toBe(false);
    expect(screen.getAllByRole('dialog')).toHaveLength(1);
  });

  it('the settings popover and the dialog take no room in the shell: they are portals, and the toolbar row is the only element here', () => {
    const { container } = setup(<Toolbar hasDocument={false} />);
    act(() => useSettingsPopover.getState().setOpen(true));
    expect(container.querySelector('[role="dialog"]')).toBeNull();
    expect(container.children).toHaveLength(1);
  });
});
