import { memo } from 'react';

import { quadBox } from '../viewer/transform';
import { useSearch, type Hit } from './store';

/** The rectangles of one hit, in page space. Highlights: `--color-doc-hit`; the active hit adds an outline (tokens.css). */
const HitBoxes = memo(function HitBoxes({ hit, active }: { hit: Hit; active: boolean }) {
  return (
    <>
      {hit.quads.map((quad, i) => {
        const box = quadBox(quad);
        return (
          <span
            key={i}
            data-search-hit={active ? 'active' : 'hit'}
            className="absolute"
            style={{ left: box.x, top: box.y, width: box.w, height: box.h }}
          />
        );
      })}
    </>
  );
});

/**
 * The search hits of one page (DESIGN 3.16), drawn in the page's overlay below the glyph spans. It subscribes to its own page's
 * hits and to whether the active hit is on this page, so a hit on another page, or another active hit there, does not render it.
 * Decoration only: the list in the panel is the accessible form.
 */
export const SearchHits = memo(function SearchHits({ docId, pageIndex }: { docId: number; pageIndex: number }) {
  const hits = useSearch((state) => state.byDoc[docId]?.pageHits[pageIndex]);
  const active = useSearch((state) => {
    const entry = state.byDoc[docId];
    const hit = entry === undefined || entry.active < 0 ? undefined : entry.hits[entry.active];
    return hit !== undefined && hit.page === pageIndex ? hit.index : -1;
  });
  if (hits === undefined) return null;
  return (
    <div aria-hidden="true" className="pointer-events-none absolute inset-0">
      {hits.map((hit) => (
        <HitBoxes key={hit.index} hit={hit} active={hit.index === active} />
      ))}
    </div>
  );
});
