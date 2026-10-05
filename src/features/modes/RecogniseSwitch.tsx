import { useId } from 'react';

import { Toggle } from '../../components';
import { cx } from '../../components/cx';
import { useT } from '../../i18n';
import { useTools } from '../../stores/tools';

/**
 * The switch of shape recognition (DESIGN 3.5 B11): "Recognise shapes when you pause". It sits at the bottom of Zeichnen's split menu
 * and in Settings under "Drawing"; both are the one stored choice (`tools.shapeRecognition`, default on).
 */
export function RecogniseSwitch({ className }: { className?: string }) {
  const t = useT();
  const labelId = useId();
  const on = useTools((state) => state.straightenShapes);
  const set = useTools((state) => state.setStraightenShapes);
  return (
    <div className={cx('flex items-center justify-between gap-3', className)}>
      <span id={labelId} className="t-label text-text">
        {t('draw.straighten')}
      </span>
      <Toggle checked={on} onCheckedChange={set} aria-labelledby={labelId} />
    </div>
  );
}
