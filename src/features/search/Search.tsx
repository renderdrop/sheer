import {
  CaseSensitive,
  ChevronDown,
  ChevronUp,
  CircleAlert,
  Search as SearchIcon,
  SquareSlash,
  WholeWord,
  X,
} from 'lucide-react';
import { memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type KeyboardEvent } from 'react';

import { Button, Field, IconButton } from '../../components';
import { Icon } from '../../components/Icon';
import { cx } from '../../components/cx';
import { tokenPx } from '../../components/tokens';
import { useT } from '../../i18n';
import { selectActiveId, useDocuments } from '../../stores/documents';
import { pageIdAt, pageNumberOf } from '../../stores/pages';
import { useDocViewValue } from '../../stores/view';
import { redactSearchResults } from '../redact/actions';
import { loadLayer } from '../textlayer/cache';
import { f3FindsNext } from './commands';
import { jumpToHit, stepHit } from './jump';
import { buildRows, rowRange } from './rows';
import { snippetFor, type Snippet } from './snippet';
import { SEARCH_MAX_CHARS, SEARCH_MAX_HITS, useSearch, useSearchEntry, type Hit, type SearchEntry } from './store';

/** Rows mounted beyond the viewport on each side. */
export const OVERSCAN_ROWS = 6;
const PAGE_ROW_FALLBACK = 24;
const HIT_ROW_FALLBACK = 48;
/** Pages looked at to tell a document without any text from one without a match. */
const NO_TEXT_SAMPLE_PAGES = 6;

/** Which focus request the field has served, so a panel that mounts because of Find still takes it. */
let servedFocusRequest = 0;

const isPrimary = (event: KeyboardEvent) => event.ctrlKey || event.metaKey;

function Message({ children }: { children: React.ReactNode }) {
  return <div className="flex flex-col items-center gap-2 p-6 text-center">{children}</div>;
}

interface HitRowProps {
  hit: Hit;
  top: number;
  row: number;
  snippet: Snippet | null | undefined;
  active: boolean;
  tabStop: boolean;
  onActivate: (index: number) => void;
}

/** A hit: the text around it, the match in bold on a `--color-selected` fill. Snippets are text nodes only. */
const HitRow = memo(function HitRow({ hit, top, row, snippet, active, tabStop, onActivate }: HitRowProps) {
  const t = useT();
  const page = t('search.page', { n: pageNumberOf(useDocuments.getState().activeId, hit.page) });
  const name = snippet ? `${page}, ${snippet.before}${snippet.match}${snippet.after}` : page;
  return (
    <div
      role="option"
      aria-selected={active}
      aria-label={name}
      data-hit={hit.index}
      data-row={row}
      tabIndex={tabStop ? 0 : -1}
      onClick={() => onActivate(hit.index)}
      className={cx(
        'absolute inset-x-0 box-border flex h-search-row cursor-pointer select-none items-center rounded-sm p-2 text-sm',
        active
          ? 'bg-selected forced-colors:outline-2 forced-colors:outline-[Highlight]'
          : 'hover:bg-subtle active:bg-pressed',
      )}
      style={{ top }}
    >
      <span className="line-clamp-2 min-w-0 break-words">
        {snippet && (
          <>
            {snippet.before}
            <span className="rounded-sm bg-selected font-semibold forced-colors:bg-[Highlight]">{snippet.match}</span>
            {snippet.after}
          </>
        )}
      </span>
    </div>
  );
});

/** The list of hits, grouped by page and virtualized by arithmetic (fixed row heights). */
function HitList({ docId, entry, onFocusField }: { docId: number; entry: SearchEntry; onFocusField: () => void }) {
  const t = useT();
  const { hits, active } = entry;
  const [pageHeight] = useState(() => tokenPx('--control-sm', PAGE_ROW_FALLBACK));
  const [hitHeight] = useState(() => tokenPx('--search-row-height', HIT_ROW_FALLBACK));
  const layout = useMemo(() => buildRows(hits, pageHeight, hitHeight), [hits, pageHeight, hitHeight]);
  const scrollerRef = useRef<HTMLDivElement | null>(null);
  const [box, setBox] = useState(0);
  const [scrollTop, setScrollTop] = useState(0);
  const [focused, setFocused] = useState(-1);
  const pendingFocus = useRef<number | null>(null);
  const [snippets, setSnippets] = useState<{ run: number; byHit: ReadonlyMap<number, Snippet | null> }>({
    run: entry.runId,
    byHit: new Map(),
  });

  useEffect(() => {
    const region = scrollerRef.current;
    if (region === null) return;
    const observer = new ResizeObserver(() => setBox(region.clientHeight));
    observer.observe(region);
    return () => observer.disconnect();
  }, []);

  const range = rowRange(layout.tops, scrollTop, box, OVERSCAN_ROWS);

  // The active hit is brought into view when it changes (a step from the canvas, a key); the user's own scrolling is left alone.
  useLayoutEffect(() => {
    const region = scrollerRef.current;
    const row = active >= 0 ? (layout.rowOfHit[active] ?? -1) : -1;
    if (region === null || row < 0 || box === 0) return;
    const top = layout.tops[row] ?? 0;
    const bottom = layout.tops[row + 1] ?? top;
    if (top < region.scrollTop) region.scrollTop = top;
    else if (bottom > region.scrollTop + region.clientHeight) region.scrollTop = bottom - region.clientHeight;
    setScrollTop(region.scrollTop);
  }, [active, layout, box]);

  // Snippets for the hits on screen: the text layers of their pages, fetched once, and the range found by the quads.
  const first = range === null ? 0 : range.first;
  const last = range === null ? -1 : range.last;
  const wanted = useMemo(() => {
    const list: Hit[] = [];
    for (let row = first; row <= last; row += 1) {
      const entryRow = layout.rows[row];
      if (entryRow?.kind === 'hit') {
        const hit = hits[entryRow.hit];
        if (hit !== undefined) list.push(hit);
      }
    }
    return list;
  }, [first, last, layout, hits]);
  useEffect(() => {
    const known = snippets.run === entry.runId ? snippets.byHit : new Map<number, Snippet | null>();
    const missing = wanted.filter((hit) => !known.has(hit.index));
    if (missing.length === 0) return;
    let current = true;
    const pages = [...new Set(missing.map((hit) => hit.page))];
    void Promise.all(pages.map((page) => loadLayer(docId, page).then((layer) => [page, layer] as const))).then(
      (loaded) => {
        if (!current) return;
        const layers = new Map(loaded);
        setSnippets((previous) => {
          const base = previous.run === entry.runId ? previous.byHit : new Map<number, Snippet | null>();
          const byHit = new Map(base);
          for (const hit of missing) {
            const layer = layers.get(hit.page);
            byHit.set(hit.index, layer ? snippetFor(layer, hit.quads) : null);
          }
          return { run: entry.runId, byHit };
        });
      },
    );
    return () => {
      current = false;
    };
  }, [wanted, docId, entry.runId, snippets]);
  const byHit = snippets.run === entry.runId ? snippets.byHit : undefined;

  const activate = useCallback(
    (index: number) => {
      const hit = useSearch.getState().activate(docId, index);
      setFocused(index);
      if (hit !== null) jumpToHit(docId, hit);
    },
    [docId],
  );

  const reveal = (row: number) => {
    const region = scrollerRef.current;
    if (region === null) return;
    const top = layout.tops[row] ?? 0;
    const bottom = layout.tops[row + 1] ?? top;
    if (top < region.scrollTop) region.scrollTop = top;
    else if (bottom > region.scrollTop + region.clientHeight) region.scrollTop = bottom - region.clientHeight;
    setScrollTop(region.scrollTop);
  };

  const focusHit = (index: number) => {
    const row = layout.rowOfHit[index];
    if (row === undefined) return;
    reveal(row);
    setFocused(index);
    pendingFocus.current = index;
    const element = scrollerRef.current?.querySelector<HTMLElement>(`[data-hit="${index}"]`);
    if (element !== null && element !== undefined) {
      element.focus({ preventScroll: true });
      pendingFocus.current = null;
    }
  };

  // A row that was asked to take the focus and was not mounted yet takes it once it is.
  useLayoutEffect(() => {
    const wantedHit = pendingFocus.current;
    if (wantedHit === null) return;
    const element = scrollerRef.current?.querySelector<HTMLElement>(`[data-hit="${wantedHit}"]`);
    if (element !== null && element !== undefined) {
      element.focus({ preventScroll: true });
      pendingFocus.current = null;
    }
  });

  const onKeyDown = (event: KeyboardEvent<HTMLElement>) => {
    if (event.defaultPrevented || event.altKey) return;
    if (isPrimary(event)) {
      if (event.key.toLowerCase() === 'g') {
        event.preventDefault();
        stepHit(event.shiftKey ? -1 : 1);
      }
      return;
    }
    const item = event.target instanceof Element ? event.target.closest<HTMLElement>('[role="option"]') : null;
    const index = Number(item?.dataset.hit);
    if (item === null || !Number.isInteger(index)) return;
    const last = hits.length - 1;
    switch (event.key) {
      case 'ArrowDown':
        event.preventDefault();
        focusHit(Math.min(last, index + 1));
        break;
      case 'ArrowUp':
        event.preventDefault();
        if (index === 0) onFocusField();
        else focusHit(index - 1);
        break;
      case 'Home':
        event.preventDefault();
        focusHit(0);
        break;
      case 'End':
        event.preventDefault();
        focusHit(last);
        break;
      case 'Enter':
      case ' ':
        event.preventDefault();
        activate(index);
        break;
      default:
    }
  };

  const tabHit = focused >= 0 && focused < hits.length ? focused : active >= 0 ? active : 0;
  const mounted = useMemo(() => {
    const set = new Set<number>();
    if (range !== null) for (let row = range.first; row <= range.last; row += 1) set.add(row);
    const tabRow = layout.rowOfHit[tabHit];
    if (tabRow !== undefined && hits.length > 0) set.add(tabRow);
    return [...set].sort((a, b) => a - b);
  }, [range?.first, range?.last, layout, tabHit, hits.length]); // eslint-disable-line react-hooks/exhaustive-deps

  return (
    <div
      ref={scrollerRef}
      data-search-list=""
      onScroll={(event) => {
        const top = event.currentTarget.scrollTop;
        setScrollTop((previous) => {
          const before = rowRange(layout.tops, previous, box, OVERSCAN_ROWS);
          const after = rowRange(layout.tops, top, box, OVERSCAN_ROWS);
          return before?.first === after?.first && before?.last === after?.last ? previous : top;
        });
      }}
      className="min-h-0 flex-auto overflow-y-auto overflow-x-hidden [overflow-anchor:none] [scrollbar-gutter:stable]"
    >
      <div
        role="listbox"
        aria-label={t('search.label')}
        onKeyDown={onKeyDown}
        onBlur={(event) => {
          if (!(event.relatedTarget instanceof Node && event.currentTarget.contains(event.relatedTarget)))
            setFocused(-1);
        }}
        className="relative"
        style={{ height: layout.tops[layout.tops.length - 1] ?? 0 }}
      >
        {mounted.map((row) => {
          const item = layout.rows[row];
          if (item === undefined) return null;
          const top = layout.tops[row] ?? 0;
          if (item.kind === 'page') {
            return (
              <div
                key={`p${item.page}`}
                role="presentation"
                className="absolute inset-x-0 flex h-control-sm items-center px-2 text-sm font-semibold text-text-muted"
                style={{ top }}
              >
                {t('search.page', { n: pageNumberOf(useDocuments.getState().activeId, item.page) })}
              </div>
            );
          }
          const hit = hits[item.hit];
          if (hit === undefined) return null;
          return (
            <HitRow
              key={hit.index}
              hit={hit}
              top={top}
              row={row}
              snippet={byHit?.get(hit.index)}
              active={active === hit.index}
              tabStop={tabHit === hit.index}
              onActivate={activate}
            />
          );
        })}
      </div>
    </div>
  );
}

/** Whether the document has no text on the pages that were looked at (it is a scan, or empty): "no result" then says why. */
function useHasNoText(docId: number, pageCount: number, entry: SearchEntry): boolean {
  const [state, setState] = useState<{ run: number; none: boolean }>({ run: -1, none: false });
  const wanted = entry.status === 'done' && entry.hits.length === 0 && pageCount > 0;
  useEffect(() => {
    if (!wanted) return;
    let current = true;
    const step = Math.max(1, Math.floor(pageCount / NO_TEXT_SAMPLE_PAGES));
    const pages: number[] = [];
    for (let page = 0; page < pageCount && pages.length < NO_TEXT_SAMPLE_PAGES; page += step) pages.push(page);
    void Promise.all(pages.map((position) => loadLayer(docId, pageIdAt(docId, position) ?? position))).then(
      (layers) => {
        if (current)
          setState({ run: entry.runId, none: layers.every((layer) => layer !== null && layer.text.trim() === '') });
      },
    );
    return () => {
      current = false;
    };
  }, [wanted, docId, pageCount, entry.runId]);
  return wanted && state.run === entry.runId && state.none;
}

/** The status row's visible text: progress while it runs, the count when it is over. */
function statusText(t: ReturnType<typeof useT>, entry: SearchEntry): string {
  if (entry.status === 'running' && entry.progress !== null) {
    return t('search.progress', { i: entry.progress.done, n: entry.progress.total });
  }
  if (entry.hits.length === 0) return '';
  return t(entry.truncated ? 'search.countCapped' : 'search.count', { n: entry.hits.length, p: entry.pageCount });
}

function SearchView({ docId }: { docId: number }) {
  const t = useT();
  const entry = useSearchEntry(docId);
  const pageCount = useDocViewValue(docId, (view) => view.pageCount);
  const inputRef = useRef<HTMLInputElement | null>(null);
  const focusRequest = useSearch((state) => state.focusRequest);
  const noText = useHasNoText(docId, pageCount, entry);

  // Find: the panel is open and the field takes focus with its text selected.
  useEffect(() => {
    if (focusRequest === servedFocusRequest) return;
    servedFocusRequest = focusRequest;
    inputRef.current?.focus();
    inputRef.current?.select();
  }, [focusRequest]);

  const focusField = useCallback(() => inputRef.current?.focus(), []);
  const store = useSearch.getState();
  const hasText = entry.text !== '';
  const hasHits = entry.hits.length > 0;

  const onFieldKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.defaultPrevented || event.nativeEvent.isComposing) return;
    if (event.key === 'Enter') {
      event.preventDefault();
      if (!useSearch.getState().submit(docId)) stepHit(event.shiftKey ? -1 : 1);
    } else if (event.key === 'ArrowDown' && hasHits) {
      event.preventDefault();
      const target = entry.active >= 0 ? entry.active : 0;
      document.querySelector<HTMLElement>(`[data-search-list] [data-hit="${target}"]`)?.focus();
    } else if (event.key === 'Escape' && hasText) {
      // Clears a non-empty field; an empty one leaves Esc to whoever is next.
      event.preventDefault();
      event.stopPropagation();
      store.clear(docId);
    } else if ((isPrimary(event) && event.key.toLowerCase() === 'g') || (event.key === 'F3' && f3FindsNext())) {
      event.preventDefault();
      stepHit(event.shiftKey ? -1 : 1);
    }
  };

  const running = entry.status === 'running';
  const live =
    entry.status === 'done' && hasHits
      ? entry.stepped && entry.active >= 0
        ? t('search.position', {
            i: entry.active + 1,
            n: entry.hits.length,
            p: pageNumberOf(useDocuments.getState().activeId, entry.hits[entry.active]?.page ?? 0),
          })
        : statusText(t, entry)
      : '';
  const percent =
    entry.progress !== null && entry.progress.total > 0
      ? Math.round((entry.progress.done / entry.progress.total) * 100)
      : 0;

  let body: React.ReactNode;
  if (entry.status === 'failed') {
    body = (
      <Message>
        <div role="alert" className="flex flex-col items-center gap-2">
          <Icon icon={CircleAlert} className="text-error-text" />
          <span className="text-md">{t('search.error')}</span>
        </div>
        <Button size="sm" onClick={() => store.retry(docId)}>
          {t('search.retry')}
        </Button>
      </Message>
    );
  } else if (hasHits) {
    body = <HitList docId={docId} entry={entry} onFocusField={focusField} />;
  } else if (entry.status === 'done') {
    body = noText ? (
      <Message>
        <span className="text-md">{t('search.noText')}</span>
      </Message>
    ) : (
      <Message>
        <span className="text-md font-semibold">{t('search.none', { q: entry.ran })}</span>
        <span className="text-sm text-text-muted">{t('search.noneHint')}</span>
      </Message>
    );
  } else if (!hasText) {
    body = (
      <Message>
        <span className="flex size-control-md items-center justify-center rounded-sm bg-tile text-tile-icon">
          <Icon icon={SearchIcon} />
        </span>
        <span className="text-md font-semibold">{t('search.empty')}</span>
        <span className="text-sm text-text-muted">{t('search.emptyHint')}</span>
      </Message>
    );
  } else {
    body = null;
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col px-3">
      <div className="relative shrink-0">
        <span className="pointer-events-none absolute inset-y-0 start-2 flex items-center text-text-muted">
          <Icon icon={SearchIcon} />
        </span>
        <Field
          ref={inputRef}
          role="searchbox"
          type="text"
          value={entry.text}
          maxLength={SEARCH_MAX_CHARS}
          autoComplete="off"
          spellCheck={false}
          aria-label={t('search.label')}
          placeholder={t('search.placeholder')}
          onChange={(event) => store.setText(docId, event.target.value)}
          onKeyDown={onFieldKeyDown}
          className="w-full! ps-8! pe-8!"
        />
        {hasText && (
          <span className="absolute inset-y-0 end-1 flex items-center">
            <IconButton
              size="sm"
              icon={X}
              label={t('search.clear')}
              tabIndex={-1}
              onClick={() => {
                store.clear(docId);
                inputRef.current?.focus();
              }}
            />
          </span>
        )}
      </div>
      <div className="mt-2 flex shrink-0 gap-1">
        <IconButton
          size="sm"
          variant="toggle"
          icon={CaseSensitive}
          label={t('search.matchCase')}
          pressed={entry.matchCase}
          onClick={() => store.setOptions(docId, { matchCase: !entry.matchCase })}
        />
        <IconButton
          size="sm"
          variant="toggle"
          icon={WholeWord}
          label={t('search.wholeWord')}
          pressed={entry.wholeWord}
          onClick={() => store.setOptions(docId, { wholeWord: !entry.wholeWord })}
        />
        <span className="ms-auto flex gap-1">
          {hasHits && (
            <IconButton
              size="sm"
              icon={SquareSlash}
              label={t('redact.searchAll')}
              onClick={() => void redactSearchResults(docId)}
            />
          )}
          <IconButton
            size="sm"
            icon={ChevronUp}
            label={t('search.previous')}
            disabled={!hasHits}
            focusableWhenDisabled
            onClick={() => stepHit(-1)}
          />
          <IconButton
            size="sm"
            icon={ChevronDown}
            label={t('search.next')}
            disabled={!hasHits}
            focusableWhenDisabled
            onClick={() => stepHit(1)}
          />
        </span>
      </div>
      <div className="relative flex min-h-control-md shrink-0 items-center gap-1 py-1 text-sm text-text-muted">
        <span aria-hidden="true" className="min-w-0 flex-1 break-words tabular-nums">
          {statusText(t, entry)}
        </span>
        <span role="status" className="sr-only">
          {live}
        </span>
        {running && entry.progress !== null && (
          <div
            aria-hidden="true"
            className="absolute inset-x-0 bottom-0 h-search-progress overflow-hidden rounded-pill bg-track"
          >
            <div className="h-full rounded-pill bg-accent" style={{ width: `${percent}%` }} />
          </div>
        )}
      </div>
      {body}
    </div>
  );
}

/** The Search tab's content (DESIGN 3.16). Another document is another search: its query, hits and scroll are its own. */
export function SearchPanel() {
  const t = useT();
  const docId = useDocuments(selectActiveId);
  if (docId === null) return <p className="m-0 text-sm text-text-muted">{t('leftPanel.empty.search')}</p>;
  return <SearchView key={docId} docId={docId} />;
}

export { SEARCH_MAX_HITS };
