import { APP_NAME } from '../../config/app';
import { useT } from '../../i18n';
import { selectActiveDocument, useDocuments } from '../../stores/documents';

/** The editor's level-one heading: it names the window (the app and the document), for screen readers only (Home has its own). */
export function WindowHeading() {
  const t = useT();
  const documentName = useDocuments((state) => selectActiveDocument(state)?.displayName ?? null);
  if (documentName === null) return null;
  return <h1 className="sr-only">{t('shell.headingDocument', { app: APP_NAME, title: documentName })}</h1>;
}
