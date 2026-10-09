import { beforeEach, describe, expect, it, vi } from 'vitest';

import { MODES, TOOLS, useUi } from '../../stores/ui';
import { useToolInspector } from '../inspector/toolInspector';
import { useJobs } from '../jobs/state';
import {
  CATALOGUE,
  CATALOGUED_TOOL_IDS,
  EXCLUDED_TOOLS,
  EXTRA_TOOLS,
  catalogueByMode,
  type CatalogueId,
} from './catalogue';
import { useHub } from './intent';
import { launchTool } from './run';

const documents = vi.hoisted(() => ({ openDocumentDialog: vi.fn() }));
const viewer = vi.hoisted(() => ({ adoptOpenOutcomes: vi.fn(), opening: false }));
const library = vi.hoisted(() => ({ listSignatures: vi.fn() }));
const place = vi.hoisted(() => ({ armItem: vi.fn(), createAndArm: vi.fn() }));
const forms = vi.hoisted(() => ({
  load: vi.fn(),
  setHighlight: vi.fn(),
  state: { byDoc: {} as Record<number, unknown> },
}));

vi.mock('../../api/documents', () => documents);
vi.mock('../../api/library', () => library);
vi.mock('../signatures/place/menu', () => place);
vi.mock('../forms/focus', () => ({ focusFirstEmpty: vi.fn() }));
vi.mock('../forms/store', () => ({
  useForms: { getState: () => ({ load: forms.load, setHighlight: forms.setHighlight, byDoc: forms.state.byDoc }) },
}));
vi.mock('../annotations/stamps/store', () => ({
  armStamp: () => useUi.getState().selectTool('stamp'),
}));
vi.mock('../viewer/useViewer', () => {
  const state = { opening: false };
  return {
    adoptOpenOutcomes: viewer.adoptOpenOutcomes,
    useViewer: Object.assign(() => state.opening, {
      getState: () => state,
      setState: (patch: Partial<typeof state>) => Object.assign(state, patch),
    }),
  };
});

const DOC = { id: 7, pageCount: 3, displayName: 'a.pdf' };

describe('the catalogue', () => {
  it('has an entry for every tool except the pointer tools', () => {
    const covered = new Set<string>(CATALOGUE.map((entry) => entry.id));
    const missing = TOOLS.filter((tool) => !(EXCLUDED_TOOLS as readonly string[]).includes(tool) && !covered.has(tool));
    expect(missing).toEqual([]);
    expect(CATALOGUED_TOOL_IDS.every((tool) => covered.has(tool))).toBe(true);
    expect(EXTRA_TOOLS.every((extra) => covered.has(extra))).toBe(true);
  });

  it('has no duplicates, leaves out the excluded tools and groups by the five modes', () => {
    const ids = CATALOGUE.map((entry) => entry.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const excluded of EXCLUDED_TOOLS) expect(ids).not.toContain(excluded);
    expect(catalogueByMode().map((group) => group.mode)).toEqual([...MODES]);
  });
});

describe('launchTool', () => {
  beforeEach(() => {
    documents.openDocumentDialog.mockReset().mockResolvedValue([{ type: 'opened', document: DOC }]);
    viewer.adoptOpenOutcomes.mockReset();
    library.listSignatures.mockReset().mockResolvedValue({
      status: 'unlocked',
      items: [{ id: 'sig1', role: 'signature', name: 'Mine', aspect: 2 }],
    });
    place.armItem.mockReset().mockImplementation(() => useUi.getState().selectTool('signature'));
    place.createAndArm.mockReset().mockResolvedValue(undefined);
    forms.load.mockReset().mockResolvedValue(undefined);
    forms.state.byDoc = { 7: { status: 'ready' } };
    useUi.setState({
      mode: 'read',
      activeTool: 'select',
      toolLocked: false,
      redactMode: false,
      protectOpen: false,
      exportImagesOpen: false,
      imagesToPdfOpen: false,
      view: 'home',
    });
    useToolInspector.setState({ open: null });
    useJobs.getState().setSheet(null);
    useHub.setState({ busy: null });
  });

  it.each(CATALOGUE.map((entry) => [entry.id, entry.mode] as const))(
    '%s ends in the %s mode, ready',
    async (id, mode) => {
      await launchTool(id);
      if (id === 'images') {
        expect(documents.openDocumentDialog).not.toHaveBeenCalled();
        expect(useUi.getState().imagesToPdfOpen).toBe(true);
        return;
      }
      expect(documents.openDocumentDialog).toHaveBeenCalledWith({ single: id !== 'merge' });
      if (id === 'merge') {
        expect(useJobs.getState().sheet?.kind).toBe('merge');
        return;
      }
      const ui = useUi.getState();
      expect(ui.mode).toBe(mode);
      switch (id) {
        case 'redact':
          expect(ui.redactMode).toBe(true);
          break;
        case 'protect':
          expect(ui.protectOpen).toBe(true);
          break;
        case 'export':
          expect(ui.exportImagesOpen).toBe(true);
          break;
        case 'split':
        case 'compress':
          expect(useJobs.getState().sheet?.kind).toBe(id);
          break;
        case 'form':
          expect(forms.load).toHaveBeenCalledWith(7);
          break;
        case 'pages':
          expect(ui.activeTool).toBe('pages');
          break;
        case 'headerFooter':
        case 'ocr':
          expect(useToolInspector.getState().open).toBe(id);
          break;
        case 'crop':
        case 'stamp':
          expect(useToolInspector.getState().open).toBe(id);
          expect(ui.activeTool).toBe(id);
          break;
        default:
          expect(ui.activeTool).toBe(id);
      }
      expect(useHub.getState().busy).toBeNull();
    },
  );

  it('a signature without saved items opens the creation sheet', async () => {
    library.listSignatures.mockResolvedValue({ status: 'unlocked', items: [] });
    await launchTool('signature');
    expect(place.createAndArm).toHaveBeenCalledWith('signature');
    expect(useUi.getState().mode).toBe('fill');
  });

  it('a cancelled file dialog changes nothing', async () => {
    documents.openDocumentDialog.mockResolvedValue([]);
    await launchTool('crop' satisfies CatalogueId);
    expect(useUi.getState().mode).toBe('read');
    expect(useHub.getState().busy).toBeNull();
  });
});
