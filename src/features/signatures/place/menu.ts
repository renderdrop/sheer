import { Calendar, Check, Dot, Plus, Settings2, Signature, Type, X } from 'lucide-react';
import { createElement, useEffect, useState } from 'react';

import { toAppError } from '../../../api/errors';
import { listSignatures, type LibraryItem, type SignatureLibrary, type SignatureRole } from '../../../api/library';
import type { MenuEntry } from '../../../components';
import { useT } from '../../../i18n';
import { selectActiveId, useDocuments } from '../../../stores/documents';
import { useUi } from '../../../stores/ui';
import { openSignatureSheet } from '../create/store';
import { openSignatureLibrary, setLibraryHandlers } from '../library';
import { SignaturePreview } from '../library/SignaturePreview';
import { ensureAsset } from './assets';
import { usePlacement, type PlaceItem } from './store';

/** The Sign tool's menu (DESIGN 3.34): the saved signatures and initials, then Date, Text, Check, Cross and Dot. */

/** Arms an item and makes the Sign tool the active one (the toolbar's own click would toggle it off). */
export function armItem(item: PlaceItem): void {
  const ui = useUi.getState();
  if (ui.activeTool !== 'signature') ui.selectTool('signature');
  usePlacement.getState().arm(item);
}

function report(caught: unknown): void {
  useUi.getState().showBanner(toAppError(caught));
}

/** Opens the creation sheet for a role; what it makes is armed for placing. Nothing happens when it is cancelled. */
export async function createAndArm(role: SignatureRole): Promise<void> {
  try {
    const ref = await openSignatureSheet(role);
    const docId = selectActiveId(useDocuments.getState());
    if (ref === null || docId === null || ref.type === 'asset') return;
    const info = await ensureAsset(docId, ref);
    armItem({ type: 'signature', role, ref, aspect: info.aspect });
  } catch (caught) {
    report(caught);
  }
}

function useLibrary(): SignatureLibrary | null {
  const [library, setLibrary] = useState<SignatureLibrary | null>(null);
  useEffect(() => {
    let cancelled = false;
    listSignatures().then(
      (list) => {
        if (!cancelled) setLibrary(list);
      },
      () => undefined, // the menu still has the rest; the library screen reports a failed read
    );
    return () => {
      cancelled = true;
    };
  }, []);
  return library;
}

const libraryItem = (item: LibraryItem): PlaceItem => ({
  type: 'signature',
  role: item.role,
  ref: { type: 'library', id: item.id },
  aspect: item.aspect,
});

const libraryEntry = (item: LibraryItem): MenuEntry => ({
  id: `lib-${item.id}`,
  label: item.name,
  icon: Signature,
  leading: createElement(SignaturePreview, { item, compact: true }),
  onSelect: () =>
    armItem({ type: 'signature', role: item.role, ref: { type: 'library', id: item.id }, aspect: item.aspect }),
});

/**
 * The entries of the menu, made while it renders. This is a hook on purpose: the toolbar calls the item's `menu` as a hook
 * (toolbarEntries.ts, `menu: useSignMenuEntries`), so it must be called unconditionally and in the same order every render
 * (the test renders it through `renderHook`). It reads the library when the menu opens.
 * Section Sign (DESIGN 3.58): signatures, then initials, each group ending in its "Add" row; section Fill: the Fill and Sign items.
 */
export function useSignMenuEntries(): readonly MenuEntry[] {
  const t = useT();
  const library = useLibrary();
  const items = library?.status === 'locked' ? [] : (library?.items ?? []);
  const of = (role: SignatureRole) => items.filter((item) => item.role === role);
  const entries: MenuEntry[] = [{ type: 'separator', id: 'sec-sign', label: t('sign.section.sign') }];
  for (const role of ['signature', 'initials'] as const) {
    entries.push(...of(role).map(libraryEntry), {
      id: `add-${role}`,
      label: t(role === 'signature' ? 'lib.add' : 'lib.addInitials'),
      icon: Plus,
      onSelect: () => void createAndArm(role),
    });
  }
  const mark = (glyph: 'check' | 'cross' | 'dot') => () => armItem({ type: 'mark', glyph });
  entries.push(
    { type: 'separator', id: 'fill', label: t('sign.section.fill') },
    { id: 'date', label: t('sign.date'), icon: Calendar, onSelect: () => armItem({ type: 'date' }) },
    { id: 'text', label: t('sign.text'), icon: Type, onSelect: () => armItem({ type: 'text' }) },
    { id: 'check', label: t('sign.check'), icon: Check, onSelect: mark('check') },
    { id: 'cross', label: t('sign.cross'), icon: X, onSelect: mark('cross') },
    { id: 'dot', label: t('sign.dot'), icon: Dot, onSelect: mark('dot') },
    { type: 'separator', id: 'manage-sep' },
    { id: 'manage', label: t('lib.manage'), icon: Settings2, onSelect: openSignatureLibrary },
  );
  return entries;
}

// The library dialog's Add buttons open the creation sheet, and Enter on a row arms that entry (DESIGN 3.35).
setLibraryHandlers({
  create: (role) => void createAndArm(role),
  place: (item) => armItem(libraryItem(item)),
});
