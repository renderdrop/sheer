import { memo } from 'react';

import { Panel } from '../../components';
import { useT } from '../../i18n';
import { useInspector } from '../inspector/InspectorBody';

/**
 * The inspector (DESIGN 3.9), the temporary content of the tool sidebar slot (`ToolSidebarSlot`): an `<aside>` that never takes focus by itself. Its header names the selection, or says "Tool options"; the body is the properties inspector (DESIGN 3.24).
 */
export const Inspector = memo(function Inspector() {
  const t = useT();
  const { title, body } = useInspector();
  return (
    <Panel data-region="inspector" label={t('inspector.label')} title={title}>
      {body}
    </Panel>
  );
});
