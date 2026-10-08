import { AnimatePresence } from 'motion/react';
import { useEffect, useId, useMemo, useRef, useState, type ReactNode, type RefObject } from 'react';

import { runAction } from '../../actions/dispatch';
import { shortcutFor } from '../../actions/registry';
import type { Platform } from '../../api/app';
import type { RecentEntry } from '../../api/recents';
import { Button, SolarGlow } from '../../components';
import { cx } from '../../components/cx';
import { useT } from '../../i18n';
import { useDocuments } from '../../stores/documents';
import { useUi } from '../../stores/ui';
import { useViewer } from '../viewer/useViewer';
import { DropOverlay, useHomeDrop } from './DropOverlay';
import { Hero, useSearchShortcut } from './Hero';
import { HomeNav, type HomeSection } from './HomeNav';
import { OpenCard } from './OpenCard';
import { RecentCard } from './RecentCard';
import { filterByName, useHomeRecents, visibleRecents, withoutOpen, type HomeRecents } from './recents';
import { useRovingGroup } from './roving';
import { ToolRows } from './ToolRows';
import './home.css';

interface CardsProps {
  entries: readonly RecentEntry[];
  recents: HomeRecents;
  platform: Platform | null;
  label: string;
  gridRef?: RefObject<HTMLUListElement | null>;
}

/** Columns the grid lays out now, read from the computed template; `fallback` where there is no layout (tests, first paint). */
function useColumns(ref: RefObject<HTMLElement | null>, fallback: number, active: boolean): number {
  const [columns, setColumns] = useState(fallback);
  useEffect(() => {
    const element = ref.current;
    if (element === null || !active) return;
    const measure = () => {
      const tracks = getComputedStyle(element).gridTemplateColumns.split(' ');
      // A laid-out grid resolves to pixel tracks; without layout (tests) it stays unresolved and the fallback holds.
      if (tracks.length > 0 && tracks.every((track) => /^[0-9.]+px$/.test(track))) setColumns(tracks.length);
    };
    measure();
    if (typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => observer.disconnect();
  }, [ref, active]);
  return columns;
}

/** The "Open" section's cards: one grid and one tab stop like the recent ones; click switches to the tab. */
function OpenGrid({ tabs, label }: { tabs: readonly { id: number; name: string }[]; label: string }) {
  const roving = useRovingGroup(tabs.map((tab) => `open-${tab.id}`));
  const switchTo = (id: number) => {
    useDocuments.getState().setActive(id);
    // Activating the tab that is active already changes nothing in the store: leave Home explicitly.
    useUi.getState().setView('editor');
  };
  return (
    <ul {...roving.groupProps} aria-label={label} className="home-open-row m-0 list-none p-0">
      {tabs.map((tab) => (
        <OpenCard
          key={tab.id}
          id={tab.id}
          name={tab.name}
          tabIndex={roving.tabIndexOf(`open-${tab.id}`)}
          onSwitch={switchTo}
        />
      ))}
    </ul>
  );
}

/** The cards as one grid and one tab stop (`repeat(auto-fill, minmax(208px, 1fr))`, gap 16); arrows move in both directions. */
function CardGrid({ entries, recents, platform, label, gridRef }: CardsProps) {
  const roving = useRovingGroup(entries.map((entry) => String(entry.id)));
  return (
    <ul ref={gridRef} {...roving.groupProps} aria-label={label} className="home-card-grid m-0 list-none p-0">
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
      className="relative flex min-h-full flex-1 flex-col items-center justify-center overflow-hidden rounded-xl bg-subtle p-8 text-center"
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
  const ids = { open: useId(), recent: useId(), tools: useId(), view: useId() };
  const [expanded, setExpanded] = useState(false);
  const gridRef = useRef<HTMLUListElement>(null);
  const order = useDocuments((state) => state.order);
  const byId = useDocuments((state) => state.byId);
  const openTabs = useMemo(
    () => order.flatMap((id) => (byId[id] === undefined ? [] : [{ id, name: byId[id].displayName }])),
    [order, byId],
  );

  // Before the first answer there is nothing to show but the empty state, which also keeps its button where it will be.
  const empty = recents.entries.length === 0 && openTabs.length === 0;
  const showEmpty = section === 'home' && empty;
  useSearchShortcut(searchRef, section === 'home' && !empty);

  const matches = useMemo(
    () =>
      withoutOpen(
        filterByName(recents.entries, query),
        openTabs.map((tab) => tab.name),
      ),
    [recents.entries, query, openTabs],
  );
  const openShown = useMemo(() => {
    const needle = query.trim().toLocaleLowerCase();
    return needle === '' ? openTabs : openTabs.filter((tab) => tab.name.toLocaleLowerCase().includes(needle));
  }, [openTabs, query]);
  const columns = useColumns(gridRef, 4, section === 'home' && matches.length > 0);
  const starred = useMemo(() => recents.entries.filter((entry) => entry.starred), [recents.entries]);
  const open = () => void runAction('open');

  let body;
  if (showEmpty) {
    body = <EmptyHome opening={opening} platform={platform} onOpen={open} />;
  } else if (section === 'home') {
    const shown = visibleRecents(matches, columns, expanded);
    const first = openShown.length > 0 ? undefined : shown[0];
    const hasMore = matches.length > columns * 2;
    body = (
      <>
        <Hero
          query={query}
          onQuery={setQuery}
          searchRef={searchRef}
          opening={opening}
          platform={platform}
          onOpen={open}
          onOpenFirst={first === undefined ? undefined : () => recents.open(first, null)}
          compact={!empty}
        />
        {openShown.length > 0 && (
          <section aria-labelledby={ids.open} className="mt-4 flex flex-col gap-2">
            <SectionHead id={ids.open}>{t('home.openTabs')}</SectionHead>
            <OpenGrid tabs={openShown} label={t('home.openList')} />
          </section>
        )}
        {recents.loaded && (
          <section aria-labelledby={ids.recent} className="mt-4 flex flex-col gap-2">
            <SectionHead
              id={ids.recent}
              action={
                hasMore && (
                  <Button variant="ghost" size="sm" aria-expanded={expanded} onClick={() => setExpanded((was) => !was)}>
                    {expanded ? t('home.showLess') : t('home.showAll')}
                  </Button>
                )
              }
            >
              {t('home.nav.recent')}
            </SectionHead>
            {shown.length > 0 ? (
              <CardGrid
                entries={shown}
                recents={recents}
                platform={platform}
                label={t('home.recentList')}
                gridRef={gridRef}
              />
            ) : (
              <p className="t-body m-0 text-text-muted">{t('home.noMatch')}</p>
            )}
          </section>
        )}
        <section aria-labelledby={ids.tools} className="mt-4 flex flex-col gap-3">
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
          <CardGrid entries={list} recents={recents} platform={platform} label={t('home.recentList')} />
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
      <main className="relative min-w-0 flex-auto overflow-auto rounded-ss-xl bg-surface home-main">
        <div
          className={cx(
            'mx-auto flex min-h-full flex-col transition-opacity [transition-duration:var(--motion-base)]',
            showEmpty ? 'w-full' : 'max-w-(--home-content-max)',
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
