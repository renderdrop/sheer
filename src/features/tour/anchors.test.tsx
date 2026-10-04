// @vitest-environment jsdom
import { act } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { useDocuments } from '../../stores/documents';
import { resetDocuments } from '../../stores/documents.testutil';
import { useUi } from '../../stores/ui';
import { setup } from '../../test/render';
import { ToolRow } from '../modes';
import { ANCHORS, modeOfAnchor, resolveAnchor } from './anchors';
import { placeOf } from './place';
import { SHIPPED_STEPS } from './steps';

vi.mock('../../api/library', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../api/library')>()),
  listSignatures: vi.fn().mockResolvedValue({ status: 'ready', items: [] }),
}));

const uiInitial = useUi.getState();

beforeEach(() => {
  useUi.setState({ ...uiInitial }, true);
  resetDocuments();
  act(() => useDocuments.getState().add({ id: 1, pageCount: 6, displayName: 'd.pdf' }));
});

afterEach(() => {
  resetDocuments();
  useUi.setState({ ...uiInitial }, true);
});

describe('tour anchors and modes', () => {
  it('names the mode of each tool anchor and none for the always-present ones', () => {
    expect(modeOfAnchor('tool-highlight')).toBe('comment');
    expect(modeOfAnchor('tool-note')).toBe('comment');
    expect(modeOfAnchor('tool-signature')).toBe('fill');
    expect(modeOfAnchor('organize:3')).toBe('pages');
    expect(modeOfAnchor('left-panel')).toBeNull();
    expect(modeOfAnchor('status-file-name')).toBeNull();
  });

  it('resolves the tool anchor of each step after the step switched to its mode', () => {
    setup(<ToolRow />);
    for (const step of SHIPPED_STEPS) {
      const place = placeOf(step, { activeTool: 'select', armed: false, panelCollapsed: false, tab: 'thumbnails' });
      const mode = modeOfAnchor(place.name);
      if (mode === null) continue;
      act(() => useUi.getState().setMode(mode));
      const spec = ANCHORS[place.name];
      expect(spec, step.id).toBeDefined();
      const found = document.querySelector(spec?.selector ?? '');
      expect(found, step.id).not.toBeNull();
      expect(resolveAnchor(place.name)?.element, step.id).toBe(found);
    }
  });

  it('does not find a tool anchor outside its mode', () => {
    setup(<ToolRow />);
    expect(document.querySelector('[data-toolbar-item="highlight"]')).toBeNull();
  });
});
