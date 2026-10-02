import { memo, type CSSProperties } from 'react';

import { Panel, PanelSection } from '../../components';
import { useT } from '../../i18n';

export interface InspectorProps {
  /** Faded in: there is a selection, a tool other than Select, or the user opened it. Hidden, it is inert. */
  visible: boolean;
  /** Keep it the same object between renders: the panel is memoized. */
  style?: CSSProperties;
}

/**
 * The inspector slot (DESIGN 3.9): a 288 px G1 `<aside>` that fades in (opacity 250) without moving the canvas and
 * never takes focus by itself. Its header names the selection, or says "Tool options"; the body is a placeholder until
 * the annotation tools (M2) put their properties here.
 */
export const Inspector = memo(function Inspector({ visible, style }: InspectorProps) {
  const t = useT();
  return (
    <Panel label={t('inspector.label')} title={t('inspector.title')} visible={visible} style={style}>
      <PanelSection>
        <p className="m-0 text-sm text-text-muted">{t('inspector.empty')}</p>
      </PanelSection>
    </Panel>
  );
});
