// @vitest-environment jsdom
import { act } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { useDocuments } from '../../stores/documents';
import { resetDocuments } from '../../stores/documents.testutil';
import { useUi } from '../../stores/ui';
import { setup } from '../../test/render';
import { ModeRow, ToolRow } from '../modes';
import { LeftPanelSplitter } from '../shell/MainGrid';
import { StatusBar } from '../statusbar/StatusBar';
import { TopBar } from '../topbar/TopBar';
import { useView } from '../../stores/view';
import { ANCHORS, modeOfAnchor, resolveAnchor } from './anchors';
import { placeOf } from './place';
import { SHIPPED_STEPS } from './steps';

vi.mock('../viewer/useViewer', () => ({
  useViewer: Object.assign((select: (state: unknown) => unknown) => select({ goToPage: vi.fn(), rendering: false }), {
    getState: () => ({ goToPage: vi.fn(), rendering: false }),
  }),
}));
vi.mock('../../api/library', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../api/library')>()),
  listSignatures: vi.fn().mockResolvedValue({ status: 'ready', items: [] }),
}));

const uiInitial = useUi.getState();

beforeEach(() => {
  useUi.setState({ ...uiInitial }, true);
  resetDocuments();
  act(() => useDocuments.getState().add({ id: 1, pageCount: 6, displayName: 'd.pdf' }));
  useView.getState().open(1, 6);
  useUi.getState().setView('editor');
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
    expect(modeOfAnchor('sidebar-toggle')).toBeNull();
    expect(modeOfAnchor('topbar-file-name')).toBeNull();
  });

  it('resolves the tool anchor of each step after the step switched to its mode', () => {
    setup(<ToolRow />);
    for (const step of SHIPPED_STEPS) {
      const place = placeOf(step, {
        mode: 'comment',
        activeTool: 'select',
        armed: false,
        panelCollapsed: false,
        tab: 'thumbnails',
      });
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

  it('finds every step anchor and phase 0 anchor of the top bar, the mode row and the sidebar toggle in a rendered editor', () => {
    setup(
      <>
        <TopBar trafficLightInset={false} />
        <ModeRow />
        <StatusBar />
        <LeftPanelSplitter controls="left-panel" collapsed={false} />
      </>,
    );
    const names = new Set<string>(['mode-comment', 'mode-fill']);
    for (const step of SHIPPED_STEPS) if (modeOfAnchor(step.anchor.a) === null) names.add(step.anchor.a);
    for (const name of names) {
      const spec = ANCHORS[name];
      expect(spec, name).toBeDefined();
      const found = document.querySelector(spec?.selector ?? '');
      expect(found, name).not.toBeNull();
      expect(resolveAnchor(name)?.element, name).toBe(found);
    }
    expect(names.has('topbar-zoom') && names.has('sidebar-toggle') && names.has('topbar-file-name')).toBe(true);
  });

  it('does not find a tool anchor outside its mode', () => {
    setup(<ToolRow />);
    expect(document.querySelector('[data-toolbar-item="highlight"]')).toBeNull();
  });
});
