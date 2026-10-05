import { useT } from '../../i18n';
import { useBibliography } from '../citations/bibliography';
import { formatShortCitation } from '../citations/format';
import { useCitationStyle } from '../citations/style';

/**
 * The line under a citation card's quote (DESIGN 3.7 C8): the short citation in the chosen style, then the page label. Its own component, so
 * that only citation cards read the bibliographic record.
 */
export function CitationLine({ docId, locator }: { docId: number; locator: string }) {
  const t = useT();
  const [style] = useCitationStyle();
  const { info } = useBibliography(docId);
  const short = formatShortCitation(info?.record, locator, style, t.locale);
  // The short citation already carries the locator ("(Schmidt, 2021, S. 1)"); the page label stands alone only without one.
  return <p className="t-caption m-0 truncate">{short !== '' ? short : t('citation.page', { label: locator })}</p>;
}
