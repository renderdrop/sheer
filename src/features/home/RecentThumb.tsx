import { FileText, FileX } from 'lucide-react';
import { useEffect, useState } from 'react';

import { getRecentThumbnail } from '../../api/recents';
import { Icon } from '../../components';
import { cx } from '../../components/cx';

/**
 * The thumbnail box of a card (DESIGN 3.18 H4): the card's width, 172 / 124 / 76 high by tier, Sand, radius sm; the first-page preview
 * contained and top-aligned (cropped at the bottom in the short tier), the file icon until it has loaded. A file that is gone, one with a
 * password or any failure keeps the icon. `id` is `null` for an open document (no recent entry, no preview). Nothing but the id goes to the backend.
 */
export function RecentThumb({ id, missing = false }: { id: number | null; missing?: boolean }) {
  const [url, setUrl] = useState<string | null>(null);
  const [loaded, setLoaded] = useState(false);
  useEffect(() => {
    if (missing || id === null) return;
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
  }, [id, missing]);
  return (
    <span
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
