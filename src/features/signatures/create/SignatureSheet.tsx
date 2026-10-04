import { Eraser, Image as ImageIcon, PenLine, Signature, Type } from 'lucide-react';
import { useEffect, useId, useRef, useState, type KeyboardEvent, type RefObject } from 'react';

import { toAppError, type AppError } from '../../../api/errors';
import { listSignatures, type LibraryStatus, type SignatureRole } from '../../../api/library';
import {
  createDrawnSignature,
  createTypedSignature,
  discardSignatureDraft,
  importSignatureImage,
  MAX_TYPED_CHARS,
  saveDraftSignature,
  type SignatureDraft,
  type SignatureArt,
  type SignatureRef,
  type TypedFont,
} from '../../../api/signatures';
import { Button, Field, Icon, Tab, TabList, TabPanel, Tabs, Checkbox } from '../../../components';
import { cx } from '../../../components/cx';
import { errorText, useT, type Translate } from '../../../i18n';
import { useSettings } from '../../../stores/settings';
import type { InkSample } from '../ink';
import { SIGNATURE_PALETTE } from '../../inspector/palette';
import { RadioRow, type RadioOption } from '../../inspector/RadioRow';
import { Modal, ModalHeader } from '../../jobs/Modal';
import { DrawPad } from './DrawPad';
import {
  canCreate,
  loadTab,
  saveTab,
  strokesToOutlines,
  typePrefill,
  TYPE_DEBOUNCE_MS,
  type SigColour,
  type SigTab,
} from './model';
import { FontPicker } from './FontPicker';
import { loadFont, rememberItemFont, saveFont, SIGNATURE_FONTS } from './fonts';
import { ArtPreview, PAD_SURFACE } from './Previews';
import { lastSignatureColour, rememberSignatureColour, settleSignatureSheet } from './store';

function colourOptions(t: Translate): RadioOption<SigColour>[] {
  const ids: readonly SigColour[] = ['ink', 'signature'];
  return SIGNATURE_PALETTE.map((entry, index) => ({
    value: ids[index] ?? 'ink',
    label: t(entry.nameKey),
    swatch: true,
    className: cx(entry.bg, entry.check),
  }));
}

/** Frees a draft in the backend; a failure is of no interest (the store keeps only the last few anyway). */
function discard(id: number) {
  void Promise.resolve(discardSignatureDraft(id)).catch(() => undefined);
}

/**
 * The typed draft for `text`: the backend makes the outlines of the bundled font; a failed or stale call changes nothing. A draft that
 * is replaced, and the one left when the sheet closes (unless it was handed out: `kept`), is discarded.
 */
function useTypedDraft(
  role: SignatureRole,
  text: string,
  font: TypedFont,
  active: boolean,
  kept: RefObject<number | null>,
) {
  const [held] = useState(() => ({ id: null as number | null }));
  const [draft, setDraft] = useState<SignatureDraft | null>(null);
  const [glyph, setGlyph] = useState(false);
  const [failure, setFailure] = useState<AppError | null>(null);

  useEffect(() => {
    if (!active) return;
    const value = text.trim();
    if (value === '') return;
    let cancelled = false;
    const timer = window.setTimeout(() => {
      createTypedSignature(role, value, font)
        .then((made) => {
          if (cancelled) {
            discard(made.id);
            return;
          }
          if (held.id !== null) discard(held.id);
          held.id = made.id;
          setDraft(made);
          setGlyph(false);
          setFailure(null);
        })
        .catch((caught: unknown) => {
          if (cancelled) return;
          const error = toAppError(caught);
          if (held.id !== null) discard(held.id);
          held.id = null;
          setDraft(null);
          setGlyph(error.code === 'invalid_argument' && error.params?.what === 'glyph');
          setFailure(error);
        });
    }, TYPE_DEBOUNCE_MS);
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [role, text, font, active, held]);

  useEffect(
    () => () => {
      if (held.id !== null && held.id !== kept.current) discard(held.id);
    },
    [held, kept],
  );

  return { draft, glyph, failure };
}

function SheetBody({ id, kind }: { id: number; kind: SignatureRole }) {
  const t = useT();
  const uid = useId();
  const authorName = useSettings((state) => state.authorName);
  const [tab, setTab] = useState<SigTab>(loadTab);
  const [colour, setColour] = useState<SigColour>(lastSignatureColour);
  const [strokes, setStrokes] = useState<readonly (readonly InkSample[])[]>([]);
  const [text, setText] = useState(() => typePrefill(kind, authorName));
  const [image, setImage] = useState<SignatureDraft | null>(null);
  const [imageError, setImageError] = useState(false);
  const [importing, setImporting] = useState(false);
  const [save, setSave] = useState(true);
  const [status, setStatus] = useState<LibraryStatus | null>(null);
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<AppError | null>(null);
  const body = useRef<HTMLDivElement>(null);
  const kept = useRef<number | null>(null);
  const [font, setFont] = useState<TypedFont>(loadFont);
  // The style cards preview the name (or the placeholder) in every font; the chosen font's draft is the one that is made.
  const shown = text.trim() === '' ? t('sign.typePlaceholder') : text;
  const typedByFont = {
    msMadi: useTypedDraft(kind, shown, 'msMadi', tab === 'type', kept),
    hurricane: useTypedDraft(kind, shown, 'hurricane', tab === 'type', kept),
    birthstone: useTypedDraft(kind, shown, 'birthstone', tab === 'type', kept),
  };
  const typed = typedByFont[font];
  const arts = Object.fromEntries(SIGNATURE_FONTS.map(({ id }) => [id, typedByFont[id].draft?.art ?? null])) as Record<
    TypedFont,
    SignatureArt | null
  >;
  const chooseFont = (next: TypedFont) => {
    setFont(next);
    saveFont(next);
  };
  // The imported picture is a backend draft like the typed one: a replaced one, and the one left at close (unless handed out), is discarded.
  const imageRef = useRef<SignatureDraft | null>(null);
  useEffect(() => {
    imageRef.current = image;
  }, [image]);
  useEffect(
    () => () => {
      const held = imageRef.current;
      if (held !== null && held.id !== kept.current) discard(held.id);
    },
    [],
  );

  useEffect(() => {
    let cancelled = false;
    listSignatures()
      .then((library) => {
        if (!cancelled) setStatus(library.status);
      })
      .catch(() => {
        if (!cancelled) setStatus('unavailable');
      });
    return () => {
      cancelled = true;
    };
  }, []);

  // The tablist takes the focus (DESIGN 3.33). A passive effect runs after the modal's own focus, so it wins.
  useEffect(() => {
    body.current?.querySelector<HTMLElement>('[role="tab"][aria-selected="true"]')?.focus({ preventScroll: true });
  }, []);

  const choose = (value: string) => {
    const next = value as SigTab;
    setTab(next);
    saveTab(next);
  };

  const libraryOk = status === 'ready';
  // Until the status is known the box counts as usable: a keychain that then turns out to fail is reported by the save itself.
  const willSave = save && status !== 'locked' && status !== 'unavailable';
  const hasTyped = typed.draft !== null && text.trim() !== '';
  const ready = canCreate({ tab, strokes: strokes.length, typed: hasTyped, image: image !== null, busy });

  const create = async () => {
    if (!ready) return;
    setBusy(true);
    setFailure(null);
    let drawn: SignatureDraft | null = null;
    try {
      let draft: SignatureDraft | null;
      if (tab === 'draw') draft = drawn = await createDrawnSignature(kind, strokesToOutlines(strokes));
      else draft = tab === 'type' ? typed.draft : image;
      if (draft === null) {
        setBusy(false);
        return;
      }
      rememberSignatureColour(colour);
      let ref: SignatureRef = { type: 'draft', id: draft.id };
      if (willSave) {
        const name =
          tab === 'type' && text.trim() !== ''
            ? text.trim()
            : t(kind === 'initials' ? 'sign.nameInitials' : 'sign.nameSignature');
        const item = await saveDraftSignature(draft.id, Array.from(name).slice(0, 64).join(''));
        if (tab === 'type') rememberItemFont(item.id, font);
        ref = { type: 'library', id: item.id };
      }
      // A draft that goes out as the answer must outlive the sheet.
      if (ref.type === 'draft') kept.current = draft.id;
      settleSignatureSheet(id, ref);
    } catch (caught) {
      // A drawn draft whose saving failed is of no use: the next try makes a new one.
      if (drawn !== null && kept.current !== drawn.id) discard(drawn.id);
      setFailure(toAppError(caught));
      setBusy(false);
    }
  };

  const chooseImage = async () => {
    setImporting(true);
    setImageError(false);
    try {
      const picked = await importSignatureImage(kind, false);
      if (picked !== null) {
        const previous = imageRef.current;
        if (previous !== null) discard(previous.id);
        setImage(picked);
      }
    } catch {
      setImageError(true);
    } finally {
      setImporting(false);
    }
  };

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    // Primary+Z takes back the last stroke; in the name field it stays the field's own undo.
    if (tab !== 'draw' || !(event.ctrlKey || event.metaKey) || event.shiftKey || event.altKey) return;
    if (event.key.toLowerCase() !== 'z' || event.target instanceof HTMLInputElement) return;
    event.preventDefault();
    setStrokes((current) => current.slice(0, -1));
  };

  const titleId = `${uid}-title`;
  const colourId = `${uid}-colour`;
  const typeId = `${uid}-type`;
  const noteId = `${uid}-note`;
  const libId = `${uid}-lib`;
  const initials = kind === 'initials';
  const typeProblem =
    text.trim() === ''
      ? ''
      : typed.glyph
        ? t('sign.badGlyph')
        : typed.failure !== null
          ? errorText(t, typed.failure)
          : '';
  const createProblem = failure !== null ? errorText(t, failure) : '';

  return (
    <Modal labelledBy={titleId} width="w-sheet-wide" surface="white" onClose={() => settleSignatureSheet(id, null)}>
      <ModalHeader
        id={titleId}
        icon={<Icon icon={Signature} />}
        title={t(initials ? 'sign.createInitials' : 'sign.createTitle')}
      />
      <div ref={body} onKeyDown={onKeyDown}>
        <Tabs value={tab} onValueChange={choose} className="mt-4 flex flex-col gap-4">
          <TabList label={t('sign.tabs')}>
            <Tab value="draw" label={t('sign.draw')} icon={PenLine} />
            <Tab value="type" label={t('sign.type')} icon={Type} />
            <Tab value="image" label={t('sign.image')} icon={ImageIcon} />
          </TabList>

          <TabPanel value="draw" className="flex h-sig-slot justify-center">
            <DrawPad strokes={strokes} onStrokes={setStrokes} colour={colour} initials={initials} />
          </TabPanel>
          <TabPanel value="type" className="flex min-h-sig-slot flex-col gap-2">
            <label htmlFor={typeId} className="sr-only">
              {t('sign.typeLabel')}
            </label>
            <Field
              id={typeId}
              value={text}
              maxLength={MAX_TYPED_CHARS}
              autoComplete="off"
              spellCheck={false}
              aria-invalid={typeProblem !== '' ? true : undefined}
              aria-describedby={typeProblem !== '' ? noteId : undefined}
              onChange={(event) => setText(event.target.value)}
              className="w-full!"
            />
            <FontPicker
              label={t('sign.font')}
              value={font}
              onChange={chooseFont}
              arts={arts}
              colour={colour}
              empty={text.trim() === ''}
            />
            <p id={noteId} role="status" className="m-0 h-4 truncate text-sm text-error-text">
              {typeProblem}
            </p>
          </TabPanel>
          <TabPanel value="image" className="flex h-sig-slot flex-col gap-2">
            <div className="flex items-center gap-2">
              <Button variant="secondary" onClick={chooseImage} disabled={importing} focusableWhenDisabled>
                {t('sign.choose')}
              </Button>
              {image === null && <span className="text-sm text-text-muted">{t('sign.noImage')}</span>}
            </div>
            <div className={`${PAD_SURFACE} min-h-0 flex-auto p-2`}>
              {image !== null && <ArtPreview draft={image} colour={colour} />}
            </div>
            <p role="alert" className="m-0 h-4 truncate text-sm text-error-text">
              {imageError ? t('sign.badImage') : ''}
            </p>
          </TabPanel>
        </Tabs>

        {tab !== 'image' && (
          <div className="mt-2 flex items-center gap-2">
            <span id={colourId} className="sr-only">
              {t('sign.colour')}
            </span>
            <RadioRow
              labelledBy={colourId}
              value={colour}
              options={colourOptions(t)}
              onChange={setColour}
              className="flex gap-2"
            />
            <span className="flex-auto" />
            {tab === 'draw' && (
              <Button
                variant="ghost"
                size="sm"
                icon={Eraser}
                disabled={strokes.length === 0}
                focusableWhenDisabled
                onClick={() => setStrokes([])}
              >
                {t('sign.clear')}
              </Button>
            )}
          </div>
        )}
        {tab === 'draw' && <p className="m-0 mt-2 text-sm text-text-muted">{t('sign.keyboardHint')}</p>}
      </div>

      <p role="alert" className="m-0 mt-2 min-h-4 text-sm text-error-text">
        {createProblem}
      </p>
      <div className="mt-2 flex items-center gap-2">
        <label
          className={cx(
            'flex min-h-control-sm items-center gap-2 text-md',
            libraryOk ? 'cursor-pointer' : 'cursor-not-allowed text-text-disabled',
          )}
        >
          <Checkbox
            checked={willSave}
            aria-disabled={!libraryOk ? true : undefined}
            aria-describedby={!libraryOk && status !== null ? libId : undefined}
            onChange={(event) => {
              if (libraryOk) setSave(event.target.checked);
            }}
          />
          {t('sign.save')}
        </label>
        {!libraryOk && status !== null && (
          <span id={libId} className="text-sm text-text-muted">
            {t(status === 'locked' ? 'sign.libLocked' : 'lib.noKeychain')}
          </span>
        )}
        <span className="flex-auto" />
        <Button variant="secondary" onClick={() => settleSignatureSheet(id, null)}>
          {t('sign.cancel')}
        </Button>
        <Button
          variant="primary"
          disabled={!ready}
          focusableWhenDisabled
          aria-busy={busy ? true : undefined}
          onClick={create}
        >
          {t('sign.create')}
        </Button>
      </div>
    </Modal>
  );
}

export function SignatureSheet({ id, kind }: { id: number; kind: SignatureRole }) {
  return <SheetBody id={id} kind={kind} />;
}
