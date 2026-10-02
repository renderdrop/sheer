// @vitest-environment jsdom
import { act, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { PANEL } from '../../components/tokens';
import { useDocuments } from '../../stores/documents';
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
    expect(result.current).toMatchObject({ mode: 'empty', leftCollapsed: true, inspectorReserved: false });
    const first = renders();
    for (const width of [960, 1280, 2400]) resizeTo(width);
    act(() => useUi.getState().setInspector('open'));
    act(() => useUi.getState().selectTool('draw'));
    expect(renders()).toBe(first);
  });

  it('is the document structure with one, and a document opening renders once', () => {
    const { result, renders } = follow();
    const before = renders();
    openDocument();
    expect(result.current).toMatchObject({ mode: 'document', leftCollapsed: false, inspectorReserved: false });
    expect(renders()).toBe(before + 1);
  });

  it('renders for the thresholds only: 1280, the user collapsing the panel, the inspector toggle, and the canvas under 360', () => {
    openDocument();
    const { result, renders } = follow();
    const rest = result.current;
    const first = renders();

    // Pixels of a resize within a regime, and the steps of a splitter drag within the room there is: the same object.
    for (const width of [1101, 1150, 1279]) resizeTo(width);
    for (const width of [200, 248, 300, 400]) act(() => useUi.getState().setLeftPanelWidth(width));
    act(() => useUi.getState().setLeftPanelWidth(PANEL.default));
    expect(renders()).toBe(first);
    expect(result.current).toBe(rest);

    resizeTo(1280);
    expect(renders()).toBe(first + 1);
    expect(result.current.inspectorReserved).toBe(true);
    for (const width of [1300, 1800, 2400]) resizeTo(width);
    expect(renders()).toBe(first + 1);

    act(() => useUi.getState().setLeftPanelCollapsed(true));
    expect(renders()).toBe(first + 2);
    expect(result.current.leftCollapsed).toBe(true);
    act(() => useUi.getState().setLeftPanelCollapsed(false));

    // A tool has options to show, which fades the inspector in from 1280 px.
    const before = renders();
    act(() => useUi.getState().selectTool('highlight'));
    expect(renders()).toBe(before + 1);
    expect(result.current.inspectorVisible).toBe(true);
    // Another tool changes nothing in the structure.
    act(() => useUi.getState().selectTool('draw'));
    expect(renders()).toBe(before + 1);
  });

  it('the canvas falling under 360 collapses the panel by itself, in the render where the splitter makes it so', () => {
    resizeTo(960);
    useUi.setState({ inspector: 'open', leftPanelWidth: PANEL.min });
    openDocument();
    const { result, renders } = follow();
    expect(result.current.leftCollapsed).toBe(false);
    const first = renders();
    // 960 - 8 - 296 - 8 - 8 - 296 = 344: under 360.
    act(() => useUi.getState().setLeftPanelWidth(296));
    expect(result.current).toMatchObject({ leftCollapsed: true, leftAutoCollapsed: true });
    expect(renders()).toBe(first + 1);
  });

  it('readShellStructure answers for the state right now, and the stores and the window are what it reads', () => {
    expect(readShellStructure().mode).toBe('empty');
    openDocument();
    expect(readShellStructure().mode).toBe('document');
    expect(readShellStructure().inspectorReserved).toBe(false);
    resizeTo(1400);
    expect(readShellStructure().inspectorReserved).toBe(true);
    useUi.setState({ leftPanelCollapsed: true });
    expect(readShellStructure().leftCollapsed).toBe(true);
  });

  it('stops listening when the component goes', () => {
    const { unmount, renders } = follow();
    const before = renders();
    unmount();
    resizeTo(1500);
    act(() => useUi.getState().setInspector('open'));
    openDocument();
    expect(renders()).toBe(before);
  });
});
