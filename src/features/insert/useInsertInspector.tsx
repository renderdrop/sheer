import { useId, type ReactNode } from 'react';

import type { StdFont, TextAlign } from '../../api/annotations';
import { Button, PanelSection, Checkbox } from '../../components';
import { cx } from '../../components/cx';
import { useT, type PlainKey } from '../../i18n';
import { selectActiveId, useDocuments } from '../../stores/documents';
import { useUi } from '../../stores/ui';
import { ColourSection, FontSizeSection, OpacitySection } from '../inspector/Sections';
import { shared } from '../inspector/properties';
import { RadioRow } from '../inspector/RadioRow';
import { useAnnotations } from '../../stores/annotations';
import type { AnnotationStyle } from '../inspector/style';
import { deleteObjects, updateObject } from './actions';
import { useInsert, type ContentObject } from './store';

const FONTS: readonly { value: StdFont; key: PlainKey }[] = [
  { value: 'sans', key: 'insert.sans' },
  { value: 'serif', key: 'insert.serif' },
  { value: 'mono', key: 'insert.mono' },
];

const SEGMENT =
  'flex h-control-md min-w-0 flex-1 basis-0 cursor-pointer items-center justify-center rounded-sm px-2 text-md aria-disabled:cursor-not-allowed ' +
  'hover:bg-control-hover aria-checked:bg-selected aria-checked:text-text';
const SEGMENTS = 'flex gap-1 rounded-button border border-divider p-1';

function FontSection({ font, onChange }: { font: StdFont; onChange: (font: StdFont) => void }) {
  const t = useT();
  const labelId = useId();
  return (
    <div className="flex flex-col gap-2">
      <span id={labelId} className="text-sm font-semibold text-text-muted">
        {t('insert.font')}
      </span>
      <RadioRow
        labelledBy={labelId}
        value={font}
        onChange={onChange}
        className={SEGMENTS}
        options={FONTS.map((entry) => ({
          value: entry.value,
          label: t(entry.key),
          className: cx(SEGMENT),
          children: <span className="truncate">{t(entry.key)}</span>,
        }))}
      />
    </div>
  );
}

const ALIGNS: readonly { value: TextAlign; key: PlainKey }[] = [
  { value: 'left', key: 'insert.alignLeft' },
  { value: 'center', key: 'insert.alignCenter' },
  { value: 'right', key: 'insert.alignRight' },
];

function AlignSection({
  align,
  disabled,
  onChange,
}: {
  align: TextAlign;
  disabled: boolean;
  onChange: (a: TextAlign) => void;
}) {
  const t = useT();
  const labelId = useId();
  return (
    <div className="flex flex-col gap-2">
      <span id={labelId} className="text-sm font-semibold text-text-muted">
        {t('insert.align')}
      </span>
      <RadioRow
        labelledBy={labelId}
        value={align}
        onChange={onChange}
        className={SEGMENTS}
        options={ALIGNS.map((entry) => ({
          value: entry.value,
          label: t(entry.key),
          disabled,
          className: cx(SEGMENT),
          children: <span className="truncate">{t(entry.key)}</span>,
        }))}
      />
    </div>
  );
}

function LockAspect() {
  const t = useT();
  const lock = useInsert((s) => s.lockAspect);
  const setLock = useInsert((s) => s.setLockAspect);
  return (
    <label className="flex min-h-control-sm cursor-pointer items-center gap-2 text-md">
      <Checkbox checked={lock} onChange={(event) => setLock(event.target.checked)} />
      <span className="min-w-0 flex-1">{t('insert.lockAspect')}</span>
    </label>
  );
}

/** The selected text box or image of the active document, when nothing else is selected. */
function useSelectedObject(docId: number | null): ContentObject | null {
  const object = useInsert((s) => {
    const id = docId === null ? null : (s.selected[docId] ?? null);
    return id === null || docId === null ? null : (s.byDoc[docId]?.byId[id] ?? null);
  });
  const comments = useAnnotations((s) => (docId === null ? 0 : (s.selectedIds[docId]?.length ?? 0)));
  const several = useInsert((s) => (docId === null ? 0 : (s.extra[docId]?.length ?? 0))) > 0;
  return comments > 0 || several ? null : object;
}

/**
 * Inspector content of the Add text and Add image tools and of a selected text box or image (DESIGN 3.36, 3.24). Returns `null`
 * while neither the tool nor a selection of ours is there, so the standard inspector shows; `useInspector`
 * (src/features/inspector/InspectorBody.tsx) asks it first. It is a hook, so it may use stores and `useT`.
 */
export function useInsertInspector(): { title: string; body: ReactNode; footer?: ReactNode } | null {
  const t = useT();
  const docId = useDocuments(selectActiveId);
  const tool = useUi((s) => s.activeTool);
  const style = useInsert((s) => s.style);
  const setStyle = useInsert((s) => s.setStyle);
  const object = useSelectedObject(docId);

  if (object !== null && docId !== null) {
    const change = (patch: Partial<AnnotationStyle>) =>
      updateObject(docId, object.id, {
        ...(patch.color === undefined ? {} : { color: patch.color }),
        ...(patch.fontSize === undefined ? {} : { fontSize: patch.fontSize }),
        ...(patch.opacity === undefined ? {} : { opacity: patch.opacity }),
      });
    const disabled = object.locked;
    const deleteButton = (
      <PanelSection>
        <Button onClick={() => void deleteObjects(docId, [object.id])}>{t('insert.delete')}</Button>
      </PanelSection>
    );
    return {
      title: t(object.kind === 'textBox' ? 'insert.textRole' : 'insert.imageRole'),
      body:
        object.kind === 'textBox' ? (
          <>
            <PanelSection>
              <FontSection font={object.font} onChange={(font) => void updateObject(docId, object.id, { font })} />
            </PanelSection>
            <PanelSection>
              <FontSizeSection fontSize={shared([object.fontSize])} disabled={disabled} onChange={change} />
            </PanelSection>
            <PanelSection>
              <AlignSection
                align={object.align}
                disabled={disabled}
                onChange={(align) => void updateObject(docId, object.id, { align })}
              />
            </PanelSection>
            <PanelSection>
              <ColourSection colour={shared([object.color])} disabled={disabled} onChange={change} />
            </PanelSection>
            {deleteButton}
          </>
        ) : (
          <>
            <PanelSection>
              <LockAspect />
            </PanelSection>
            <PanelSection>
              <OpacitySection opacity={shared([object.opacity])} disabled={disabled} onChange={change} />
            </PanelSection>
            {deleteButton}
          </>
        ),
    };
  }

  if (tool !== 'textBox' && tool !== 'image') return null;
  const change = (patch: Partial<AnnotationStyle>) => {
    setStyle({
      ...(patch.color === undefined ? {} : { color: patch.color }),
      ...(patch.fontSize === undefined ? {} : { fontSize: patch.fontSize }),
    });
    return Promise.resolve();
  };
  return {
    title: t('inspector.toolOptions', { tool: t(tool === 'textBox' ? 'insert.text' : 'insert.image') }),
    body:
      tool === 'textBox' ? (
        <>
          <PanelSection>
            <FontSection font={style.font} onChange={(font) => setStyle({ font })} />
          </PanelSection>
          <PanelSection>
            <FontSizeSection fontSize={shared([style.fontSize])} disabled={false} onChange={change} />
          </PanelSection>
          <PanelSection>
            <ColourSection colour={shared([style.color])} disabled={false} onChange={change} />
          </PanelSection>
        </>
      ) : (
        <PanelSection>
          <LockAspect />
        </PanelSection>
      ),
  };
}
