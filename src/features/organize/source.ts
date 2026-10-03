/**
 * The organize grid's only contact with the page model (ARCHITECTURE section 5, "Pages", ADR-036): the page list of a document, the
 * page commands and the sources of other files. Everything else in this feature is written against these names, so the contract
 * lives in one file; the implementations are `api/pages`, `stores/pages` and `stores/pageActions`.
 */
import type { PageSlotInfo } from '../../api/pages';

export type { PageCommand, SourceResult } from '../../api/pages';
export { pickPdfSources, releaseSource } from '../../api/pages';
export { applyPageCommand, undoPageStep } from '../../stores/pageActions';
export { readSlots, useSlots } from '../../stores/pages';

/** `PageSlotInfo` of ARCHITECTURE: one page of the document in its current place. Sizes in points, before the rotation. */
export type Slot = PageSlotInfo;
