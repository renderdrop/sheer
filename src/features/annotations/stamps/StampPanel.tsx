import { Sticker } from 'lucide-react';

import { useT } from '../../../i18n';
import { useToolInspector } from '../../inspector/toolInspector';
import { InspectorFrame } from '../../inspector/InspectorFrame';
import { StampPickerBody } from './StampPicker';
import { useStamp } from './store';

/** The stamp inspector (DESIGN §3.18 E5; was the ST2 picker): no footer, choosing a stamp is the action and arms placement. */
export function StampPanel() {
  const t = useT();
  return (
    <InspectorFrame
      icon={Sticker}
      title={t('stamp.tool')}
      surface="stamp"
      footer={null}
      onDismiss={() => useToolInspector.getState().closeToolInspector('stamp')}
    >
      <StampPickerBody close={() => useStamp.getState().setPicker(false)} />
    </InspectorFrame>
  );
}
