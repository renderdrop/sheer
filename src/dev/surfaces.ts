// Dev only (F17.10): the surface registry `scripts/ui/surface-gate.mjs` drives over CDP. `main.tsx` imports this module behind
// `import.meta.env.DEV`, so no release bundle holds it (`scripts/check.sh` fails the bundle guard on the registry's name).
// Every entry opens one dialog or sheet through its store or action, never through new behaviour. Popovers that hang on a trigger
// button (`aria-haspopup`) are found by the gate itself.
import { openAbout, useAboutDialog } from '../features/about/state';
import { useForms } from '../features/forms/store';
import { closeSheet, openCompress, openMerge, openSplit } from '../features/jobs/state';
import { usePassword } from '../features/password/state';
import { useRedact } from '../features/redact/store';
import { useSave } from '../features/save/state';
import { closeSignaturesDialog, openSignaturesDialog } from '../features/sigcheck/open';
import { openSignatureSheet, useSignatureSheet } from '../features/signatures/create/store';
import { openSignatureLibrary, useSignatureLibrary } from '../features/signatures/library/state';
import { useCertSign } from '../features/signatures/sign/store';
import { closeSettings, openSettings } from '../features/settings/state';
import { selectActiveId, useDocuments } from '../stores/documents';
import { useUi } from '../stores/ui';

export interface DevSurface {
  id: string;
  open: () => Promise<void>;
  close: () => void | Promise<void>;
}

declare global {
  interface Window {
    __sheerSurfaces?: DevSurface[];
  }
}

const activeId = (): number => selectActiveId(useDocuments.getState()) ?? 0;
const ui = () => useUi.getState();
const none = (): Promise<void> => Promise.resolve();

/** A surface that is a boolean in a store: opening is the setter with `true`, closing with `false`. */
function flag(id: string, set: (open: boolean) => void): DevSurface {
  return {
    id,
    open: () => {
      set(true);
      return none();
    },
    close: () => set(false),
  };
}

export function buildSurfaces(): DevSurface[] {
  return [
    { id: 'settings', open: () => (openSettings(), none()), close: closeSettings },
    {
      id: 'about',
      open: () => (openAbout(), none()),
      close: () => useAboutDialog.getState().setOpen(false),
    },
    flag('print', (o) => ui().setPrintOpen(o)),
    flag('protect', (o) => ui().setProtectOpen(o)),
    flag('properties', (o) => ui().setPropsOpen(o)),
    flag('export-images', (o) => ui().setExportImagesOpen(o)),
    flag('images-to-pdf', (o) => ui().setImagesToPdfOpen(o)),
    flag('export-copy', (o) => ui().setExportCopyOpen(o)),
    flag('flatten', (o) => useForms.getState().setFlattenOpen(o)),
    flag('redact-apply', (o) => useRedact.getState().setApplyOpen(o)),
    { id: 'merge', open: () => (openMerge(), none()), close: closeSheet },
    { id: 'split-every', open: () => (openSplit('every'), none()), close: closeSheet },
    { id: 'split-ranges', open: () => (openSplit('ranges'), none()), close: closeSheet },
    { id: 'split-extract', open: () => (openSplit('extract'), none()), close: closeSheet },
    { id: 'compress', open: () => (openCompress(), none()), close: closeSheet },
    {
      id: 'signatures-dialog',
      open: () => (openSignaturesDialog(activeId()), none()),
      close: closeSignaturesDialog,
    },
    {
      id: 'signature-library',
      open: () => (openSignatureLibrary(), none()),
      close: () => useSignatureLibrary.setState({ open: false }),
    },
    ...(['signature', 'initials'] as const).map((kind): DevSurface => ({
      id: `signature-sheet-${kind}`,
      open: () => {
        void openSignatureSheet(kind);
        return none();
      },
      close: () => {
        const request = useSignatureSheet.getState().request;
        useSignatureSheet.setState({ request: null });
        request?.resolve(null);
      },
    })),
    {
      id: 'certificate-sign',
      open: () => {
        useCertSign.getState().setBox({ docId: activeId(), pageIndex: 0, rect: { x: 72, y: 72, w: 160, h: 60 } });
        useCertSign.getState().openDialog();
        return none();
      },
      close: () => useCertSign.getState().reset(),
    },
    {
      id: 'password',
      open: () => {
        usePassword.getState().request(2_000_000_000, 'secret.pdf');
        return none();
      },
      close: () => usePassword.getState().finish(2_000_000_000),
    },
    {
      id: 'unsaved',
      open: () => {
        useSave.getState().setPrompt(activeId());
        return none();
      },
      close: () => useSave.getState().setPrompt(null),
    },
    {
      id: 'overwrite',
      open: () => {
        useSave.getState().setOverwrite({ docId: activeId(), resolve: () => undefined });
        return none();
      },
      close: () => useSave.getState().setOverwrite(null),
    },
    {
      id: 'rewrite-protected',
      open: () => {
        useSave.getState().setRewrite({ docId: activeId(), resolve: () => undefined });
        return none();
      },
      close: () => useSave.getState().setRewrite(null),
    },
  ];
}

if (import.meta.env.DEV) window.__sheerSurfaces = buildSurfaces();
