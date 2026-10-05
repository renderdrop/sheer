import { describe, expect, it } from 'vitest';

import { placeOf, type PhaseInputs } from './place';
import { SHIPPED_STEPS } from './steps';

const step = (id: string) => {
  const found = SHIPPED_STEPS.find((candidate) => candidate.id === id);
  if (found === undefined) throw new Error(id);
  return found;
};
const idle: PhaseInputs = {
  mode: 'comment',
  activeTool: 'select',
  armed: false,
  panelCollapsed: false,
  tab: 'thumbnails',
};

describe('the coach mark phases', () => {
  it('anchors Highlight and Note at the tool, then at the canvas target while the tool is active', () => {
    expect(placeOf(step('highlight'), idle)).toEqual({ name: 'tool-highlight', canvasTarget: false });
    expect(placeOf(step('highlight'), { ...idle, activeTool: 'highlight' })).toEqual({
      name: 'target',
      canvasTarget: true,
    });
    expect(placeOf(step('comment'), { ...idle, activeTool: 'highlight' })).toEqual({
      name: 'tool-note',
      canvasTarget: false,
    });
    expect(placeOf(step('comment'), { ...idle, activeTool: 'note' })).toEqual({ name: 'target', canvasTarget: true });
  });

  it('moves Sign to the frame only once something is armed', () => {
    expect(placeOf(step('sign'), { ...idle, mode: 'fill', activeTool: 'signature' })).toEqual({
      name: 'tool-signature',
      canvasTarget: false,
    });
    expect(placeOf(step('sign'), { ...idle, mode: 'fill', activeTool: 'signature', armed: true })).toEqual({
      name: 'target',
      canvasTarget: true,
    });
  });

  it('anchors the mode segment first while the tool' + "'" + 's mode is not on', () => {
    expect(placeOf(step('highlight'), { ...idle, mode: 'read' }).name).toBe('mode-comment');
    expect(placeOf(step('comment'), { ...idle, mode: 'read' }).name).toBe('mode-comment');
    expect(placeOf(step('comment'), idle).name).toBe('tool-note');
    expect(placeOf(step('sign'), idle).name).toBe('mode-fill');
  });

  it('walks Reorder from the panel toggle, to the Thumbnails tab, to the thumbnail of page S (page id 3)', () => {
    expect(placeOf(step('reorder'), { ...idle, panelCollapsed: true }).name).toBe('sidebar-toggle');
    expect(placeOf(step('reorder'), { ...idle, tab: 'outline' }).name).toBe('thumbnails-tab');
    expect(placeOf(step('reorder'), idle).name).toBe('thumbnail:3');
    // Organize mode shows the pages as a grid: the step points at its cell.
    expect(placeOf(step('reorder'), { ...idle, activeTool: 'pages', panelCollapsed: true }).name).toBe('organize:3');
  });

  it('keeps the plain anchor of the first three steps', () => {
    expect(placeOf(step('zoom'), idle)).toEqual({ name: 'topbar-zoom', canvasTarget: false });
  });
});
