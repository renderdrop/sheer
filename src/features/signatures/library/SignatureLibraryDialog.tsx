import { AnimatePresence, motion, useIsPresent } from 'motion/react';
import { Lock, PenLine, Pencil, Signature, Trash2, TriangleAlert } from 'lucide-react';
import { useEffect, useLayoutEffect, useMemo, useRef, useState, type KeyboardEvent } from 'react';
import { createPortal } from 'react-dom';

import { MAX_PER_ROLE, type LibraryItem, type SignatureRole } from '../../../api/library';
import { Button, Field, Icon, IconButton } from '../../../components';
import { DISMISS_PRIORITY, registerDismissLayer } from '../../../components/dismiss';
import { cycleTab } from '../../../components/focusTrap';
import { DURATION, useFade, usePopoverMotion } from '../../../components/motion';
import { itemsOf, rovingTarget } from '../../../components/roving';
import { APP_NAME } from '../../../config/app';
import { errorText, useLocale, useT } from '../../../i18n';
import {
  NAME_MAX,
  closeSignatureLibrary,
  deleteWithUndo,
  forgetAll,
  renameItem,
  undoDelete,
  useSignatureLibrary,
} from './state';
import { SignaturePreview } from './SignaturePreview';

/** The app's root element: inert while the dialog is open. */
const APP_ROOT_ID = 'root';
const ROLES: readonly SignatureRole[] = ['signature', 'initials'];

function focusRow(id: string): void {
  requestAnimationFrame(() => {
    document.querySelector<HTMLElement>(`[data-lib-row][data-lib-id="${id}"]`)?.focus({ preventScroll: true });
  });
}

interface RowProps {
  item: LibraryItem;
  deleted: boolean;
  session: boolean;
  tabStop: boolean;
  editing: boolean;
  onEdit: (editing: boolean) => void;
  onFocusRow: () => void;
}

/** The name as a field in place (DESIGN 3.35): selected on mount; Enter or blur commits, Esc reverts. Mounted only while renaming. */
function NameField({ item, onDone }: { item: LibraryItem; onDone: () => void }) {
  const t = useT();
  const [text, setText] = useState(item.name);
  const field = useRef<HTMLInputElement>(null);
  const done = useRef(false);

  useLayoutEffect(() => {
    field.current?.focus({ preventScroll: true });
    field.current?.select();
  }, []);

  const finish = (commit: boolean, refocus: boolean) => {
    if (done.current) return;
    done.current = true;
    if (commit) void renameItem(item.id, text);
    onDone();
    if (refocus) focusRow(item.id);
  };
  return (
    <Field
      ref={field}
      size="sm"
      aria-label={t('lib.renameField')}
      autoComplete="off"
      spellCheck={false}
      maxLength={NAME_MAX}
      value={text}
      data-keep-escape=""
      className="w-full!"
      onChange={(event) => setText(event.target.value)}
      onBlur={() => finish(true, false)}
      onKeyDown={(event) => {
        if (event.key === 'Enter') {
          event.preventDefault();
          finish(true, true);
        } else if (event.key === 'Escape') {
          event.preventDefault();
          finish(false, true);
        }
      }}
    />
  );
}

/** One entry (DESIGN 3.35): preview chip, name over meta, rename, delete. A deleted row becomes a notice with Undo. */
function LibraryRow({ item, deleted, session, tabStop, editing, onEdit, onFocusRow }: RowProps) {
  const t = useT();
  const locale = useLocale();
  const date = useMemo(
    () => new Intl.DateTimeFormat(locale, { dateStyle: 'medium' }).format(new Date(item.created * 1000)),
    [locale, item.created],
  );

  if (deleted) {
    return (
      <li className="flex h-control-lg items-center gap-2 rounded-button px-2 text-text-muted">
        <span role="status" className="min-w-0 flex-1 truncate">
          {t('lib.deleted', { name: item.name })}
        </span>
        <Button
          variant="ghost"
          size="sm"
          autoFocus
          onClick={() => {
            undoDelete(item.id);
            focusRow(item.id);
          }}
        >
          {t('lib.undo')}
        </Button>
      </li>
    );
  }

  const source = item.kind === 'raster' ? t('lib.source.raster') : t('lib.source.vector');
  return (
    <li
      data-lib-row=""
      data-lib-id={item.id}
      tabIndex={tabStop ? 0 : -1}
      aria-label={item.name}
      onFocus={(event) => {
        if (event.target === event.currentTarget) onFocusRow();
      }}
      className="flex items-center gap-2 rounded-button p-2 hover:bg-control-hover focus-within:bg-control-hover"
    >
      <SignaturePreview item={item} />
      <div className="flex min-w-0 flex-1 flex-col">
        {editing ? (
          <NameField item={item} onDone={() => onEdit(false)} />
        ) : (
          <span className="truncate text-md font-semibold">{item.name}</span>
        )}
        <span className="truncate text-sm text-text-muted">
          {session ? t('lib.session') : t('lib.meta', { source, date })}
        </span>
      </div>
      <IconButton size="sm" label={t('lib.rename')} icon={Pencil} onClick={() => onEdit(true)} />
      <IconButton size="sm" label={t('lib.delete')} icon={Trash2} onClick={() => deleteWithUndo(item.id)} />
    </li>
  );
}

function LibraryModal() {
  const t = useT();
  const present = useIsPresent();
  const dialog = useRef<HTMLDivElement>(null);
  const backdropMotion = useFade(DURATION.base, DURATION.fast);
  const dialogMotion = usePopoverMotion();
  const { status, items, loaded, error, deleted, handlers } = useSignatureLibrary();
  const [editingId, setEditingId] = useState<string | null>(null);
  const [tabId, setTabId] = useState<string | null>(null);
  const [confirming, setConfirming] = useState(false);

  const previousFocus = useRef<Element | null>(null);
  useLayoutEffect(() => {
    const element = dialog.current;
    if (!present || element === null) return;
    if (!element.contains(document.activeElement)) previousFocus.current = document.activeElement;
    const root = document.getElementById(APP_ROOT_ID);
    root?.setAttribute('inert', '');
    element.focus({ preventScroll: true });
    return () => root?.removeAttribute('inert');
  }, [present]);

  // Focus goes back to where it was, after the commit (as the About dialog does).
  useEffect(() => {
    if (!present) return;
    return () => {
      const previous = previousFocus.current;
      if (previous instanceof HTMLElement && previous.isConnected) previous.focus({ preventScroll: true });
    };
  }, [present]);

  useEffect(() => {
    if (!present) return;
    return registerDismissLayer(DISMISS_PRIORITY.modal, closeSignatureLibrary);
  }, [present]);

  const visible = items.filter((item) => !deleted.has(item.id));
  const firstId = visible[0]?.id ?? null;
  const stopId = tabId !== null && visible.some((item) => item.id === tabId) ? tabId : firstId;

  // The first row takes the initial focus once the list has arrived; else the dialog keeps it.
  const focused = useRef(false);
  useEffect(() => {
    if (!present || !loaded || focused.current || firstId === null) return;
    focused.current = true;
    if (dialog.current?.contains(document.activeElement) && document.activeElement !== dialog.current) return;
    focusRow(firstId);
  }, [present, loaded, firstId]);

  const onListKeyDown = (event: KeyboardEvent<HTMLElement>) => {
    const row = event.target instanceof HTMLElement ? event.target.closest<HTMLElement>('[data-lib-row]') : null;
    if (row === null || event.target !== row || event.nativeEvent.isComposing) return;
    const id = row.dataset.libId ?? '';
    const item = items.find((candidate) => candidate.id === id);
    if (item === undefined) return;
    const rows = itemsOf(dialog.current ?? row, '[data-lib-row]');
    const target = rovingTarget(event.key, rows.indexOf(row), rows.length, { orientation: 'vertical', wrap: false });
    if (target !== null) {
      event.preventDefault();
      rows[target]?.focus();
    } else if (event.key === 'F2') {
      event.preventDefault();
      setEditingId(id);
    } else if (event.key === 'Delete') {
      event.preventDefault();
      // The row turns into a notice and its Undo button takes the focus (autoFocus).
      deleteWithUndo(id);
    } else if (event.key === 'Enter' && handlers.place !== undefined) {
      event.preventDefault();
      const place = handlers.place;
      closeSignatureLibrary();
      place(item);
    }
  };

  const count = (role: SignatureRole) => items.filter((item) => item.role === role).length;
  const session = status === 'unavailable';
  const empty = loaded && items.length === 0 && status !== 'locked';
  const canForget = status === 'locked' || items.length > 0;

  return (
    <motion.div
      {...backdropMotion}
      onPointerDown={(event) => {
        if (event.target === event.currentTarget) closeSignatureLibrary();
      }}
      className={`fixed inset-0 z-modal grid place-items-center bg-backdrop p-4 ${present ? '' : 'pointer-events-none'}`}
    >
      <motion.div
        {...dialogMotion}
        ref={dialog}
        role="dialog"
        aria-modal={present ? 'true' : undefined}
        aria-labelledby="lib-title"
        aria-busy={loaded ? undefined : true}
        tabIndex={-1}
        onKeyDown={(event) => cycleTab(event, event.currentTarget)}
        className="bg-panel border border-border-subtle shadow-floating flex w-dialog-md max-w-full flex-col gap-4 rounded-card p-6 text-text outline-none"
      >
        <div className="flex items-center gap-2">
          <span className="flex size-control-md shrink-0 items-center justify-center rounded-sm bg-tile text-tile-icon">
            <Icon icon={Signature} />
          </span>
          <h2 id="lib-title" className="m-0 font-display text-xl">
            {t('lib.title')}
          </h2>
        </div>

        {session && (
          <p role="status" className="m-0 flex items-start gap-2 text-sm text-text">
            <Icon icon={TriangleAlert} size={12} className="mt-1 shrink-0" />
            {t('lib.noKeychainWarning', { app: APP_NAME })}
          </p>
        )}
        {status === 'locked' && (
          <p role="status" className="m-0 flex flex-wrap items-center gap-2 text-sm text-text">
            <Icon icon={TriangleAlert} size={12} className="shrink-0" />
            <span className="min-w-0 flex-1">{t('lib.locked')}</span>
            <Button variant="ghost" size="sm" onClick={() => setConfirming(true)}>
              {t('lib.reset')}
            </Button>
          </p>
        )}
        {error !== null && (
          <p role="alert" className="m-0 text-sm text-error-text">
            {loaded && items.length === 0 && status === 'ready' ? t('lib.loadFailed') : errorText(t, error)}
          </p>
        )}

        {empty ? (
          <div className="flex flex-col items-center gap-2 py-6 text-center">
            <span className="flex size-control-lg items-center justify-center rounded-button bg-tile text-tile-icon">
              <Icon icon={Signature} size={24} />
            </span>
            <p className="m-0 font-semibold">{t('lib.empty')}</p>
            <p className="m-0 text-text-muted">{t('lib.emptyHint')}</p>
            {handlers.create !== undefined && (
              <Button variant="primary" icon={PenLine} onClick={() => handlers.create?.('signature')}>
                {t('lib.add')}
              </Button>
            )}
          </div>
        ) : (
          <div onKeyDown={onListKeyDown} className="flex max-h-lib-list flex-col gap-2 overflow-y-auto">
            {ROLES.map((role) => {
              const rows = items.filter((item) => item.role === role);
              if (rows.length === 0 && !loaded) return null;
              const heading = role === 'signature' ? t('lib.signatures') : t('lib.initials');
              const full = count(role) >= MAX_PER_ROLE;
              return (
                <section key={role} aria-labelledby={`lib-group-${role}`} className="flex flex-col gap-1">
                  <div className="flex h-6 items-center justify-between gap-2">
                    <h3 id={`lib-group-${role}`} className="m-0 text-sm font-semibold text-text-muted">
                      {heading}
                    </h3>
                    {full && <span className="text-sm text-text-muted">{t('lib.full')}</span>}
                  </div>
                  <ul className="m-0 flex list-none flex-col gap-1 p-0">
                    {rows.map((item) => (
                      <LibraryRow
                        key={item.id}
                        item={item}
                        deleted={deleted.has(item.id)}
                        session={session}
                        tabStop={item.id === stopId}
                        editing={editingId === item.id}
                        onEdit={(on) => setEditingId(on ? item.id : null)}
                        onFocusRow={() => setTabId(item.id)}
                      />
                    ))}
                  </ul>
                </section>
              );
            })}
          </div>
        )}

        {handlers.create !== undefined && !empty && (
          <div className="flex flex-wrap items-center gap-2">
            <Button
              variant="secondary"
              size="sm"
              disabled={count('signature') >= MAX_PER_ROLE}
              focusableWhenDisabled
              onClick={() => handlers.create?.('signature')}
            >
              {t('lib.add')}
            </Button>
            <Button
              variant="secondary"
              size="sm"
              disabled={count('initials') >= MAX_PER_ROLE}
              focusableWhenDisabled
              onClick={() => handlers.create?.('initials')}
            >
              {t('lib.addInitials')}
            </Button>
          </div>
        )}

        {confirming ? (
          <div role="alertdialog" aria-label={t('lib.forgetAll')} className="flex flex-col gap-2">
            <p className="m-0">{t('lib.forgetConfirm')}</p>
            <div className="flex items-center justify-end gap-2">
              <Button variant="secondary" autoFocus onClick={() => setConfirming(false)}>
                {t('lib.forgetCancel')}
              </Button>
              <Button
                variant="primary"
                onClick={() => {
                  setConfirming(false);
                  void forgetAll();
                }}
              >
                {t('lib.forgetDo')}
              </Button>
            </div>
          </div>
        ) : (
          <div className="flex items-center gap-2">
            {!session && status !== 'locked' ? (
              <p className="m-0 flex min-w-0 flex-1 items-center gap-1 text-sm text-text-muted">
                <Icon icon={Lock} size={12} className="shrink-0" />
                {t('lib.encrypted')}
              </p>
            ) : (
              <span className="flex-1" />
            )}
            {canForget && (
              <Button variant="ghost" onClick={() => setConfirming(true)}>
                {t('lib.forgetAll')}
              </Button>
            )}
            <Button variant="primary" data-autofocus="" onClick={closeSignatureLibrary}>
              {t('lib.close')}
            </Button>
          </div>
        )}
      </motion.div>
    </motion.div>
  );
}

/**
 * The signature library (DESIGN 3.35): a modal listing the saved signatures and initials with previews, rename, delete with an
 * inline Undo, and "Forget all" behind a confirm. Mounted once, with the toolbar; `openSignatureLibrary` opens it.
 */
export function SignatureLibraryDialog() {
  const open = useSignatureLibrary((state) => state.open);
  return createPortal(<AnimatePresence>{open && <LibraryModal key="library" />}</AnimatePresence>, document.body);
}
