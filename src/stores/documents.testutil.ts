import type { DocumentInfo, OpenOutcome } from '../api/documents';
import type { AppError } from '../api/errors';
import { selectActiveDocument, useDocuments } from './documents';

const initial = useDocuments.getState();

/** Back to no open documents. */
export function resetDocuments(): void {
  useDocuments.setState({ ...initial }, true);
}

/** The active document's info, or `null`. */
export function activeDocument(): DocumentInfo | null {
  return selectActiveDocument(useDocuments.getState());
}

/** An open outcome the backend reports for a document it opened. */
export function opened(document: DocumentInfo): OpenOutcome {
  return { type: 'opened', document };
}

/** An open outcome the backend reports for a file it could not open. */
export function openFailed(error: AppError): OpenOutcome {
  return { type: 'openFailed', error };
}
