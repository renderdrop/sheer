import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';

import { useT } from '../../i18n';
import { announcementsFor, freshMemory, type Announcement, type Snapshot } from './announce';
import { useTextEdit } from './store';

interface Said {
  seq: number;
  item: Announcement;
}

/**
 * The live regions of "Edit text" (DESIGN 3.10 E8): polite for start, commit, cancel, substitute, overflow and a refusal that was
 * clicked, assertive for errors. Nothing is said on mount; the store's steps decide (see `announcementsFor`).
 */
export function TextEditAnnouncer() {
  const t = useT();
  const [polite, setPolite] = useState<Said | null>(null);
  const [assertive, setAssertive] = useState<Said | null>(null);
  const seq = useRef(0);

  useEffect(() => {
    const memory = freshMemory();
    const snap = (): Snapshot => ({ session: useTextEdit.getState().session, refusal: useTextEdit.getState().refusal });
    let prev = snap();
    return useTextEdit.subscribe(() => {
      const next = snap();
      if (next.session === prev.session && next.refusal === prev.refusal) return;
      for (const item of announcementsFor(prev, next, memory)) {
        seq.current += 1;
        const said = { seq: seq.current, item };
        if (item.level === 'assertive') setAssertive(said);
        else setPolite(said);
      }
      prev = next;
    });
  }, []);

  const text = (said: Said | null) => (said === null ? '' : t(said.item.key, said.item.params));
  // A portal, so that it takes no room in the layout.
  return createPortal(
    <>
      <span role="status" aria-live="polite" data-testid="textedit-live" className="sr-only">
        {text(polite)}
      </span>
      <span aria-live="assertive" aria-atomic="true" data-testid="textedit-alert" className="sr-only">
        {text(assertive)}
      </span>
    </>,
    document.body,
  );
}
