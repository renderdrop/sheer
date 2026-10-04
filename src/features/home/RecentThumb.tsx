import { FileText, FileX } from 'lucide-react';
import { useEffect, useState } from 'react';

import { getRecentThumbnail } from '../../api/recents';
import { Icon, SolarGlow } from '../../components';
import { cx } from '../../components/cx';

/**
 * The thumbnail tile of a card (DESIGN v2 3.1): 40 x 52, radius sm, border, a small `card` glow clipped in its corner and the
 * file icon until the first-page preview has loaded; a file that is gone, one with a password or any failure keeps the icon.
 * Nothing but the id goes to the backend.
 */
export function RecentThumb({ id, missing }: { id: number; missing: boolean }) {
  const [url, setUrl] = useState<string | null>(null);
  const [loaded, setLoaded] = useState(false);
  useEffect(() => {
    if (missing) return;
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
      className="relative flex h-(--home-tile-height) w-(--home-tile-width) shrink-0 items-center justify-center overflow-hidden rounded-sm border border-border-subtle bg-surface-solid text-text-muted"
    >
      <SolarGlow variant="card" />
      <span className="relative">
        <Icon icon={missing ? FileX : FileText} size={18} />
      </span>
      {url !== null && (
        <img
          src={url}
          alt=""
          data-recent-thumb=""
          draggable={false}
          onLoad={() => setLoaded(true)}
          className={cx(
            'absolute inset-0 size-full bg-surface-solid object-contain transition-opacity duration-base',
            loaded ? 'opacity-100' : 'opacity-0',
          )}
        />
      )}
    </span>
  );
}
