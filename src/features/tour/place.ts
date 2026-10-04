import { useShallow } from 'zustand/react/shallow';

import { usePlacement } from '../signatures/place/store';
import { useUi, type LeftPanelTab, type ToolId } from '../../stores/ui';
import type { TourStep } from './steps';

/** What the coach mark points at right now (DESIGN 3.14 phases a and b, 3.46). */
export interface Place {
  /** The anchor's name (`ANCHORS` in `anchors.ts`, or `thumbnail:<page id>` / `organize:<page id>`). */
  name: string;
  /** Phase b on the canvas: the step's target rect on its page. */
  canvasTarget: boolean;
}

/** The facts of the interface the phase depends on. */
export interface PhaseInputs {
  activeTool: ToolId;
  /** A signature or initials is armed for the next click. */
  armed: boolean;
  panelCollapsed: boolean;
  tab: LeftPanelTab;
}

/** The tool a step's phase b waits for. */
const TOOL_OF: Readonly<Record<string, ToolId>> = { highlight: 'highlight', comment: 'note', sign: 'signature' };

/**
 * Phase a anchors the control (the tool, or for Reorder the left-panel toggle while the panel is collapsed, else the Thumbnails tab);
 * phase b anchors the canvas target while the tool is active (Sign: once something is armed), or for Reorder the thumbnail of
 * page S (the grid cell in Organize mode, which is the page order's other home).
 */
export function placeOf(step: TourStep, input: PhaseInputs): Place {
  const tool = TOOL_OF[step.id];
  if (tool !== undefined) {
    const active = input.activeTool === tool && (tool !== 'signature' || input.armed);
    return { name: active ? 'target' : step.anchor.a, canvasTarget: active && step.target !== undefined };
  }
  if (step.id === 'reorder') {
    const moving = step.from === undefined ? 0 : step.from - 1;
    if (input.activeTool === 'pages') return { name: `organize:${moving}`, canvasTarget: false };
    if (input.panelCollapsed) return { name: step.anchor.a, canvasTarget: false };
    if (input.tab !== 'thumbnails') return { name: 'thumbnails-tab', canvasTarget: false };
    return { name: `thumbnail:${moving}`, canvasTarget: false };
  }
  return { name: step.anchor.a, canvasTarget: false };
}

/** The running step's place, following the tool, the armed item and the left panel. */
export function usePlace(step: TourStep | undefined): Place | null {
  const input = useUi(
    useShallow((state) => ({
      activeTool: state.activeTool,
      panelCollapsed: state.leftPanelCollapsed,
      tab: state.leftPanelTab,
    })),
  );
  const armed = usePlacement((state) => state.item !== null);
  return step === undefined ? null : placeOf(step, { ...input, armed });
}
