import { useCropInspector } from '../crop/useCropInspector';
import { useInsertInspector } from '../insert/useInsertInspector';
import { useRedactInspector } from '../redact/useRedactInspector';

/**
 * The options of the Bearbeiten tools that have a panel of their own (DESIGN 3.36 to 3.38). The sidebar that hosted them is gone
 * (ADR-102), so the slot's chevron part opens them in a popover while the tool is active. Each is the content its module made for
 * the sidebar, unchanged; it is `null` while the tool or mode is not on.
 */
export function CropOptions() {
  return <div className="w-popover-max p-4">{useCropInspector()?.body}</div>;
}

export function InsertOptions() {
  return <div className="flex w-popover-min flex-col gap-3 p-4">{useInsertInspector()?.body}</div>;
}

export function RedactOptions() {
  return <div className="flex w-popover-min flex-col gap-3 p-4">{useRedactInspector()?.body}</div>;
}
