import { useEffect, useState } from 'react';

import { getPageLinks, type LinkInfo } from '../../api/links';

/**
 * The real links of a page (`get_page_links`), fetched once per page and `stamp` while the page is in the render window (DESIGN 3.11
 * L3: they keep the PDF's own look; the app adds the pointer, the hover outline and the focus pair). A small LRU.
 */
const MAX_PAGES = 200;
const cache = new Map<string, readonly LinkInfo[]>();

const keyOf = (docId: number, page: number, stamp: string) => `${docId}:${page}:${stamp}`;

/** The real links of a page for `stamp`, or `null` until they are known. */
export function usePageRealLinks(
  docId: number,
  page: number,
  stamp: string,
  active: boolean,
): readonly LinkInfo[] | null {
  const key = keyOf(docId, page, stamp);
  const [loaded, setLoaded] = useState<{ key: string; links: readonly LinkInfo[] } | null>(null);
  useEffect(() => {
    if (!active || cache.has(key)) return;
    let current = true;
    getPageLinks(docId, page).then(
      (links) => {
        cache.set(key, links);
        for (const oldest of cache.keys()) {
          if (cache.size <= MAX_PAGES) break;
          cache.delete(oldest);
        }
        if (current) setLoaded({ key, links });
      },
      () => {
        // A page without readable links has none.
        cache.set(key, []);
        if (current) setLoaded({ key, links: [] });
      },
    );
    return () => {
      current = false;
    };
  }, [active, docId, page, key]);
  if (!active) return null;
  return cache.get(key) ?? (loaded?.key === key ? loaded.links : null);
}

/** Forgets everything (tests). */
export function clearRealLinkCache(): void {
  cache.clear();
}
