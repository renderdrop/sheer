// Dev only (F17.10): the headers and footers dialog for the surface gate (DESIGN 3.15 HF-AC 10): default, text slot, existing, invalid range.
// The dialog opens from a ready `info` (no backend call), so the gate sees the same dialog the command shows.
import type { HeaderFooterInfo, HfSpec } from '../api/headerFooter';
import { closeHeaderFooterDialog } from '../features/headerFooter/runtime';
import { useHeaderFooter } from '../features/headerFooter/store';
import { defaultDraft, type Draft } from '../features/headerFooter/model';
import { selectActiveId, useDocuments } from '../stores/documents';
import type { DevSurface } from './surfaces';

const EMPTY: HfSpec = {
  slots: {
    headerLeft: '',
    headerCenter: '',
    headerRight: '',
    footerLeft: '{date}',
    footerCenter: '',
    footerRight: 'Page {page} of {total}',
  },
  pages: { type: 'all' },
  fontSize: 10,
  margin: 24,
  color: [15, 15, 15],
  date: '7 Oct 2026',
};

function info(spec: HfSpec | null, fileLayers: number): HeaderFooterInfo {
  return { spec, defaults: EMPTY, pending: false, fileLayers, refusal: null };
}

function surface(id: string, make: () => { info: HeaderFooterInfo; draft?: Draft }): DevSurface {
  return {
    id,
    open: () => {
      const docId = selectActiveId(useDocuments.getState()) ?? 0;
      const { info: i, draft } = make();
      useHeaderFooter
        .getState()
        .openDialog({ docId, info: i, preselect: null, ...(draft === undefined ? {} : { draft }) });
      return Promise.resolve();
    },
    close: closeHeaderFooterDialog,
  };
}

export function headerFooterSurfaces(): DevSurface[] {
  return [
    surface('hf-dialog', () => ({ info: info(null, 0) })),
    surface('hf-dialog-text', () => {
      const draft = defaultDraft();
      draft.slots.headerCenter = { kind: 'text', text: 'Quarterly report', format: 'pageNofTotal' };
      draft.current = 'headerCenter';
      return { info: info(null, 0), draft };
    }),
    surface('hf-dialog-existing', () => ({ info: info(EMPTY, 1) })),
    surface('hf-dialog-invalid', () => {
      const draft = { ...defaultDraft(), allPages: false, from: '4', to: '2' };
      return { info: info(null, 0), draft };
    }),
  ];
}
