import { openLink } from '../../api/links';
import type { SmartLink } from '../../api/smartLinks';
import { currentPlatform } from '../../actions/keys';
import { formatBinding } from '../../actions/shortcut';
import { announce } from '../../components';
import { translators, type Translate } from '../../i18n';
import { useLocaleStore } from '../../i18n/store';
import { selectActiveId, useDocuments } from '../../stores/documents';
import { pageNumberOf } from '../../stores/pages';
import { pageLabelOf } from '../comments/pageLabel';
import { jumpTo } from '../history';
import { historyBinding } from '../history/actions';
import { type PageLink, visitKey } from './model';
import { smartLinksOn, useSmartLinks } from './store';

/** The label a page is shown with (the file's page label, else its number) and its physical number. */
export function pageNames(docId: number, pageId: number): { label: string; physical: number } {
  return { label: pageLabelOf(docId, pageId), physical: pageNumberOf(docId, pageId) };
}

/** The key that goes back, as it is shown for this platform (Alt+Left, or Cmd+[). */
export function backKeyLabel(t: Translate): string {
  const platform = currentPlatform();
  return formatBinding(historyBinding('back', platform), platform, t).label;
}

/**
 * Follows a link of a page (DESIGN 3.11 L6): a smart link marks itself visited and jumps (the history, the scroll, the band and the
 * announcement are the jump's); a real link to a page jumps the same way; a web or mail link goes through the backend, which asks the
 * user (SECURITY P2); a link the app does not follow does nothing.
 */
export function followLink(docId: number, pageId: number, item: PageLink): void {
  if (item.type === 'smart') {
    const { link } = item;
    useSmartLinks.getState().markVisited(docId, visitKey(link));
    jumpTo(docId, link.target, { pageId, rect: link.rects[0]! });
    return;
  }
  const { info } = item;
  if (info.target.type === 'page') {
    jumpTo(docId, { pageId: info.target.pageId }, { pageId, rect: info.rect });
  } else if (info.target.type === 'url') {
    void openLink(docId, pageId, info.index).catch(() => undefined);
  }
}

/** Follows one choice of a range run (L14): the same as following a link, with the range run as the origin of the history entry. */
export function followChoice(docId: number, pageId: number, link: SmartLink, number: number): void {
  const choice = link.choices?.find((candidate) => candidate.number === number);
  if (choice === undefined) return;
  useSmartLinks.getState().markVisited(docId, visitKey(link));
  jumpTo(docId, choice.target, { pageId, rect: link.rects[0]! });
}

function say(key: 'smartlinks.announce.on' | 'smartlinks.announce.off'): void {
  announce(translators[useLocaleStore.getState().locale](key));
}

/** The quick toggle (the Lesen slot, the Ansicht item): this tab only, announced. */
export function toggleSmartLinksForActive(): void {
  const docId = selectActiveId(useDocuments.getState());
  if (docId === null) return;
  const state = useSmartLinks.getState();
  const next = !smartLinksOn(state, docId);
  state.setForDoc(docId, next);
  say(next ? 'smartlinks.announce.on' : 'smartlinks.announce.off');
}

/** Settings: every tab, the per-tab overrides cleared. */
export function setSmartLinksEverywhere(on: boolean): void {
  useSmartLinks.getState().setEnabled(on);
  say(on ? 'smartlinks.announce.on' : 'smartlinks.announce.off');
}
