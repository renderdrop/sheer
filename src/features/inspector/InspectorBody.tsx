import { SlidersHorizontal } from 'lucide-react';

import { Icon, PanelSection } from '../../components';
import { useT, type PlainKey } from '../../i18n';
import type { AnnotationKind } from '../../api/annotations';
import type { CreationKind } from '../../stores/tools';
import { ColourSection, FontSizeSection, LineEndSection, OpacitySection, StrokeSection } from './Sections';
import { useInspectorModel, type InspectorModel } from './useInspectorModel';

const KIND_KEYS: Readonly<Record<AnnotationKind, PlainKey>> = {
  highlight: 'annot.type.highlight',
  underline: 'annot.type.underline',
  strikeout: 'annot.type.strikeout',
  note: 'annot.type.note',
  freeText: 'annot.type.freeText',
  ink: 'annot.type.ink',
  rect: 'annot.type.rect',
  ellipse: 'annot.type.ellipse',
  line: 'annot.type.line',
  signature: 'annot.type.signature',
  mark: 'annot.type.mark',
  opaque: 'annot.type.opaque',
};

const TOOL_KEYS: Readonly<Record<CreationKind, PlainKey>> = {
  highlight: 'tool.highlight',
  underline: 'tool.underline',
  strikeout: 'tool.strike',
  note: 'tool.note',
  freeText: 'tool.text',
  ink: 'tool.draw',
  rect: 'tool.rect',
  ellipse: 'tool.ellipse',
  line: 'tool.line',
  arrow: 'tool.arrow',
};

/** The header text for what the inspector shows (DESIGN 3.24): the type, "n items", or "Tool options: tool". */
export function useInspectorTitle(model: InspectorModel): string {
  const t = useT();
  if (model.mode === 'empty') return t('inspector.title');
  switch (model.subject.type) {
    case 'kind':
      return t(KIND_KEYS[model.subject.kind]);
    case 'items':
      return t('inspector.items', { n: model.subject.count });
    case 'tool':
      return t('inspector.toolOptions', { tool: t(TOOL_KEYS[model.subject.tool]) });
  }
}

/** Nothing selected and no tool that has options (DESIGN 3.24, empty state per 3.15). */
function EmptyState() {
  const t = useT();
  return (
    <div className="flex flex-col items-center gap-1 p-2 text-center">
      <span className="flex size-control-md items-center justify-center rounded-sm bg-tile text-tile-icon">
        <Icon icon={SlidersHorizontal} size={24} />
      </span>
      <span className="text-md font-semibold">{t('inspector.empty')}</span>
      <span className="text-sm text-text-muted">{t('inspector.emptyHint')}</span>
    </div>
  );
}

/** The sections of the inspector for the model; the shell's `Inspector` puts it in the panel. */
export function InspectorBody({ model }: { model: InspectorModel }) {
  if (model.mode === 'empty') return <EmptyState />;
  const { sections, values, recent, change } = model;
  const disabled = !model.editable;
  const common = { disabled, onChange: change };
  return (
    <>
      {sections.includes('colour') && (
        <PanelSection>
          <ColourSection {...common} colour={values.color} recent={recent} />
        </PanelSection>
      )}
      {sections.includes('stroke') && (
        <PanelSection>
          <StrokeSection {...common} width={values.width} />
        </PanelSection>
      )}
      {sections.includes('fontSize') && (
        <PanelSection>
          <FontSizeSection {...common} fontSize={values.fontSize} />
        </PanelSection>
      )}
      {sections.includes('lineEnd') && (
        <PanelSection>
          <LineEndSection {...common} head={values.head} />
        </PanelSection>
      )}
      {sections.includes('opacity') && (
        <PanelSection>
          <OpacitySection {...common} opacity={values.opacity} />
        </PanelSection>
      )}
    </>
  );
}

/** The inspector's content from the stores. */
export function useInspector(): { title: string; body: React.ReactNode } {
  const model = useInspectorModel();
  const title = useInspectorTitle(model);
  return { title, body: <InspectorBody model={model} /> };
}
