import { useInsertInspector } from '../insert/useInsertInspector';
import { useRedactInspector } from '../redact/useRedactInspector';

/**
 * The options of the Bearbeiten tools that keep a popover (DESIGN 3.36, 3.38). Zuschneiden, Kopf-/Fußzeile and Stempel have no
 * popover any more: their settings are in the tool inspector (DESIGN 3.18 E5, `src/features/inspector/ToolInspector.tsx`). Each is the
 * content its module made, unchanged; it is `null` while the tool or mode is not on.
 */

export function InsertOptions() {
  return (
    <div className="flex w-max min-w-(--options-inner-min) max-w-(--options-inner-max) flex-col gap-3">
      {useInsertInspector()?.body}
    </div>
  );
}

export function RedactOptions() {
  return (
    <div className="flex w-max min-w-(--options-inner-min) max-w-(--options-inner-max) flex-col gap-3">
      {useRedactInspector()?.body}
    </div>
  );
}
