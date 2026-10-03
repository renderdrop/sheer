import { createPortal } from 'react-dom';

import { useT } from '../../../i18n';
import { toolNameKey, useTools } from '../../../stores/tools';
import { useUi } from '../../../stores/ui';

/**
 * The polite live region that names the tool when it changes (DESIGN 3.22 "A11y", `tool.announce`). Nothing is said on mount;
 * the text is derived from the stores, so a change of tool, lock or variant updates it and a screen reader reads it once.
 * Tools without a name of their own here (Form, Signature, Pages) say nothing.
 */
export function ToolAnnouncer() {
  const t = useT();
  const tool = useUi((state) => state.activeTool);
  const locked = useUi((state) => state.toolLocked);
  const markup = useTools((state) => state.markup);
  const shapes = useTools((state) => state.shapes);
  const key = toolNameKey(tool, { markup, shapes });
  let text = '';
  if (tool === 'select') text = t('tool.announceSelect');
  else if (key !== null) text = t(locked ? 'tool.announceLocked' : 'tool.announce', { tool: t(key) });
  // A portal, so that it takes no room in the toolbar row.
  return createPortal(
    <span role="status" aria-live="polite" className="sr-only">
      {text}
    </span>,
    document.body,
  );
}
