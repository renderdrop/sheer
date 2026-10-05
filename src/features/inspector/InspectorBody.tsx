import { useT, type PlainKey } from '../../i18n';
import type { AnnotationKind } from '../../api/annotations';
import type { CreationKind } from '../../stores/tools';
import { useUi } from '../../stores/ui';
import { useCropInspector } from '../crop/useCropInspector';
import { FormOptions } from '../forms/FormOptions';
import { useInsertInspector } from '../insert/useInsertInspector';
import { useRedactInspector } from '../redact/useRedactInspector';
import { paletteNameOf } from './palette';
import { ColourSection, FontSizeSection, LineEndSection, OpacitySection, StrokeSection } from './Sections';
import { useInspectorModel, type InspectorModel } from './useInspectorModel';

/** The ink of a drawn or typed signature (DESIGN 3.33). */

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
  citation: 'citation.cite',
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

const subjectName = (model: Exclude<InspectorModel, { mode: 'empty' }>): string =>
  model.subject.type === 'kind' ? model.subject.kind : model.subject.type === 'tool' ? model.subject.tool : '';

/** The option sections of the model, stacked 12 apart (DESIGN v2 3.2 disclosure). */
export function InspectorBody({ model }: { model: InspectorModel }) {
  if (model.mode === 'empty') return null;
  const { sections, values, change } = model;
  const disabled = !model.editable;
  const common = { disabled, onChange: change };
  return (
    <div className="flex flex-col gap-3">
      {sections.includes('colour') && (
        <ColourSection {...common} colour={values.color} palette={paletteNameOf(subjectName(model))} />
      )}
      {sections.includes('stroke') && <StrokeSection {...common} width={values.width} />}
      {sections.includes('fontSize') && <FontSizeSection {...common} fontSize={values.fontSize} />}
      {sections.includes('lineEnd') && <LineEndSection {...common} head={values.head} />}
      {sections.includes('opacity') && <OpacitySection {...common} opacity={values.opacity} />}
    </div>
  );
}

export interface InspectorContent {
  title: string;
  /** `null`: nothing to show (no selection, and the active tool has no options). */
  body: React.ReactNode;
  /** The tool's own options: the title is only for assistive technology. */
  quiet: boolean;
}

/** The options content from the stores: the mode panels and the insert tools first, then the selection, then the tool's options. */
export function useInspector(): InspectorContent {
  const t = useT();
  const model = useInspectorModel();
  const title = useInspectorTitle(model);
  // The M5 modes and tools bring their own inspector (DESIGN 3.36 to 3.38); each is `null` while it is not active.
  const own = [useCropInspector(), useRedactInspector(), useInsertInspector()].find((entry) => entry !== null);
  const formTool = useUi((state) => state.activeTool === 'form');
  if (own !== undefined) return { title: own.title, body: own.body, quiet: false };
  // The Form tool has options of its own (DESIGN 3.32): the highlight toggle and Flatten.
  if (model.mode === 'empty' && formTool) {
    return { title: t('inspector.toolOptions', { tool: t('toolbar.tool.form') }), body: <FormOptions />, quiet: false };
  }
  if (model.mode === 'empty') return { title, body: null, quiet: true };
  return { title, body: <InspectorBody model={model} />, quiet: model.mode === 'tool' };
}
