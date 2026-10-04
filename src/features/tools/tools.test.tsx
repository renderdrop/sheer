// @vitest-environment jsdom
import { act, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { useDocuments } from '../../stores/documents';
import { resetDocuments } from '../../stores/documents.testutil';
import { useTools } from '../../stores/tools';
import { useUi } from '../../stores/ui';
import { setup } from '../../test/render';
import { ToolRail, ToolSidebar } from './ToolSidebar';
import { rowOfState } from './rows';

const uiInitial = useUi.getState();

beforeEach(() => {
  useUi.setState({ ...uiInitial }, true);
  resetDocuments();
  act(() => useDocuments.getState().add({ id: 1, pageCount: 3, displayName: 'a.pdf' }));
});

afterEach(() => {
  useUi.setState({ ...uiInitial }, true);
  resetDocuments();
});

const row = (id: string) => document.querySelector<HTMLElement>(`[data-toolbar-item="${id}"]`) as HTMLElement;

describe('rowOfState', () => {
  it('maps tools and the redact mode to their row', () => {
    expect(rowOfState('select', false)).toBe('select');
    expect(rowOfState('textBox', false)).toBe('text');
    expect(rowOfState('crop', false)).toBe('more');
    expect(rowOfState('select', true)).toBe('more');
  });
});

describe('ToolSidebar', () => {
  it('lists the eleven rows with Select active and its hint open', () => {
    setup(<ToolSidebar />);
    expect(document.querySelectorAll('[data-toolbar-item]')).toHaveLength(11);
    expect(row('select').getAttribute('aria-pressed')).toBe('true');
    expect(row('draw').getAttribute('aria-pressed')).toBe('false');
    expect(document.querySelectorAll('[data-tool-panel]')).toHaveLength(1);
  });

  it('opens the options of a chosen tool under its row, one panel at a time', async () => {
    const { user } = setup(<ToolSidebar />);
    await user.click(row('draw'));
    expect(useUi.getState().activeTool).toBe('draw');
    expect(row('draw').getAttribute('aria-pressed')).toBe('true');
    const panel = document.querySelector('[data-tool-panel]') as HTMLElement;
    expect(panel.getAttribute('data-tool-panel')).toBe('draw');
    expect(within(panel).getByRole('slider', { name: 'Opacity' })).not.toBeNull();
    expect(row('draw').nextElementSibling).toBe(panel);
    await user.click(row('highlight'));
    expect(document.querySelectorAll('[data-tool-panel]')).toHaveLength(1);
    expect(document.querySelector('[data-tool-panel="highlight"]')).not.toBeNull();
  });

  it('keeps a tool active when its row is clicked again, and Select releases it', async () => {
    const { user } = setup(<ToolSidebar />);
    await user.click(row('shapes'));
    await user.click(row('shapes'));
    expect(useUi.getState().activeTool).toBe('shapes');
    await user.click(row('select'));
    expect(useUi.getState().activeTool).toBe('select');
  });

  it('changes the markup variant with the segmented control', async () => {
    const { user } = setup(<ToolSidebar />);
    await user.click(row('highlight'));
    await user.click(screen.getByRole('radio', { name: 'Underline' }));
    expect(useTools.getState().markup).toBe('underline');
  });

  it('chooses between the text comment and the text box', async () => {
    const { user } = setup(<ToolSidebar />);
    await user.click(row('text'));
    expect(useUi.getState().activeTool).toBe('text');
    await user.click(screen.getByRole('button', { name: 'Insert text' }));
    expect(useUi.getState().activeTool).toBe('textBox');
    expect(row('text').getAttribute('aria-pressed')).toBe('true');
  });

  it('expands Export into action rows without changing the tool', async () => {
    const { user } = setup(<ToolSidebar />);
    await user.click(row('export'));
    expect(row('export').getAttribute('aria-expanded')).toBe('true');
    expect(useUi.getState().activeTool).toBe('select');
    const panel = document.querySelector('[data-tool-panel="export"]') as HTMLElement;
    expect(within(panel).getAllByRole('button')).toHaveLength(4);
    await user.click(row('export'));
    expect(document.querySelector('[data-tool-panel="export"]')).toBeNull();
  });

  it('shows the Crop and Redact rows under More', async () => {
    const { user } = setup(<ToolSidebar />);
    await user.click(row('more'));
    const panel = document.querySelector('[data-tool-panel="more"]') as HTMLElement;
    await user.click(within(panel).getByRole('button', { name: 'Crop' }));
    expect(useUi.getState().activeTool).toBe('crop');
    expect(row('more').getAttribute('aria-expanded')).toBe('true');
  });

  it('does nothing without a document', async () => {
    resetDocuments();
    const { user } = setup(<ToolSidebar />);
    expect(row('draw').getAttribute('aria-disabled')).toBe('true');
    await user.click(row('draw'));
    expect(useUi.getState().activeTool).toBe('select');
  });
});

describe('ToolRail', () => {
  it('has an icon button per row and opens the tool panel in a popover', async () => {
    const { user } = setup(<ToolRail />);
    expect(document.querySelectorAll('[data-toolbar-item]')).toHaveLength(11);
    await user.click(row('draw'));
    expect(useUi.getState().activeTool).toBe('draw');
    expect(row('draw').getAttribute('aria-pressed')).toBe('true');
    expect(screen.getByRole('dialog', { name: 'Draw options' })).not.toBeNull();
  });
});
