import { createRoot, type Root } from 'react-dom/client';

import { translators } from '../../i18n';
import { useLocaleStore } from '../../i18n/store';
import { LinkPreview, KEY_MARK, splitHint } from './LinkPreview';

/**
 * Dev only (surface gate, DESIGN 3.11 L13): shows the link preview once, next to a stand-in run, with the longest body Rust sends (280
 * characters) so the gate can check that it fits and overlaps nothing. `src/dev/surfaces.ts` is its only caller.
 */
const LONGEST_BODY =
  'Die Verfügbarkeit der Daten hängt von der Qualität der Quellen ab, und die Ergebnisse der Untersuchung lassen sich nur dann ' +
  'verallgemeinern, wenn die Stichprobe die Grundgesamtheit hinreichend abbildet; darauf weisen mehrere der zitierten Arbeiten ' +
  'ausdrücklich hin, zuletzt in der Übersicht von 2019, die zugleich die Grenzen der Methode benennt und weitere Studien fordert …';

let host: HTMLElement | null = null;
let anchor: HTMLElement | null = null;
let root: Root | null = null;

export function openDevPreview(): void {
  closeDevPreview();
  const t = translators[useLocaleStore.getState().locale];
  anchor = document.createElement('span');
  anchor.setAttribute('data-dev-link-run', '');
  Object.assign(anchor.style, { position: 'fixed', left: '320px', top: '220px', width: '40px', height: '16px' });
  host = document.createElement('div');
  document.body.append(anchor, host);
  const hint = splitHint(t('smartlinks.previewHint', { back: KEY_MARK }));
  root = createRoot(host);
  root.render(
    <LinkPreview
      open
      id="dev-link-preview"
      anchor={anchor}
      detected={t('smartlinks.detected')}
      kind={t('smartlinks.kind.reference')}
      page={`${t('citation.page', { label: String(12) })} ${t('smartlinks.physical', { n: 14 })}`}
      body={LONGEST_BODY.slice(0, 280)}
      hintBefore={hint.before}
      hintKey="Alt+←"
      hintAfter={hint.after}
    />,
  );
}

export function closeDevPreview(): void {
  root?.unmount();
  root = null;
  anchor?.remove();
  host?.remove();
  anchor = null;
  host = null;
}
