import { Slider } from '../../components';
import { useT } from '../../i18n';
import { GRID_THUMB } from './grid';
import { useOrganize } from './store';

/**
 * What is left of the organize bar (DESIGN v2 3.2, ADR-102): the page actions moved into the Seiten tool row and "Fertig" is gone (the
 * mode ends with another mode tab). Only the thumbnail size slider stays, at the trailing end of a strip above the grid.
 */
export function OrganizeBar() {
  const t = useT();
  const thumb = useOrganize((state) => state.thumb);
  return (
    <div className="flex h-control-lg shrink-0 items-center justify-end px-4">
      <Slider
        label={t('organize.size')}
        hideLabel
        value={thumb}
        min={GRID_THUMB.min}
        max={GRID_THUMB.max}
        step={GRID_THUMB.step}
        format={(value) => String(value)}
        onValueChange={(value) => useOrganize.getState().setThumb(value)}
      />
    </div>
  );
}
