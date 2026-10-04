import '../../styles/print.css';

import { usePrintSurface } from './session';

/**
 * The pages handed to the print dialog (DESIGN 3.44, ADR-050): one image per sheet, visible only under `@media print`
 * (src/styles/print.css). On screen it is `display: none` and takes no layout slot. Mounted at the app root (src/App.tsx).
 */
export function PrintSurface() {
  const frames = usePrintSurface((state) => state.frames);
  return (
    <div data-print-surface="" aria-hidden="true">
      {frames.map((frame) => (
        <img key={frame.url} src={frame.url} alt="" style={{ aspectRatio: `${frame.width} / ${frame.height}` }} />
      ))}
    </div>
  );
}
