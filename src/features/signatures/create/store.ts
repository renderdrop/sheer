import { create } from 'zustand';

import type { SignatureRole } from '../../../api/library';
import type { SignatureRef } from '../../../api/signatures';
import type { SigColour } from './model';

interface Request {
  id: number;
  kind: SignatureRole;
  resolve: (ref: SignatureRef | null) => void;
}

interface SheetState {
  request: Request | null;
}

export const useSignatureSheet = create<SheetState>()(() => ({ request: null }));

let nextId = 0;
let lastColour: SigColour = 'black';

/** The ink colour chosen last in the sheet: the art is a shape, so the colour is applied where it is placed. */
export const lastSignatureColour = (): SigColour => lastColour;
export const rememberSignatureColour = (colour: SigColour): void => {
  lastColour = colour;
};

/**
 * Opens the creation sheet (DESIGN 3.33). Resolves with a draft or library reference, or `null` when it was cancelled. A second call
 * while one is open cancels the first.
 */
export function openSignatureSheet(kind: SignatureRole): Promise<SignatureRef | null> {
  useSignatureSheet.getState().request?.resolve(null);
  return new Promise((resolve) => {
    nextId += 1;
    useSignatureSheet.setState({ request: { id: nextId, kind, resolve } });
  });
}

/** Ends the open request with `ref` (`null` cancels) and closes the sheet. */
export function settleSignatureSheet(id: number, ref: SignatureRef | null): void {
  const { request } = useSignatureSheet.getState();
  if (request === null || request.id !== id) return;
  useSignatureSheet.setState({ request: null });
  request.resolve(ref);
}
