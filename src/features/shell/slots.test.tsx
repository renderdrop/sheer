// @vitest-environment jsdom
import { act, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { runAction } from '../../actions/dispatch';
import { useDocuments } from '../../stores/documents';
import { resetDocuments } from '../../stores/documents.testutil';
import { useUi } from '../../stores/ui';
import { setup } from '../../test/render';
import { CaptionBar } from './CaptionBar';
import { HomeSlot } from './HomeSlot';
import { ToolSidebarSlot } from './ToolSidebarSlot';

vi.mock('../../api/window', () => ({
  minimizeWindow: vi.fn(),
  toggleMaximizeWindow: vi.fn(),
  closeWindow: vi.fn(),
}));

const uiInitial = useUi.getState();

beforeEach(() => {
  useUi.setState({ ...uiInitial }, true);
  resetDocuments();
});

afterEach(() => {
  useUi.setState({ ...uiInitial }, true);
  resetDocuments();
});

describe('the view', () => {
  it('starts as Home, and opening or activating a document makes it the editor', () => {
    expect(useUi.getState().view).toBe('home');
    act(() => useDocuments.getState().add({ id: 1, pageCount: 2, displayName: 'a.pdf' }));
    expect(useUi.getState().view).toBe('editor');
  });

  it('view-home goes back to Home and the documents stay open; activating one returns to the editor', () => {
    act(() => useDocuments.getState().add({ id: 1, pageCount: 2, displayName: 'a.pdf' }));
    act(() => useDocuments.getState().add({ id: 2, pageCount: 2, displayName: 'b.pdf' }));
    runAction('view-home');
    expect(useUi.getState().view).toBe('home');
    expect(useDocuments.getState().order).toEqual([1, 2]);
    act(() => useDocuments.getState().setActive(1));
    expect(useUi.getState().view).toBe('editor');
  });

  it('Home -> activating the already active document shows the editor again', () => {
    act(() => useDocuments.getState().add({ id: 1, pageCount: 2, displayName: 'a.pdf' }));
    runAction('view-home');
    act(() => useDocuments.getState().setActive(1));
    expect(useUi.getState().view).toBe('editor');
    runAction('view-home');
    act(() => useDocuments.getState().add({ id: 1, pageCount: 2, displayName: 'a.pdf' }));
    expect(useUi.getState().view).toBe('editor');
  });

  it('closing the last document shows Home', () => {
    act(() => useDocuments.getState().add({ id: 1, pageCount: 2, displayName: 'a.pdf' }));
    act(() => useDocuments.getState().remove(1));
    expect(useUi.getState().view).toBe('home');
  });
});

describe('HomeSlot', () => {
  it('is a brand surface with a 56 drag strip holding the caption controls', () => {
    const { container } = setup(
      <HomeSlot
        platform="windows"
        trafficLightInset={false}
        captionControls={<CaptionBar maximized={false} onChanged={vi.fn()} />}
      />,
    );
    expect(container.querySelector('[data-surface="brand"]')).not.toBeNull();
    const strip = container.querySelector('[data-slot="home-strip"]');
    expect(strip?.className).toContain('h-topbar');
    expect(strip?.getAttribute('data-tauri-drag-region')).toBe('deep');
    expect(within(strip as HTMLElement).getByRole('group', { name: 'Window controls' })).not.toBeNull();
  });

  it('insets the strip for the macOS traffic lights', () => {
    const { container } = setup(<HomeSlot platform="macos" trafficLightInset captionControls={null} />);
    expect(container.querySelector('[data-slot="home-strip"]')?.className).toContain('ps-chrome-inset');
    expect(screen.queryByRole('group', { name: 'Window controls' })).toBeNull();
  });
});

describe('ToolSidebarSlot', () => {
  it('shows the tool sidebar, and the rail of tool icons when it is not visible', () => {
    const style = { gridColumn: 4 };
    const { rerender } = setup(<ToolSidebarSlot visible style={style} />);
    expect(screen.getByRole('complementary', { name: 'Inspector' })).not.toBeNull();
    expect(screen.getByRole('heading', { name: 'Tools' })).not.toBeNull();
    rerender(<ToolSidebarSlot visible={false} style={style} />);
    expect(screen.queryByRole('complementary', { name: 'Inspector' })).toBeNull();
    expect(within(screen.getByRole('group', { name: 'Inspector' })).getAllByRole('button')).toHaveLength(11);
  });
});
