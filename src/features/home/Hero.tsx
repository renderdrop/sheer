import { Plus, Search } from 'lucide-react';
import { useEffect, type RefObject } from 'react';

import { shortcutFor } from '../../actions/registry';
import type { Platform } from '../../api/app';
import { Field, Icon, SolarGlow, Tooltip } from '../../components';
import { useT } from '../../i18n';

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

export interface HeroProps {
  query: string;
  onQuery: (query: string) => void;
  searchRef: RefObject<HTMLInputElement | null>;
  opening: boolean;
  platform: Platform | null;
  onOpen: () => void;
  /** Enter in the search opens the first hit. */
  onOpenFirst?: () => void;
}

/**
 * The hero (DESIGN v2 3.1): Sand, radius xl, padding 40, at least 280 high, with the `hero` glow at its corner. The claim in
 * `.t-display`, 24 below it the search field (44 high, at most 480 wide, `/` as key chip), and the round Solar "+" (Open) 24 from
 * the top and the end. Text over the glow is Ink.
 */
export function Hero({ query, onQuery, searchRef, opening, platform, onOpen, onOpenFirst }: HeroProps) {
  const t = useT();
  const openKey = shortcutFor('open', platform, t);
  return (
    <section
      aria-label={t('home.hero.label')}
      data-home-hero=""
      className="relative flex min-h-(--home-hero-min) flex-col justify-center gap-6 overflow-hidden rounded-xl bg-subtle p-10"
    >
      <SolarGlow variant="hero" />
      <h1 className="t-display relative m-0 whitespace-pre-line text-text">{t('home.hero.title')}</h1>
      <div className="relative w-full max-w-(--home-search-max)">
        <Icon
          icon={Search}
          size={18}
          className="pointer-events-none absolute start-3 top-1/2 -translate-y-1/2 text-text-muted"
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
              const first = document.querySelector<HTMLElement>('[data-home-body] .home-card-grid [data-roving-id]');
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
          className="h-control-xl! w-full! ps-10! pe-10!"
        />
        <kbd className="t-caption pointer-events-none absolute end-3 top-1/2 flex h-5 min-w-5 -translate-y-1/2 items-center justify-center rounded-sm border border-border-subtle bg-subtle px-1 font-medium tabular-nums text-text">
          /
        </kbd>
      </div>
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
          className="absolute end-6 top-6 flex size-(--home-plus) cursor-pointer items-center justify-center rounded-pill bg-accent text-on-accent transition-colors [transition-duration:var(--motion-fast)] not-aria-disabled:hover:bg-accent-hover not-aria-disabled:active:scale-(--scale-press) aria-disabled:cursor-not-allowed aria-disabled:opacity-(--opacity-disabled)"
        >
          <Icon icon={Plus} size={20} />
        </button>
      </Tooltip>
    </section>
  );
}
