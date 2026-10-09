import { create } from 'zustand';

import { listSignatures } from '../../api/library';
import { translators } from '../../i18n';
import { useLocaleStore } from '../../i18n/store';
import { useTools } from '../../stores/tools';
import { useUi, modeOfTool, type ToolId } from '../../stores/ui';
import { armStamp } from '../annotations/stamps/store';
import { focusFirstEmpty } from '../forms/focus';
import { useForms } from '../forms/store';
import { useToolInspector, type ToolInspectorId } from '../inspector/toolInspector';
import { openCompress, openSplit } from '../jobs/state';
import { switchMode } from '../modes/switch';
import { enterRedactMode } from '../redact/actions';
import { armItem, createAndArm } from '../signatures/place/menu';
import { catalogueEntry, type CatalogueId } from './catalogue';

interface HubState {
  /** The tool whose file dialog or open is running (`aria-busy`; the other tiles are `aria-disabled`). */
  busy: CatalogueId | null;
  setBusy: (busy: CatalogueId | null) => void;
}

export const useHub = create<HubState>()((set) => ({
  busy: null,
  setBusy: (busy) => set({ busy }),
}));

/** Makes a tool the active one without ever toggling it off. */
function choose(tool: ToolId): void {
  const ui = useUi.getState();
  if (ui.activeTool !== tool) ui.selectTool(tool);
}

async function fillForm(docId: number): Promise<void> {
  switchMode('fill');
  const forms = useForms.getState();
  await forms.load(docId);
  const form = useForms.getState().byDoc[docId];
  if (form !== undefined && form.status === 'ready') {
    forms.setHighlight(true);
    focusFirstEmpty(docId);
    return;
  }
  // No fields: a note why; the mode row is on Ausfüllen & Signieren already, with its Text, Datum and Signatur items.
  useUi.getState().showToast({ message: translators[useLocaleStore.getState().locale]('hub.noFields') });
}

/** Signature: the first saved signature is armed for the first click; with none, the creation sheet opens and arms what it makes. */
async function armSignature(): Promise<void> {
  switchMode('fill');
  try {
    const library = await listSignatures();
    const first = library.status === 'locked' ? undefined : library.items.find((item) => item.role === 'signature');
    if (first !== undefined) {
      armItem({ type: 'signature', role: 'signature', ref: { type: 'library', id: first.id }, aspect: first.aspect });
      return;
    }
  } catch {
    // The creation sheet reports what is wrong with the library.
  }
  await createAndArm('signature');
}

function withInspector(id: ToolInspectorId): void {
  useToolInspector.getState().openToolInspector(id);
}

/**
 * What a tool does once its document is open and active (F21.3, ADR-145): it lands in the tool's mode, activates the tool and opens the
 * inspector or dialog the tool has, so the first drag or click works at once. Merge and Images to PDF are not here: they need no
 * single document (`launchTool`).
 */
export async function applyLaunch(id: CatalogueId, docId: number): Promise<void> {
  const mode = catalogueEntry(id)?.mode ?? null;
  switch (id) {
    case 'split':
      switchMode('pages');
      openSplit('every');
      return;
    case 'compress':
      switchMode('pages');
      openCompress();
      return;
    case 'export':
      switchMode('pages');
      useUi.getState().setExportImagesOpen(true);
      return;
    case 'redact':
      switchMode('edit');
      enterRedactMode();
      return;
    case 'protect':
      switchMode('edit');
      useUi.getState().setProtectOpen(true);
      return;
    case 'form':
      await fillForm(docId);
      return;
    case 'signature':
      await armSignature();
      return;
    case 'stamp':
      switchMode('edit');
      armStamp();
      withInspector('stamp');
      return;
    case 'crop':
      switchMode('edit');
      choose('crop');
      withInspector('crop');
      return;
    case 'headerFooter':
    case 'ocr':
      switchMode('edit');
      withInspector(id);
      return;
    case 'highlight':
      switchMode('comment');
      useTools.getState().setMarkup('highlight');
      choose('highlight');
      return;
    case 'merge':
    case 'images':
      return;
    default:
      switchMode(mode ?? modeOfTool(id) ?? 'read');
      // The page grid is Seiten's idle tool.
      if (id !== 'pages') choose(id);
  }
}
