import { Info, ScanText, TriangleAlert } from 'lucide-react';
import { AnimatePresence } from 'motion/react';
import { useEffect, useId, useState, type FormEvent, type KeyboardEvent } from 'react';

import { Button, Checkbox, Icon, Tooltip } from '../../components';
import { APP_NAME } from '../../config/app';
import { useLocale, useT } from '../../i18n';
import { useDocuments } from '../../stores/documents';
import { pageIdAt } from '../../stores/pages';
import { useView } from '../../stores/view';
import { openLanguageSettings, type PageClass } from '../../api/ocr';
import { Modal, ModalHeader } from '../jobs/Modal';
import { RadioGroup } from '../jobs/RadioGroup';
import { focusCanvas } from '../modes/switch';
import { selectionOf, useOrganize } from '../organize/store';
import { countScope, languageState, runCount, scopeIds, selectionFor, wantedLanguage, type Scope } from './model';
import { closeOcrDialog, ensureCapabilities, startOcr } from './runtime';
import { useOcr, type OcrDialogState } from './store';

const NO_CLASSES: readonly PageClass[] = [];

function OcrModal({ request }: { request: OcrDialogState }) {
  const t = useT();
  const locale = useLocale();
  const id = useId();
  const { docId } = request;
  const capabilities = useOcr((state) => state.capabilities);
  const classes = useOcr((state) => state.classes[docId]) ?? NO_CLASSES;
  const selectedIds = useOrganize((state) => selectionOf(state, docId).selected);
  const pageIndex = useView((state) => state.byDoc[docId]?.pageIndex ?? 0);
  const hasDoc = useDocuments((state) => state.byId[docId] !== undefined);
  const currentId = pageIdAt(docId, pageIndex);
  const hasSelection = selectedIds.length > 0;
  const [scope, setScope] = useState<Scope>(request.preselectSelected && hasSelection ? 'selected' : 'scan');
  const [redo, setRedo] = useState(false);
  const [starting, setStarting] = useState(false);
  const [settingsFailed, setSettingsFailed] = useState(false);

  useEffect(() => {
    void ensureCapabilities();
  }, []);

  const wanted = wantedLanguage(locale);
  const language = languageState(capabilities, wanted);
  const counts = countScope(classes, scopeIds(scope, classes, currentId, selectedIds));
  const scanCount = countScope(classes, scopeIds('scan', classes, currentId, selectedIds)).scan;
  const selectedCount = countScope(classes, scopeIds('selected', classes, currentId, selectedIds)).inScope;
  const showRedo = counts.sheerLayer > 0;
  const effectiveRedo = showRedo && redo;
  const n = runCount(counts, effectiveRedo);
  const languageOk = language.kind === 'available' || language.kind === 'fallback';
  const nothing = n === 0 && languageOk;
  const canStart = n > 0 && languageOk && hasDoc && !starting;
  const noteId = `${id}-lang-note`;

  const go = (event?: FormEvent) => {
    event?.preventDefault();
    if (!canStart) return;
    const pages = selectionFor(scope, classes, currentId, selectedIds, effectiveRedo);
    if (pages === null) return;
    setStarting(true);
    closeOcrDialog();
    // The invoker (the banner action) goes away with the offer: focus returns to the canvas instead.
    window.setTimeout(focusCanvas, 0);
    void startOcr(docId, pages, wanted, effectiveRedo, n);
  };

  // Enter on a radio (a button) would press it; here it starts, like in a form (O5).
  const onKeyDown = (event: KeyboardEvent<HTMLFormElement>) => {
    if (event.key === 'Enter' && (event.target as HTMLElement).getAttribute('role') === 'radio') {
      event.preventDefault();
      go();
    }
  };

  const options: { value: Scope; label: string }[] = [
    { value: 'scan', label: t('ocr.scope.scan', { n: scanCount }) },
    { value: 'current', label: t('ocr.scope.current') },
    ...(hasSelection ? [{ value: 'selected' as const, label: t('ocr.scope.selected', { n: selectedCount }) }] : []),
    { value: 'all', label: t('ocr.scope.all') },
  ];
  const startButton = (
    <Button variant="primary" type="submit" data-ocr="start" disabled={!canStart} focusableWhenDisabled>
      {t('ocr.start', { count: n })}
    </Button>
  );

  return (
    <Modal labelledBy={`${id}-title`} width="w-dialog-md" onClose={closeOcrDialog}>
      <form
        data-surface="ocr-dialog"
        data-language={language.kind}
        onSubmit={go}
        onKeyDown={onKeyDown}
        className="flex flex-col gap-4"
      >
        <ModalHeader id={`${id}-title`} icon={<Icon icon={ScanText} />} title={t('ocr.title')} />
        <div className="flex flex-col gap-1">
          <div data-ocr="scope" className="tabular-nums">
            <RadioGroup
              label={t('ocr.scope')}
              look="plain"
              orientation="vertical"
              value={scope}
              onChange={setScope}
              options={options.map((option) => ({ value: option.value, label: option.label, content: option.label }))}
            />
          </div>
          <p className="t-caption m-0 text-text-muted">{t('ocr.scope.hint')}</p>
        </div>
        {showRedo && (
          <label className="flex min-h-control-md cursor-pointer items-center gap-2 tabular-nums" data-ocr="redo">
            <Checkbox checked={redo} onChange={(event) => setRedo(event.target.checked)} />
            {t('ocr.redo', { app: APP_NAME, n: counts.sheerLayer })}
          </label>
        )}
        <div
          role="group"
          aria-label={t('ocr.lang')}
          aria-describedby={language.kind === 'available' || language.kind === 'loading' ? undefined : noteId}
          data-ocr="language"
          className="flex flex-col gap-1"
        >
          <span className="t-label text-text-muted">{t('ocr.lang')}</span>
          <span className="t-body" data-ocr="language-value">
            {t('ocr.lang.value', { name: t(`ocr.lang.name.${wanted}`), tag: wanted })}
          </span>
          {language.kind === 'fallback' && (
            <p
              id={noteId}
              className="t-caption m-0 flex items-start gap-1 text-text-muted"
              data-ocr="language-fallback"
            >
              <span className="shrink-0">
                <Icon icon={Info} size={16} />
              </span>
              {t('ocr.lang.fallback', {
                wanted: t(`ocr.lang.name.${wanted}`),
                used: t(`ocr.lang.name.${language.used}`),
              })}
            </p>
          )}
          {language.kind === 'none' && (
            <div id={noteId} className="flex flex-col gap-1" data-ocr="language-none">
              <p className="t-caption m-0 flex items-start gap-1 text-text-muted">
                <span className="shrink-0">
                  <Icon icon={TriangleAlert} size={16} />
                </span>
                {t('ocr.lang.none')}
              </p>
              {/* Windows: the backend opens its fixed settings page. Elsewhere (or if that fails) the way is said in words. */}
              {capabilities?.backend === 'windows' && !settingsFailed ? (
                <div>
                  <Button
                    variant="secondary"
                    data-ocr="settings"
                    onClick={() => {
                      openLanguageSettings().catch(() => setSettingsFailed(true));
                    }}
                  >
                    {t('ocr.lang.settings')}
                  </Button>
                </div>
              ) : (
                <p className="t-caption m-0 text-text-muted" data-ocr="settings-hint">
                  {t('ocr.lang.settingsHint')}
                </p>
              )}
            </div>
          )}
        </div>
        <div className="flex flex-col gap-2">
          {nothing && (
            <p role="status" className="t-caption m-0 text-text-muted" data-ocr="nothing">
              {t('ocr.nothing')}
            </p>
          )}
          <div className="flex items-center justify-end gap-2">
            <Button variant="secondary" onClick={closeOcrDialog}>
              {t('ocr.cancel')}
            </Button>
            {nothing ? <Tooltip label={t('ocr.nothing')}>{startButton}</Tooltip> : startButton}
          </div>
        </div>
      </form>
    </Modal>
  );
}

/** The OCR dialog (DESIGN 3.12 O2), open while `useOcr.dialog` is set. */
export function OcrDialog() {
  const request = useOcr((state) => state.dialog);
  return <AnimatePresence>{request !== null && <OcrModal key="ocr" request={request} />}</AnimatePresence>;
}
