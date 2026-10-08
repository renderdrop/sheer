import { Info, ScanText, TriangleAlert } from 'lucide-react';
import { useEffect, useId, useState } from 'react';

import { Button, Checkbox, Icon, Radio } from '../../components';
import { APP_NAME } from '../../config/app';
import { useLocale, useT } from '../../i18n';
import { useDocuments } from '../../stores/documents';
import { pageIdAt } from '../../stores/pages';
import { useView } from '../../stores/view';
import { openLanguageSettings, type PageClass } from '../../api/ocr';
import { InspectorFrame, InspectorSection, InspectorSections, type InspectorFooter } from '../inspector/InspectorFrame';
import { focusCanvas } from '../modes/switch';
import { selectionOf, useOrganize } from '../organize/store';
import {
  countScope,
  hasRecognizedText,
  languageState,
  runCount,
  scopeIds,
  selectionFor,
  wantedLanguage,
  type Scope,
} from './model';
import { closeOcrDialog, ensureCapabilities, startOcr } from './runtime';
import { useOcr, type OcrDialogState } from './store';
import { TextPdfSection } from './TextPdfSection';

const NO_CLASSES: readonly PageClass[] = [];

/** A language tag: contextual alternates and tabular figures off, so the hyphen of `en-US` keeps its normal spacing. */
function LangTag({ tag }: { tag: string }) {
  return (
    <span
      data-ocr="language-tag"
      className="[font-feature-settings:'calt'_0,'cv11','ss01'] [font-variant-numeric:normal]"
    >
      {tag}
    </span>
  );
}

function Panel({ request }: { request: OcrDialogState }) {
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
  const initialScope: Scope = request.preselectSelected && hasSelection ? 'selected' : 'scan';
  const [scope, setScope] = useState<Scope>(initialScope);
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

  const go = () => {
    if (!canStart) return;
    const pages = selectionFor(scope, classes, currentId, selectedIds, effectiveRedo);
    if (pages === null) return;
    setStarting(true);
    closeOcrDialog();
    // The invoker (the banner action) goes away with the offer: focus returns to the canvas instead.
    window.setTimeout(focusCanvas, 0);
    void startOcr(docId, pages, wanted, effectiveRedo, n);
  };

  const options: { value: Scope; label: string }[] = [
    { value: 'scan', label: t('ocr.scope.scan', { n: scanCount }) },
    { value: 'current', label: t('ocr.scope.current') },
    ...(hasSelection ? [{ value: 'selected' as const, label: t('ocr.scope.selected', { n: selectedCount }) }] : []),
    { value: 'all', label: t('ocr.scope.all') },
  ];
  const footer: InspectorFooter = {
    apply: { label: t('ocr.inspector.start'), disabled: !canStart, onApply: go },
    reset: {
      disabled: scope === initialScope && !redo,
      onReset: () => {
        setScope(initialScope);
        setRedo(false);
      },
    },
  };

  return (
    <InspectorFrame
      icon={ScanText}
      title={t('ocr.title')}
      surface="ocr-dialog"
      footer={footer}
      onDismiss={closeOcrDialog}
    >
      <div data-surface-state="" data-language={language.kind}>
        <InspectorSections>
          <InspectorSection caption={t('ocr.scope')}>
            <div role="radiogroup" aria-label={t('ocr.scope')} data-ocr="scope" className="flex flex-col tabular-nums">
              {options.map((option) => (
                <label
                  key={option.value}
                  data-scope={option.value}
                  data-checked={scope === option.value || undefined}
                  className="flex min-h-control-md cursor-pointer items-center gap-2 rounded-button px-2 hover:bg-subtle has-focus-visible:outline-2 has-focus-visible:outline-offset-0 has-focus-visible:outline-focus"
                >
                  <Radio
                    name={`${id}-scope-group`}
                    value={option.value}
                    checked={scope === option.value}
                    onChange={() => setScope(option.value)}
                  />
                  {option.label}
                </label>
              ))}
            </div>
            {showRedo && (
              <label className="flex min-h-control-md cursor-pointer items-center gap-2 tabular-nums" data-ocr="redo">
                <Checkbox checked={redo} onChange={(event) => setRedo(event.target.checked)} />
                {t('ocr.redo', { app: APP_NAME, n: counts.sheerLayer })}
              </label>
            )}
          </InspectorSection>
          <InspectorSection caption={t('ocr.lang')}>
            <div
              role="group"
              aria-label={t('ocr.lang')}
              aria-describedby={language.kind === 'available' || language.kind === 'loading' ? undefined : noteId}
              data-ocr="language"
              className="flex flex-col gap-1"
            >
              <span className="t-body" data-ocr="language-value">
                {t('ocr.lang.value', { name: t(`ocr.lang.name.${wanted}`), tag: '\u0000' })
                  .split('\u0000')
                  .flatMap((part, index) => (index === 0 ? [part] : [<LangTag key="tag" tag={wanted} />, part]))}
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
                    <div className="ps-5">
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
                      {t(capabilities?.backend === 'vision' ? 'ocr.lang.settingsHintMac' : 'ocr.lang.settingsHint')}
                    </p>
                  )}
                </div>
              )}
            </div>
            {nothing && (
              <p role="status" className="t-caption m-0 text-text-muted" data-ocr="nothing">
                {t('ocr.nothing')}
              </p>
            )}
          </InspectorSection>
          {hasRecognizedText(classes) && <TextPdfSection docId={docId} focus={request.textPdf === true} />}
        </InspectorSections>
      </div>
    </InspectorFrame>
  );
}

/** The text recognition form (DESIGN §3.18 E5; was the O2 dialog), open while `useOcr.dialog` is set. */
export function OcrPanel() {
  const request = useOcr((state) => state.dialog);
  return request === null ? null : <Panel key={request.docId} request={request} />;
}
