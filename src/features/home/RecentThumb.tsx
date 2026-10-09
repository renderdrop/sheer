import { FileText, FileX } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';

import { getRecentThumbnail } from '../../api/recents';
import { Icon } from '../../components';
import { cx } from '../../components/cx';

/**
 * The thumbnail box of a card (DESIGN 3.18 H4): the card's width, 172 / 124 / 76 high by tier, Sand, radius sm; the first-page preview
 * contained and top-aligned (cropped at the bottom in the short tier), the file icon until it has loaded. A file that is gone, one with a
 * password or any failure keeps the icon. `id` is `null` for an open document (no recent entry, no preview). Nothing but the id goes to the backend.
 */
/** Whether the element has been near the viewport; true at once where there is no IntersectionObserver (tests). Never goes back to false. */
function useSeen(ref: { current: Element | null }): boolean {
  const [seen, setSeen] = useState(() => typeof IntersectionObserver === 'undefined');
  useEffect(() => {
    const element = ref.current;
    if (seen || element === null) return;
    const observer = new IntersectionObserver(
      (changes) => {
        if (changes.some((change) => change.isIntersecting)) {
          setSeen(true);
          observer.disconnect();
        }
      },
      { rootMargin: '200px' },
    );
    observer.observe(element);
    return () => observer.disconnect();
  }, [ref, seen]);
  return seen;
}

export function RecentThumb({ id, missing = false }: { id: number | null; missing?: boolean }) {
  const [url, setUrl] = useState<string | null>(null);
  const [loaded, setLoaded] = useState(false);
  const box = useRef<HTMLSpanElement>(null);
  // Only cards that are (nearly) visible ask for a thumbnail: the Recent view lists up to 50 (F21.3).
  const seen = useSeen(box);
  useEffect(() => {
    if (missing || id === null || !seen) return;
    let alive = true;
    let made: string | null = null;
    getRecentThumbnail(id).then(
      (frame) => {
        if (!alive) return;
        made = URL.createObjectURL(new Blob([frame.data], { type: 'image/png' }));
        setUrl(made);
      },
      () => undefined,
    );
    return () => {
      alive = false;
      if (made !== null) URL.revokeObjectURL(made);
    };
  }, [id, missing, seen]);
  return (
    <span
      ref={box}
      data-recent-tile=""
      className="home-thumb relative flex w-full items-center justify-center overflow-hidden rounded-sm bg-subtle text-text-muted"
    >
      <Icon icon={missing ? FileX : FileText} size={20} />
      {url !== null && (
        <img
          src={url}
          alt=""
          data-recent-thumb=""
          draggable={false}
          onLoad={() => setLoaded(true)}
          className={cx(
            'absolute inset-0 size-full bg-subtle object-contain object-top transition-opacity duration-base',
            loaded ? 'opacity-100' : 'opacity-0',
          )}
        />
      )}
    </span>
  );
}
