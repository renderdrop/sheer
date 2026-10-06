import { AnimatePresence } from 'motion/react';
import {
  memo,
  useCallback,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type KeyboardEvent,
} from 'react';

import type { SmartLink } from '../../api/smartLinks';
import type { Rect } from '../../api/wire';
import { tokenMs } from '../../components/glide';
import { useT, type Translate } from '../../i18n';
import { pageRevOf, useAnnotations } from '../../stores/annotations';
import { useUi } from '../../stores/ui';
import { maybeShowSmartLinksTip } from '../tips/runtime';
import { useTour } from '../tour/store';
import { fileRotationOf } from '../viewer/fileRotation';
import { useEffectiveTool } from '../viewer/lesen';
import type { PageLayerProps } from '../viewer/pageLayer';
import { normalizeRotation, overlayBox, swapsSides, totalRotation, unrotatedSize } from '../viewer/transform';
import { backKeyLabel, followChoice, followLink, pageNames } from './actions';
import { usePageSmartLinks } from './cache';
import { useTrackSelectionDrag } from './drag';
import { KEY_MARK, LinkPreview, splitHint } from './LinkPreview';
import {
  cueRects,
  hostOf,
  isDrag,
  isRange,
  kindKey,
  linksLive,
  pageLinks,
  pointerHit,
  runRects,
  stepFrom,
  type Box,
  visitKey,
  type PageLink,
} from './model';
import { RangeChooser, type ChooserClose, type ChooserRow } from './RangeChooser';
import { usePageRealLinks } from './realLinks';
import { smartLinksOn, useSmartLinks } from './store';

export interface SmartLinkLayerProps extends PageLayerProps {
  /** The page's own revision (a rotation raises it): part of what the links were detected for. */
  slotRev: number;
}

/** The canvas's scroller: where Esc in a list returns focus. */
const CANVAS_SCROLLER = '[data-action-scope="canvas"] > [role="region"]';
const LIST = '[data-links-list]';
const PREVIEW_FALLBACK_MS = 400;

/** The union of rectangles. */
function unionOf(rects: readonly Rect[]): Rect {
  const first = rects[0] ?? { x: 0, y: 0, w: 0, h: 0 };
  let [x0, y0, x1, y1] = [first.x, first.y, first.x + first.w, first.y + first.h];
  for (const r of rects) {
    x0 = Math.min(x0, r.x);
    y0 = Math.min(y0, r.y);
    x1 = Math.max(x1, r.x + r.w);
    y1 = Math.max(y1, r.y + r.h);
  }
  return { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
}

function runsOfItem(item: PageLink): Rect[] {
  return item.type === 'smart' ? runRects(item.link) : [item.info.rect];
}

function cuesOfItem(item: PageLink): Rect[] {
  return item.type === 'smart' ? cueRects(item.link) : [];
}

/** The page names of a smart link's target: the number printed at the link (a contents line, a page reference) wins over the file's own label. */
function targetNames(docId: number, link: SmartLink): { label: string; physical: number } {
  const names = pageNames(docId, link.target.pageId);
  return { label: link.target.label ?? names.label, physical: names.physical };
}

/** The name of a link (L11): a smart link by kind, marker and target page; a real one by its target. */
function nameOf(t: Translate, docId: number, item: PageLink): string {
  if (item.type === 'real') {
    const { target } = item.info;
    if (target.type === 'page') return t('link.aria.page', { page: pageNames(docId, target.pageId).label });
    if (target.type === 'url') return t('link.aria.url', { host: hostOf(target.url) });
    return t('link.aria.blocked');
  }
  const { link } = item;
  const page = targetNames(docId, link).label;
  switch (link.kind) {
    case 'footnote':
      return t('smartlinks.aria.footnote', { marker: link.marker, page });
    case 'noteBack':
      return t('smartlinks.aria.noteBack', { marker: link.marker, page });
    case 'contents':
      return t('smartlinks.aria.contents', { title: link.marker, page });
    case 'reference':
      return t('smartlinks.aria.reference', { text: link.marker, page });
    case 'literature':
      if (isRange(link)) return t('smartlinks.aria.range', { range: link.marker, n: link.choices?.length ?? 0 });
      return t('smartlinks.aria.literature', { text: link.marker, page });
  }
}

/** The rows of a range chooser: number, entry, target page and the option's name (L14). */
function rowsOf(t: Translate, docId: number, link: SmartLink): ChooserRow[] {
  return (link.choices ?? []).map((choice) => {
    const { label } = pageNames(docId, choice.target.pageId);
    return {
      number: choice.number,
      preview: choice.preview,
      page: t('citation.page', { label }),
      name: t('smartlinks.aria.rangeEntry', { number: choice.number, page: label }),
    };
  });
}

/** The text a screen reader gets for a link: the same as the preview card (kind, page, body). */
function previewText(t: Translate, docId: number, item: PageLink & { type: 'smart' }): string {
  const { link } = item;
  if (isRange(link)) {
    return [
      t('smartlinks.detected'),
      t(kindKey(link.kind)),
      t('smartlinks.range.count', { n: link.choices?.length ?? 0 }),
    ].join(' · ');
  }
  const { label, physical } = targetNames(docId, link);
  const page = pageLine(t, label, physical);
  return [t('smartlinks.detected'), t(kindKey(link.kind)), page, link.preview]
    .filter((part) => part !== '')
    .join(' · ');
}

/** "p. 12" and, when the file's own number differs, "(page 14 of the file)". */
function pageLine(t: Translate, label: string, physical: number): string {
  const page = t('citation.page', { label });
  return label === String(physical) ? page : `${page} ${t('smartlinks.physical', { n: physical })}`;
}

interface Shown {
  key: string;
  el: HTMLElement;
}

/**
 * The links of a page, real and smart, over the text layer and under the annotations (DESIGN 3.11 L3 to L5, L9, L11). One
 * `role="list"` with one Tab stop (a roving tabindex), arrow keys inside; each link is a `role="link"` whose boxes are drawn in page
 * space. The boxes take no pointer themselves: the layer tests the pointer against them (grown to at least 24 x 24 CSS px), so a press
 * that moves 4 px or more is an ordinary text selection and a click follows. Smart links come from Rust for pages in the render
 * window, only while links are on for the tab and the tool, mode and moment let them be live (L9).
 */
export const SmartLinkLayer = memo(function SmartLinkLayer({
  docId,
  pageIndex,
  boxWidth,
  boxHeight,
  widthPt,
  heightPt,
  rotation: rotationProp,
  ready,
  slotRev,
}: SmartLinkLayerProps) {
  const t = useT();
  const baseId = useId();
  const root = useRef<HTMLDivElement>(null);
  const tool = useEffectiveTool();
  const redactMode = useUi((state) => state.redactMode);
  const tourRunning = useTour((state) => state.docId === docId);
  const selecting = useTrackSelectionDrag();
  const live = linksLive({ tool, redactMode, tourRunning, selecting });
  const smartOn = useSmartLinks((state) => smartLinksOn(state, docId));
  const visited = useSmartLinks((state) => state.visited[docId]);
  const docRev = useAnnotations((state) => state.byDoc[docId]?.rev ?? 0);
  const pageRev = useAnnotations((state) => pageRevOf(state, docId, pageIndex));
  const stamp = `${docRev}:${pageRev}:${slotRev}`;
  // What the tool and the moment allow decides what is asked for; links of another stamp are never shown.
  const smart = usePageSmartLinks(docId, pageIndex, stamp, ready && live && smartOn);
  const real = usePageRealLinks(docId, pageIndex, stamp, ready && live);
  const items = useMemo(() => pageLinks(smart, real), [smart, real]);

  const keyFocused = useRef<string | null>(null);
  const [hover, setHover] = useState<string | null>(null);
  const [pressed, setPressed] = useState<string | null>(null);
  const [tabStop, setTabStop] = useState<string | null>(null);
  const [shown, setShown] = useState<Shown | null>(null);
  // The open range chooser (L14): which link, its run, and what it was opened for. Any change of these closes it (stale = never shown).
  const [chooser, setChooser] = useState<{ key: string; el: HTMLElement; stamp: string; width: number } | null>(null);
  const chooserRef = useRef(chooser);
  const itemsRef = useRef(items);
  useEffect(() => {
    itemsRef.current = items;
    chooserRef.current = chooser;
  });
  const chooserOpen =
    chooser !== null &&
    live &&
    smartOn &&
    chooser.stamp === stamp &&
    chooser.width === boxWidth &&
    items.some((item) => item.key === chooser.key);
  // Stale for another tool, revision or zoom: dropped while rendering, so it can never come back when the cause goes away.
  if (chooser !== null && !chooserOpen) setChooser(null);

  const rotation = normalizeRotation(rotationProp);
  const file = fileRotationOf(docId, pageIndex);
  const page = unrotatedSize([widthPt, heightPt], file);
  const shownWidthPt = swapsSides(rotation) ? heightPt : widthPt;
  const pxPerPt = shownWidthPt > 0 ? boxWidth / shownWidthPt : 1;
  const box = overlayBox(boxWidth, boxHeight, page, pxPerPt, totalRotation(file, rotation));

  const idOf = (key: string) => `${baseId}-${key}`;
  const follow = useCallback(
    (key: string) => {
      const item = itemsRef.current.find((candidate) => candidate.key === key);
      if (item === undefined) return;
      if (item.type === 'smart' && isRange(item.link)) {
        // A range run opens its chooser (a second press closes it) instead of following.
        const el = root.current?.querySelector<HTMLElement>(`[data-link-key="${key}"] [data-smartlink-run]`) ?? null;
        setShown(null);
        setChooser(chooserRef.current?.key === key || el === null ? null : { key, el, stamp, width: boxWidth });
        return;
      }
      followLink(docId, pageIndex, item);
    },
    [docId, pageIndex, stamp, boxWidth],
  );
  const closeChooser = useCallback((reason: ChooserClose) => {
    const key = chooserRef.current?.key;
    setChooser(null);
    if (reason !== 'escape' && reason !== 'tab') return;
    // Esc and Tab return to the run, which is still inside the page's link list.
    if (key !== undefined)
      root.current?.querySelector<HTMLElement>(`[data-link-key="${key}"]`)?.focus({ preventScroll: true });
  }, []);
  const choose = useCallback(
    (number: number) => {
      const item = itemsRef.current.find((candidate) => candidate.key === chooserRef.current?.key);
      setChooser(null);
      if (item?.type === 'smart') followChoice(docId, pageIndex, item.link, number);
    },
    [docId, pageIndex],
  );

  // The pointer: hover, press, click. Geometry, not DOM events of the links, so the text under them stays selectable.
  const hasItems = items.length > 0;
  useEffect(() => {
    const surface = root.current?.closest<HTMLElement>('[data-page]') ?? null;
    if (surface === null || !hasItems || !live) return;
    let timer: number | undefined;
    let current: string | null = null;
    let press: { key: string; x: number; y: number } | null = null;

    const pieces = (): { key: string; el: HTMLElement; box: Box }[] => {
      const found: { key: string; el: HTMLElement; box: Box }[] = [];
      for (const link of root.current?.querySelectorAll<HTMLElement>('[data-link-key]') ?? []) {
        const key = link.dataset.linkKey ?? '';
        for (const run of link.querySelectorAll<HTMLElement>('[data-smartlink-run]')) {
          const r = run.getBoundingClientRect();
          found.push({ key, el: run, box: { left: r.left, top: r.top, right: r.right, bottom: r.bottom } });
        }
      }
      return found;
    };
    const hitAt = (x: number, y: number) => {
      const all = pieces();
      const at = pointerHit(
        all.map((piece) => piece.box),
        x,
        y,
      );
      return at < 0 ? null : (all[at] ?? null);
    };
    const setCurrent = (key: string | null, el: HTMLElement | null) => {
      if (key === current) return;
      current = key;
      window.clearTimeout(timer);
      setHover(key);
      if (key === null || el === null) {
        surface.removeAttribute('data-link-hover');
        setShown((previous) => (previous !== null && previous.key !== keyFocused.current ? null : previous));
        return;
      }
      surface.setAttribute('data-link-hover', '');
      const item = itemsRef.current.find((candidate) => candidate.key === key);
      if (item?.type !== 'smart') return;
      void maybeShowSmartLinksTip();
      timer = window.setTimeout(
        () => {
          // While its chooser is open the run's preview stays closed (L14).
          if (chooserRef.current?.key !== key) setShown({ key, el });
        },
        tokenMs('--tooltip-delay', PREVIEW_FALLBACK_MS),
      );
    };

    const onMove = (event: PointerEvent) => {
      if (press !== null) {
        if (isDrag(press, { x: event.clientX, y: event.clientY })) {
          press = null;
          setPressed(null);
        }
        return;
      }
      if (event.buttons !== 0) return;
      const hit = hitAt(event.clientX, event.clientY);
      setCurrent(hit?.key ?? null, hit?.el ?? null);
    };
    const onLeave = () => {
      if (press === null) setCurrent(null, null);
    };
    const onDown = (event: PointerEvent) => {
      if (event.button !== 0 || event.ctrlKey || event.metaKey || event.altKey || event.shiftKey) return;
      const hit = hitAt(event.clientX, event.clientY);
      if (hit === null) return;
      press = { key: hit.key, x: event.clientX, y: event.clientY };
      setPressed(hit.key);
      window.clearTimeout(timer);
      setShown(null);
    };
    const onUp = (event: PointerEvent) => {
      const started = press;
      press = null;
      setPressed(null);
      if (started === null || event.button !== 0) return;
      const hit = hitAt(event.clientX, event.clientY);
      if (hit?.key === started.key && !isDrag(started, { x: event.clientX, y: event.clientY })) follow(started.key);
    };
    const onCancel = () => {
      press = null;
      setPressed(null);
    };
    const onScroll = () => {
      window.clearTimeout(timer);
      current = null;
      setHover(null);
      setShown((previous) => (previous !== null && previous.key !== keyFocused.current ? null : previous));
    };

    surface.addEventListener('pointermove', onMove);
    surface.addEventListener('pointerleave', onLeave);
    surface.addEventListener('pointerdown', onDown);
    surface.addEventListener('pointerup', onUp);
    surface.addEventListener('pointercancel', onCancel);
    document.addEventListener('scroll', onScroll, { capture: true, passive: true });
    return () => {
      surface.removeEventListener('pointermove', onMove);
      surface.removeEventListener('pointerleave', onLeave);
      surface.removeEventListener('pointerdown', onDown);
      surface.removeEventListener('pointerup', onUp);
      surface.removeEventListener('pointercancel', onCancel);
      document.removeEventListener('scroll', onScroll, { capture: true });
      window.clearTimeout(timer);
      surface.removeAttribute('data-link-hover');
      setHover(null);
      setPressed(null);
      setShown(null);
    };
  }, [hasItems, live, follow]);

  const focusLink = (el: Element | null | undefined) => {
    if (el instanceof HTMLElement) {
      el.focus();
      el.scrollIntoView?.({ block: 'nearest', inline: 'nearest' });
    }
  };
  const onKeyDown = (event: KeyboardEvent<HTMLElement>, key: string, index: number) => {
    if (event.altKey || event.ctrlKey || event.metaKey) return;
    if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault();
      follow(key);
      return;
    }
    if (event.key === 'Escape') {
      const canvas = document.querySelector<HTMLElement>(CANVAS_SCROLLER);
      if (canvas !== null) {
        event.preventDefault();
        event.stopPropagation();
        setShown(null);
        canvas.focus({ preventScroll: true });
      }
      return;
    }
    const step = stepFrom(event.key, index, items.length);
    if (step === null) return;
    event.preventDefault();
    const links = [...(root.current?.querySelectorAll('[data-link-key]') ?? [])];
    if ('to' in step) {
      focusLink(links[step.to]);
      return;
    }
    const lists = [...document.querySelectorAll(LIST)];
    const here = root.current === null ? -1 : lists.indexOf(root.current);
    const next = lists[here + (step.out === 'next' ? 1 : -1)];
    const inside = next === undefined ? [] : [...next.querySelectorAll('[data-link-key]')];
    focusLink(step.out === 'next' ? inside[0] : inside[inside.length - 1]);
  };

  const backLabel = backKeyLabel(t);
  const shownItem = shown === null ? undefined : items.find((candidate) => candidate.key === shown.key);
  const chooserItem = chooser === null ? undefined : items.find((candidate) => candidate.key === chooser.key);

  if (items.length === 0 || !live) return null;
  const style = { ...box, transformOrigin: 'center', '--page-scale': pxPerPt } as CSSProperties;
  const stop = tabStop !== null && items.some((item) => item.key === tabStop) ? tabStop : items[0]?.key;
  const list = (
    <div
      ref={root}
      role="list"
      aria-label={t('smartlinks.aria.list', { page: pageNames(docId, pageIndex).label })}
      data-links-list=""
      data-links-page={pageIndex}
      className="pointer-events-none absolute z-canvas-text"
      style={style}
    >
      {items.map((item, index) => {
        const runs = runsOfItem(item);
        const outer = unionOf([...runs, ...cuesOfItem(item)]);
        const smartItem = item.type === 'smart' ? item : null;
        const text = smartItem === null ? '' : previewText(t, docId, smartItem);
        const range = smartItem !== null && isRange(smartItem.link);
        const open = chooserOpen && chooser?.key === item.key;
        // Open: the active fill is held (L14).
        const state = pressed === item.key || open ? 'active' : hover === item.key ? 'hover' : undefined;
        const isVisited = smartItem !== null && visited?.includes(visitKey(smartItem.link)) === true;
        const attrs =
          item.type === 'smart'
            ? { 'data-smartlink': '', 'data-visited': isVisited ? '' : undefined }
            : { 'data-reallink': '' };
        return (
          <div key={item.key} role="listitem" style={{ display: 'contents' }}>
            <div
              {...attrs}
              role={range ? 'button' : 'link'}
              aria-haspopup={range ? 'listbox' : undefined}
              aria-expanded={range ? open : undefined}
              tabIndex={item.key === stop ? 0 : -1}
              data-link-key={item.key}
              data-link-kind={item.type === 'smart' ? item.link.kind : 'real'}
              data-state={state}
              aria-label={nameOf(t, docId, item)}
              aria-describedby={smartItem !== null && text !== '' ? `${idOf(item.key)}-d` : undefined}
              style={{ left: outer.x, top: outer.y, width: outer.w, height: outer.h }}
              onFocus={(event) => {
                keyFocused.current = item.key;
                setTabStop(item.key);
                if (smartItem === null) return;
                void maybeShowSmartLinksTip();
                const visible = (() => {
                  try {
                    return event.currentTarget.matches(':focus-visible');
                  } catch {
                    return false;
                  }
                })();
                const run = event.currentTarget.querySelector<HTMLElement>('[data-smartlink-run]');
                if (visible && run !== null && chooserRef.current?.key !== item.key)
                  setShown({ key: item.key, el: run });
              }}
              onBlur={() => {
                if (keyFocused.current === item.key) keyFocused.current = null;
                setShown((previous) => (previous?.key === item.key ? null : previous));
              }}
              onKeyDown={(event) => onKeyDown(event, item.key, index)}
            >
              {runs.map((rect, i) => (
                <span
                  key={i}
                  data-smartlink-run=""
                  style={{ left: rect.x - outer.x, top: rect.y - outer.y, width: rect.w, height: rect.h }}
                />
              ))}
              {cuesOfItem(item).map((rect, i) => (
                <span
                  key={`c${i}`}
                  data-smartlink-cue=""
                  style={{ left: rect.x - outer.x, top: rect.y - outer.y + rect.h, width: rect.w }}
                />
              ))}
            </div>
            {smartItem !== null && text !== '' && (
              <span id={`${idOf(item.key)}-d`} className="sr-only">
                {text}
              </span>
            )}
          </div>
        );
      })}
    </div>
  );
  return (
    <>
      {list}
      <AnimatePresence>
        {chooserOpen && chooser !== null && chooserItem?.type === 'smart' && (
          <RangeChooser
            key={chooser.key}
            anchor={chooser.el}
            range={chooserItem.link.marker}
            rows={rowsOf(t, docId, chooserItem.link)}
            onChoose={choose}
            onClose={closeChooser}
          />
        )}
      </AnimatePresence>
      {shownItem?.type === 'smart' && shown !== null && !chooserOpen && (
        <PreviewFor
          docId={docId}
          item={shownItem}
          anchor={shown.el}
          id={`${idOf(shownItem.key)}-p`}
          backLabel={backLabel}
          onNoFit={() => setShown(null)}
        />
      )}
    </>
  );
});

function PreviewFor({
  docId,
  item,
  anchor,
  id,
  backLabel,
  onNoFit,
}: {
  docId: number;
  item: PageLink & { type: 'smart' };
  anchor: HTMLElement;
  id: string;
  backLabel: string;
  onNoFit: () => void;
}) {
  const t = useT();
  const { link } = item;
  const range = isRange(link);
  const { label, physical } = targetNames(docId, link);
  const hint = splitHint(t(range ? 'smartlinks.range.hint' : 'smartlinks.previewHint', { back: KEY_MARK }));
  return (
    <LinkPreview
      open
      id={id}
      anchor={anchor}
      detected={t('smartlinks.detected')}
      kind={t(kindKey(link.kind))}
      page={range ? t('smartlinks.range.count', { n: link.choices?.length ?? 0 }) : pageLine(t, label, physical)}
      body={range ? '' : link.preview}
      hintBefore={hint.before}
      hintKey={backLabel}
      hintAfter={hint.after}
      onNoFit={onNoFit}
    />
  );
}
