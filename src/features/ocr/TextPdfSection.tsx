import { FileText } from 'lucide-react';
import { useEffect, useId, useRef, useState } from 'react';

import { exportTextPdf, type TextPdfFont } from '../../api/textPdf';
import { Button, Checkbox, Radio } from '../../components';
import { announce } from '../../components/SuccessPulse';
import { useT } from '../../i18n';
import { useLocaleStore } from '../../i18n/store';
import { useDocuments } from '../../stores/documents';
import { useUi } from '../../stores/ui';
import { InspectorSection } from '../inspector/InspectorFrame';
import { ProgressBar } from '../jobs/ProgressBar';
import { useJobRun } from '../jobs/useJobRun';

const FONTS: readonly TextPdfFont[] = ['inter', 'tinos'];

/**
 * "Save as text PDF" in the text recognition panel (F19.22, DESIGN §3.18 E5): the recognized text as a new PDF of flowing text, in
 * Inter or Tinos, optionally with each original page as a picture after its text. Shown once the tab has recognized text. Rust asks
 * for the target in its own save dialog; a run shows its progress here and can be stopped.
 */
export function TextPdfSection({ docId, focus }: { docId: number; focus: boolean }) {
  const t = useT();
  const id = useId();
  const lang = useLocaleStore((state) => (state.locale === 'de' ? 'de' : 'en'));
  const canCopy = useDocuments((state) => {
    const permissions = state.byId[docId]?.flags?.permissions ?? null;
    return permissions === null || permissions.includes('copy');
  });
  const [font, setFont] = useState<TextPdfFont>('inter');
  const [keepImages, setKeepImages] = useState(false);
  const run = useJobRun();
  const button = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (focus) button.current?.focus();
  }, [focus]);

  const save = () => {
    if (!canCopy || run.running) return;
    run.start(
      (onEvent) => exportTextPdf(docId, { font, keepImages, lang }, onEvent),
      (done) => {
        const message = done.warnings.includes('nothingToExport')
          ? t('ocr.textPdf.nothing')
          : done.warnings.includes('glyphsReplaced')
            ? t('ocr.textPdf.savedReplaced')
            : t('ocr.textPdf.saved');
        useUi.getState().showToast({ message });
        announce(message);
      },
    );
  };

  const fontLabel: Record<TextPdfFont, string> = {
    inter: t('ocr.textPdf.font.inter'),
    tinos: t('ocr.textPdf.font.tinos'),
  };
  const showBar = run.running && run.slow;

  return (
    <InspectorSection caption={t('ocr.textPdf')}>
      <div data-ocr="text-pdf" className="flex flex-col gap-3" inert={run.running ? true : undefined}>
        <p className="t-caption m-0 text-text-muted">{t('ocr.textPdf.hint')}</p>
        <div role="radiogroup" aria-label={t('ocr.textPdf.font')} data-ocr="text-pdf-font" className="flex flex-col">
          {FONTS.map((value) => (
            <label
              key={value}
              data-font={value}
              data-checked={font === value || undefined}
              className="flex min-h-control-md cursor-pointer items-center gap-2 rounded-button px-2 hover:bg-subtle has-focus-visible:outline-2 has-focus-visible:outline-offset-0 has-focus-visible:outline-focus"
            >
              <Radio name={`${id}-font`} value={value} checked={font === value} onChange={() => setFont(value)} />
              {fontLabel[value]}
            </label>
          ))}
        </div>
        <label className="flex min-h-control-md cursor-pointer items-center gap-2" data-ocr="text-pdf-images">
          <Checkbox checked={keepImages} onChange={(event) => setKeepImages(event.target.checked)} />
          {t('ocr.textPdf.keepImages')}
        </label>
        {!canCopy && (
          <p className="t-caption m-0 text-text-muted" data-ocr="text-pdf-blocked">
            {t('output.notAllowed')}
          </p>
        )}
      </div>
      {run.error !== null && (
        <p role="alert" data-ocr="text-pdf-failed" className="t-caption m-0 text-error-text">
          {t('ocr.textPdf.failed')}
        </p>
      )}
      {showBar ? (
        <div className="flex items-center gap-2" data-ocr="text-pdf-progress">
          <ProgressBar
            label={t('ocr.textPdf.progress')}
            done={run.progress?.done ?? 0}
            total={run.progress?.total ?? 0}
            className="min-w-0 flex-1"
          />
          <Button variant="ghost" onClick={run.cancel}>
            {t('commentExport.stop')}
          </Button>
        </div>
      ) : (
        <div>
          <Button
            ref={button}
            variant="secondary"
            icon={FileText}
            data-ocr="text-pdf-save"
            disabled={!canCopy || run.running}
            onClick={save}
          >
            {t('ocr.textPdf.save')}
          </Button>
        </div>
      )}
    </InspectorSection>
  );
}
