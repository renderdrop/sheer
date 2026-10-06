import { AnimatePresence } from 'motion/react';
import { createRoot, type Root } from 'react-dom/client';

import { translators } from '../../i18n';
import { useLocaleStore } from '../../i18n/store';
import { LinkPreview, KEY_MARK, splitHint } from './LinkPreview';
import { RangeChooser } from './RangeChooser';

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

/** The longest entry text Rust sends a choice (120 characters), in German as the widest case. */
const LONGEST_ENTRY =
  'Müller, A. & Schmidt, B. (2019). Verfügbarkeit und Qualität von Daten in der Praxis der empirischen Forschung. Journal 4, 1–10.';

let chooserHost: HTMLElement | null = null;
let chooserAnchor: HTMLElement | null = null;
let chooserRoot: Root | null = null;

/**
 * Dev only (surface gate, DESIGN 3.11 L13): the range chooser with `count` rows, next to a stand-in run. `place`: `top` (room below),
 * `bottom` (near the page's bottom edge, so it flips to top-start) or `end` (the list scrolled to its end).
 */
export function openDevChooser(count: number, place: 'top' | 'bottom' | 'end'): void {
  closeDevChooser();
  const t = translators[useLocaleStore.getState().locale];
  chooserAnchor = document.createElement('span');
  chooserAnchor.setAttribute('data-dev-link-run', '');
  Object.assign(chooserAnchor.style, {
    position: 'fixed',
    left: '320px',
    top: place === 'bottom' ? `${window.innerHeight - 56}px` : '220px',
    width: '40px',
    height: '16px',
  });
  chooserHost = document.createElement('div');
  document.body.append(chooserAnchor, chooserHost);
  const rows = Array.from({ length: count }, (_, i) => ({
    number: i + 1,
    preview: LONGEST_ENTRY.slice(0, 120),
    page: t('citation.page', { label: String(12 + i) }),
    name: t('smartlinks.aria.rangeEntry', { number: i + 1, page: 12 + i }),
  }));
  chooserRoot = createRoot(chooserHost);
  chooserRoot.render(
    <AnimatePresence>
      <RangeChooser
        key="dev"
        anchor={chooserAnchor}
        range={`1–${count}`}
        rows={rows}
        onChoose={closeDevChooser}
        onClose={closeDevChooser}
      />
    </AnimatePresence>,
  );
  if (place === 'end') {
    window.setTimeout(() => {
      const list = document.querySelector<HTMLElement>('[data-surface="range-chooser"] [role="listbox"]');
      if (list !== null) list.scrollTop = list.scrollHeight;
    }, 300);
  }
}

export function closeDevChooser(): void {
  chooserRoot?.unmount();
  chooserRoot = null;
  chooserAnchor?.remove();
  chooserHost?.remove();
  chooserAnchor = null;
  chooserHost = null;
}
