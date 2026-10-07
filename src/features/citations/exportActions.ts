import {
  fitsCitationExport,
  listCitations,
  saveCitationList as saveCitationListFile,
  type CitationInfo,
  type StyledBlock,
} from '../../api/citations';
import { translators, type Translate } from '../../i18n';
import { useLocaleStore } from '../../i18n/store';
import { useDocuments } from '../../stores/documents';
import { useUi } from '../../stores/ui';
import { fetchBibliography } from './bibliography';
import { blocksToHtml, blocksToPlainText, formatCitationCopy, formatCitationList, formatReference } from './format';
import { getCitationFormat, getCitationStyle } from './style';

/** Copy and save actions of the reference and the citation list (DESIGN 3.7 C3, C4, C7, Datei menu). Each reports through one toast. */

const tr = (): Translate => translators[useLocaleStore.getState().locale];
const lang = (): 'en' | 'de' => (useLocaleStore.getState().locale === 'de' ? 'de' : 'en');

function toast(message: string, retry?: () => void, error = false): void {
  const t = tr();
  const tone = error ? ({ tone: 'alert' } as const) : {};
  useUi
    .getState()
    .showToast(
      retry === undefined
        ? { message, ...tone }
        : { message, ...tone, action: { label: t('comments.retry'), run: retry } },
    );
}

/** Whether the file forbids copying text: the quotes then stay out of whatever goes to the clipboard or a file. */
function copyForbidden(docId: number): boolean {
  const permissions = useDocuments.getState().byId[docId]?.flags?.permissions;
  return Array.isArray(permissions) && !permissions.includes('copy');
}

/**
 * Writes text and HTML to the clipboard in one item; where a webview has no `ClipboardItem`, or refuses rich content, plain text.
 * This is the web API: it needs a user gesture and no plugin or capability. Resolves to whether something was written.
 */
export async function writeClipboard(text: string, html: string): Promise<boolean> {
  const clipboard = globalThis.navigator?.clipboard;
  if (clipboard === undefined) return false;
  try {
    if (typeof ClipboardItem !== 'undefined' && typeof clipboard.write === 'function') {
      await clipboard.write([
        new ClipboardItem({
          'text/plain': new Blob([text], { type: 'text/plain' }),
          'text/html': new Blob([html], { type: 'text/html' }),
        }),
      ]);
      return true;
    }
  } catch {
    // Fall through to plain text.
  }
  try {
    await clipboard.writeText(text);
    return true;
  } catch {
    return false;
  }
}

async function copyBlocks(blocks: readonly StyledBlock[], done: string, retry: () => void): Promise<void> {
  const ok = await writeClipboard(blocksToPlainText(blocks), blocksToHtml(blocks));
  toast(ok ? done : tr()('reference.copyFailed'), ok ? undefined : retry, !ok);
}

/** The record, the citations and the settings that a list is made of. */
async function gather(docId: number) {
  const [{ record }, citations] = await Promise.all([fetchBibliography(docId), listCitations(docId)]);
  const left = copyForbidden(docId);
  const shown: CitationInfo[] = left ? citations.map((c) => ({ ...c, quote: '' })) : citations;
  return { record, citations: shown, quotesLeftOut: left, style: getCitationStyle() };
}

/** Copies the quote and its short citation of one citation (`citation.copied`). */
export async function copyCitation(docId: number, annotId: number): Promise<void> {
  try {
    const { record, citations, quotesLeftOut, style } = await gather(docId);
    const one = citations.find((c) => c.id === annotId);
    if (one === undefined) return;
    // One citation of a group copies its own page, not the joined locator.
    const blocks = formatCitationCopy(record, one, style, lang());
    const t = tr();
    await copyBlocks(blocks, quotesLeftOut ? t('reference.quotesLeftOut') : t('citation.copied'), () => {
      void copyCitation(docId, annotId);
    });
  } catch {
    toast(
      tr()('reference.copyFailed'),
      () => {
        void copyCitation(docId, annotId);
      },
      true,
    );
  }
}

/** Copies the reference entry of the document (`reference.copied`). */
export async function copyReference(docId: number): Promise<void> {
  try {
    const { record } = await fetchBibliography(docId);
    await copyBlocks([formatReference(record, getCitationStyle(), lang())], tr()('reference.copied'), () => {
      void copyReference(docId);
    });
  } catch {
    toast(
      tr()('reference.copyFailed'),
      () => {
        void copyReference(docId);
      },
      true,
    );
  }
}

/** Copies the reference and every citation (`reference.listCopied`); with no citation it says so instead. */
export async function copyCitationList(docId: number): Promise<void> {
  try {
    const { record, citations, quotesLeftOut, style } = await gather(docId);
    if (citations.length === 0) {
      toast(tr()('reference.empty'));
      return;
    }
    const t = tr();
    await copyBlocks(
      formatCitationList(record, citations, style, lang()),
      quotesLeftOut ? t('reference.quotesLeftOut') : t('reference.listCopied'),
      () => {
        void copyCitationList(docId);
      },
    );
  } catch {
    toast(
      tr()('reference.copyFailed'),
      () => {
        void copyCitationList(docId);
      },
      true,
    );
  }
}

/**
 * Saves the list in the last used format through the native dialog (`reference.listSaved`). `.ris` and `.bib` hold the reference
 * only. Cancelling the dialog shows nothing; a failure shows `reference.saveFailed` with Try again.
 */
export async function saveCitationList(docId: number): Promise<void> {
  const retry = () => {
    void saveCitationList(docId);
  };
  try {
    const format = getCitationFormat();
    const style = getCitationStyle();
    const { record, citations } = await gather(docId);
    if (citations.length === 0 && format !== 'ris' && format !== 'bib') {
      toast(tr()('reference.empty'));
      return;
    }
    const blocks = format === 'ris' || format === 'bib' ? [] : formatCitationList(record, citations, style, lang());
    if (!fitsCitationExport(blocks)) {
      toast(tr()('reference.saveFailed'), undefined, true);
      return;
    }
    const saved = await saveCitationListFile(docId, format, blocks, style, lang());
    if (saved) toast(tr()('reference.listSaved'));
  } catch {
    toast(tr()('reference.saveFailed'), retry, true);
  }
}
