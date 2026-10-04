import { AnimatePresence } from 'motion/react';
import { useId, useMemo, useRef, useState, type ReactNode } from 'react';

import { runAction } from '../../actions/dispatch';
import { shortcutFor } from '../../actions/registry';
import type { Platform } from '../../api/app';
import type { RecentEntry } from '../../api/recents';
import { Button, SolarGlow } from '../../components';
import { cx } from '../../components/cx';
import { useT } from '../../i18n';
import { useViewer } from '../viewer/useViewer';
import { DropOverlay, useHomeDrop } from './DropOverlay';
import { Hero, useSearchShortcut } from './Hero';
import { HomeNav, type HomeSection } from './HomeNav';
import { RecentCard } from './RecentCard';
import { filterByName, HOME_RECENT_LIMIT, useHomeRecents, type HomeRecents } from './recents';
import { useRovingGroup } from './roving';
import { ToolRows } from './ToolRows';
import './home.css';

interface CardsProps {
  entries: readonly RecentEntry[];
  recents: HomeRecents;
  platform: Platform | null;
  label: string;
}

/** The cards as one grid and one tab stop (`repeat(auto-fill, minmax(208px, 1fr))`, gap 16); arrows move in both directions. */
function CardGrid({ entries, recents, platform, label }: CardsProps) {
  const roving = useRovingGroup(entries.map((entry) => String(entry.id)));
  return (
    <ul {...roving.groupProps} aria-label={label} className="home-card-grid m-0 list-none p-0">
      {entries.map((entry) => (
        <RecentCard
          key={entry.id}
          entry={entry}
          now={recents.now}
          platform={platform}
          tabIndex={roving.tabIndexOf(String(entry.id))}
          onOpen={recents.open}
          onToggleStar={recents.toggleStar}
          onReveal={recents.reveal}
          onRemove={recents.remove}
        />
      ))}
    </ul>
  );
}

/** A heading row: the title and, at the end, an optional action. */
function SectionHead({ id, children, action }: { id: string; children: string; action?: ReactNode }) {
  return (
    <div className="flex items-center justify-between gap-4">
      <h2 id={id} className="t-title m-0">
        {children}
      </h2>
      {action}
    </div>
  );
}

/** The empty state (nothing was ever opened): one Sand area, radius xl, the `empty` glow, the claim and a Ghost "Oder öffnen". */
function EmptyHome({ opening, platform, onOpen }: { opening: boolean; platform: Platform | null; onOpen: () => void }) {
  const t = useT();
  return (
    <section
      aria-label={t('home.empty.title')}
      data-home-empty=""
      className="relative flex min-h-full flex-col items-center justify-center overflow-hidden rounded-xl bg-subtle p-10 text-center"
    >
      <SolarGlow variant="empty" />
      <h1 className="t-display relative m-0 text-text">{t('home.empty.title')}</h1>
      <div className="relative mt-8">
        <Button
          variant="ghost"
          size="lg"
          autoFocus
          aria-keyshortcuts={shortcutFor('open', platform, t)?.aria}
          aria-busy={opening || undefined}
          onClick={onOpen}
        >
          {t('home.empty.open')}
        </Button>
      </div>
    </section>
  );
}

export interface HomeProps {
  platform: Platform | null;
}

/**
 * Home's body (DESIGN v2 3.1): the nav and the main column. The sections Home, Zuletzt, Markiert and Werkzeuge are views of one
 * page; Home is the hero with the first 12 recent files and the tools, the others a heading with their list. A fresh install (no
 * recent files at all) shows the empty state instead. While a file is dragged over the window the drop card shows over the main column.
 */
export function Home({ platform }: HomeProps) {
  const t = useT();
  const recents = useHomeRecents();
  const opening = useViewer((state) => state.opening);
  const drop = useHomeDrop();
  const [section, setSection] = useState<HomeSection>('home');
  const [query, setQuery] = useState('');
  const searchRef = useRef<HTMLInputElement>(null);
  const ids = { recent: useId(), tools: useId(), view: useId() };

  // Before the first answer there is nothing to show but the empty state, which also keeps its button where it will be.
  const empty = recents.entries.length === 0;
  const showEmpty = section === 'home' && empty;
  useSearchShortcut(searchRef, section === 'home' && !empty);

  const matches = useMemo(() => filterByName(recents.entries, query), [recents.entries, query]);
  const starred = useMemo(() => recents.entries.filter((entry) => entry.starred), [recents.entries]);
  const open = () => void runAction('open');

  let body;
  if (showEmpty) {
    body = <EmptyHome opening={opening} platform={platform} onOpen={open} />;
  } else if (section === 'home') {
    const shown = matches.slice(0, HOME_RECENT_LIMIT);
    body = (
      <>
        <Hero
          query={query}
          onQuery={setQuery}
          searchRef={searchRef}
          opening={opening}
          platform={platform}
          onOpen={open}
        />
        {recents.loaded && (
          <section aria-labelledby={ids.recent} className="mt-10 flex flex-col gap-4">
            <SectionHead
              id={ids.recent}
              action={
                matches.length > HOME_RECENT_LIMIT && (
                  <Button variant="ghost" size="sm" onClick={() => setSection('recent')}>
                    {t('home.showAll')}
                  </Button>
                )
              }
            >
              {t('home.nav.recent')}
            </SectionHead>
            {shown.length > 0 ? (
              <CardGrid entries={shown} recents={recents} platform={platform} label={t('emptyState.recentList')} />
            ) : (
              <p className="t-body m-0 text-text-muted">{t('home.noMatch')}</p>
            )}
          </section>
        )}
        <section aria-labelledby={ids.tools} className="mt-10 flex flex-col gap-4">
          <SectionHead id={ids.tools}>{t('home.nav.tools')}</SectionHead>
          <ToolRows />
        </section>
      </>
    );
  } else {
    const list = section === 'starred' ? starred : recents.entries;
    body = (
      <section aria-labelledby={ids.view} className="flex flex-col gap-6">
        <h1 id={ids.view} className="t-h2 m-0">
          {section === 'tools'
            ? t('home.nav.tools')
            : section === 'starred'
              ? t('home.nav.starred')
              : t('home.nav.recent')}
        </h1>
        {section === 'tools' ? (
          <ToolRows />
        ) : list.length > 0 ? (
          <CardGrid entries={list} recents={recents} platform={platform} label={t('emptyState.recentList')} />
        ) : (
          <p className="t-body m-0 text-text-muted">
            {recents.loaded ? (section === 'starred' ? t('home.empty.starred') : t('home.empty.recent')) : ''}
          </p>
        )}
      </section>
    );
  }

  return (
    <div data-home-body="" className="relative flex min-h-0 flex-auto">
      <HomeNav section={section} onSection={setSection} />
      <main className="relative min-w-0 flex-auto overflow-auto rounded-ss-xl bg-surface-solid home-main">
        <div
          className={cx(
            'mx-auto flex min-h-full max-w-(--home-content-max) flex-col transition-opacity [transition-duration:var(--motion-base)]',
            drop.shown ? 'opacity-0' : 'opacity-100',
          )}
          inert={drop.shown || undefined}
        >
          {body}
        </div>
        <AnimatePresence>{drop.shown && <DropOverlay falling={drop.falling} />}</AnimatePresence>
      </main>
    </div>
  );
}
