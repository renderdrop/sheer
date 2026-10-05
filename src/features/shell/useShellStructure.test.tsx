// @vitest-environment jsdom
import { act, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { PANEL } from '../../components/tokens';
import { useDocuments } from '../../stores/documents';
import { useSettings } from '../../stores/settings';
import { resetDocuments } from '../../stores/documents.testutil';
import { useUi } from '../../stores/ui';
import { useViewer } from '../viewer/useViewer';
import { readShellStructure, useShellStructure } from './useShellStructure';

const uiInitial = useUi.getState();
const viewerInitial = useViewer.getState();

function resizeTo(width: number) {
  act(() => {
    Object.defineProperty(window, 'innerWidth', { value: width, configurable: true, writable: true });
    window.dispatchEvent(new Event('resize'));
  });
}

const openDocument = () => act(() => useDocuments.getState().add({ id: 1, pageCount: 3, displayName: 'a.pdf' }));

beforeEach(() => {
  useUi.setState({ ...uiInitial }, true);
  useViewer.setState({ ...viewerInitial }, true);
  resetDocuments();
  resizeTo(1100);
});

afterEach(() => {
  useUi.setState({ ...uiInitial }, true);
  useViewer.setState({ ...viewerInitial }, true);
  resetDocuments();
});

/** The structure and how many times the component that asked for it rendered. */
function follow() {
  let renders = 0;
  const hook = renderHook(() => {
    renders += 1;
    return useShellStructure();
  });
  return { ...hook, renders: () => renders };
}

describe('useShellStructure', () => {
  it('is the empty structure without a document, whatever the window does', () => {
    const { result, renders } = follow();
    expect(result.current).toMatchObject({ mode: 'empty', leftCollapsed: true, menuRow: false });
    const first = renders();
    for (const width of [960, 1280, 2400]) resizeTo(width);
    act(() => useUi.getState().selectTool('draw'));
    expect(renders()).toBe(first);
  });

  it('is the editor structure with a document, and a document opening renders once', () => {
    const { result, renders } = follow();
    const before = renders();
    openDocument();
    expect(result.current).toMatchObject({ mode: 'document', leftCollapsed: false, menuRow: false });
    expect(renders()).toBe(before + 1);
  });

  it('is Home after "back to Home" while the document stays open, and the editor again when one is activated', () => {
    openDocument();
    const { result } = follow();
    expect(result.current.mode).toBe('document');
    act(() => useUi.getState().setView('home'));
    expect(result.current.mode).toBe('empty');
    expect(useDocuments.getState().activeId).toBe(1);
    act(() => useDocuments.getState().add({ id: 2, pageCount: 1, displayName: 'b.pdf' }));
    expect(result.current.mode).toBe('document');
    act(() => useUi.getState().setView('home'));
    act(() => useDocuments.getState().setActive(1));
    expect(result.current.mode).toBe('document');
    act(() => useDocuments.getState().remove(1));
    act(() => useDocuments.getState().remove(2));
    expect(result.current.mode).toBe('empty');
    expect(useUi.getState().view).toBe('home');
  });

  it('renders for the thresholds only: 860, the user collapsing the sidebar, and the canvas under 360', () => {
    openDocument();
    const { result, renders } = follow();
    const rest = result.current;
    const first = renders();

    // Pixels of a resize within a regime, and the steps of a splitter drag within the room there is: the same object.
    for (const width of [1101, 1150, 1279, 1800, 2400]) resizeTo(width);
    for (const width of [200, 248, 300, 320]) act(() => useUi.getState().setLeftPanelWidth(width));
    act(() => useUi.getState().setLeftPanelWidth(PANEL.default));
    expect(renders()).toBe(first);
    expect(result.current).toBe(rest);

    act(() => useUi.getState().setLeftPanelCollapsed(true));
    expect(renders()).toBe(first + 1);
    expect(result.current.leftCollapsed).toBe(true);
    act(() => useUi.getState().setLeftPanelCollapsed(false));

    // A tool, a mode or a selection changes nothing in the structure.
    const before = renders();
    act(() => useUi.getState().selectTool('draw'));
    act(() => useUi.getState().setMode('edit'));
    expect(renders()).toBe(before);
    // Below 860 the window collapses the page sidebar by itself.
    resizeTo(859);
    expect(result.current).toMatchObject({ leftCollapsed: true });
  });

  it('Windows has the menu row, the other platforms none', () => {
    openDocument();
    const { result } = follow();
    expect(result.current.menuRow).toBe(false);
    act(() => useSettings.setState({ platform: 'windows' }));
    expect(result.current.menuRow).toBe(true);
    act(() => useSettings.setState({ platform: 'macos' }));
    expect(result.current.menuRow).toBe(false);
  });

  it('the canvas falling under 360 collapses the page sidebar by itself, in the render where the window makes it so', () => {
    resizeTo(870);
    useUi.setState({ leftPanelWidth: PANEL.min });
    openDocument();
    const { result, renders } = follow();
    expect(result.current.leftCollapsed).toBe(false);
    const first = renders();
    resizeTo(850);
    expect(result.current).toMatchObject({ leftCollapsed: true });
    expect(renders()).toBe(first + 1);
  });

  it('readShellStructure answers for the state right now, and the stores and the window are what it reads', () => {
    expect(readShellStructure().mode).toBe('empty');
    openDocument();
    expect(readShellStructure().mode).toBe('document');
    resizeTo(800);
    expect(readShellStructure().leftCollapsed).toBe(true);
    useUi.setState({ leftPanelCollapsed: true });
    expect(readShellStructure().leftCollapsed).toBe(true);
    useUi.setState({ view: 'home' });
    expect(readShellStructure().mode).toBe('empty');
  });

  it('stops listening when the component goes', () => {
    const { unmount, renders } = follow();
    const before = renders();
    unmount();
    resizeTo(1500);
    act(() => useUi.getState().setLeftPanelCollapsed(true));
    openDocument();
    expect(renders()).toBe(before);
  });
});
