import { Plus, Search } from 'lucide-react';
import { useEffect, useState, type RefObject } from 'react';

import { shortcutFor } from '../../actions/registry';
import type { Platform } from '../../api/app';
import { Field, Icon, Tooltip } from '../../components';
import { cx } from '../../components/cx';
import { useT } from '../../i18n';
import { useSettings } from '../../stores/settings';
import { greetingPart } from './homeLayout';

/** True when a key press in this target is typing into something, so `/` must stay a character. */
export function isTypingTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  return target.isContentEditable || target.closest('input, textarea, select, [contenteditable="true"]') !== null;
}

/** `/` focuses the search field while Home shows it (outside any text entry, with no modifier). */
export function useSearchShortcut(field: RefObject<HTMLInputElement | null>, enabled: boolean): void {
  useEffect(() => {
    if (!enabled) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== '/' || event.ctrlKey || event.metaKey || event.altKey || event.defaultPrevented) return;
      if (isTypingTarget(event.target)) return;
      event.preventDefault();
      field.current?.focus();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [field, enabled]);
}

/** The greeting line for the time of day: "{greeting}, {name}." with the author name of the settings, else "{greeting}."; re-evaluated each minute. */
export function useGreeting(): string {
  const t = useT();
  const name = useSettings((state) => state.authorName).trim();
  const [now, setNow] = useState(() => new Date());
  useEffect(() => {
    const timer = window.setInterval(() => setNow(new Date()), 60_000);
    return () => window.clearInterval(timer);
  }, []);
  const greeting = t(`home.greeting.${greetingPart(now)}`);
  return name === '' ? t('home.greeting.plain', { greeting }) : t('home.greeting.named', { greeting, name });
}

export interface HeroProps {
  query: string;
  onQuery: (query: string) => void;
  searchRef: RefObject<HTMLInputElement | null>;
  opening: boolean;
  platform: Platform | null;
  onOpen: () => void;
  /** Enter in the search opens the first hit. */
  onOpenFirst?: () => void;
  /** Tier B with the "Open" row in a short window: the title stays for screen readers only. */
  titleHidden?: boolean;
}

/**
 * The head of Home's main column (DESIGN 3.18 H4): the greeting (20/28 Text-secondary), the display title, the full-width search
 * (48, no key chip; `/` still focuses it) and the round Ink "+" at the end of the greeting row. Text over the glow is Ink.
 */
export function Hero({
  query,
  onQuery,
  searchRef,
  opening,
  platform,
  onOpen,
  onOpenFirst,
  titleHidden = false,
}: HeroProps) {
  const t = useT();
  const greeting = useGreeting();
  const openKey = shortcutFor('open', platform, t);
  return (
    <section aria-label={t('home.hero.label')} data-home-hero="" className="home-hero">
      <p data-home-greeting="" className="home-greeting m-0 text-text-muted">
        {greeting}
      </p>
      <Tooltip label={t('home.open')} shortcut={openKey?.label} side="left">
        <button
          type="button"
          data-home-open=""
          aria-label={t('home.open')}
          aria-keyshortcuts={openKey?.aria}
          aria-busy={opening || undefined}
          aria-disabled={opening || undefined}
          onClick={() => {
            if (!opening) onOpen();
          }}
          className="home-plus flex size-(--home-plus) shrink-0 cursor-pointer items-center justify-center rounded-pill bg-ink text-white transition-[box-shadow,transform] [transition-duration:var(--motion-fast)] not-aria-disabled:hover:shadow-standard not-aria-disabled:active:scale-(--scale-press) aria-disabled:cursor-not-allowed aria-disabled:opacity-(--opacity-disabled)"
        >
          <Icon icon={Plus} size={20} />
        </button>
      </Tooltip>
      <h1 data-home-title="" className={cx('home-title m-0 whitespace-pre-line text-text', titleHidden && 'sr-only')}>
        {t('home.hero.title')}
      </h1>
      <div className="home-search relative">
        <Icon
          icon={Search}
          size={20}
          className="pointer-events-none absolute start-4 top-1/2 -translate-y-1/2 text-text-muted"
        />
        <Field
          ref={searchRef}
          type="search"
          value={query}
          onChange={(event) => onQuery(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'Escape' && query !== '') {
              event.preventDefault();
              event.stopPropagation();
              onQuery('');
            } else if (event.key === 'ArrowDown') {
              // Down leads to the first hit.
              const first = document.querySelector<HTMLElement>(
                '[data-home-body] :is(.home-open-row, .home-card-grid) [data-roving-id]',
              );
              if (first !== null) {
                event.preventDefault();
                first.focus();
              }
            } else if (event.key === 'Enter' && onOpenFirst !== undefined) {
              event.preventDefault();
              onOpenFirst();
            }
          }}
          placeholder={t('home.search.placeholder')}
          aria-label={t('home.search.label')}
          aria-keyshortcuts="/"
          autoComplete="off"
          spellCheck={false}
          className="h-(--home-search-height)! w-full! rounded-md! ps-12! pe-4!"
        />
      </div>
    </section>
  );
}
