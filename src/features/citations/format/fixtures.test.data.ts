import { BIB_KINDS, emptyBibRecord, parseBibRecord, type BibKind, type BibRecord } from '../../../api/citations';
import data from './fixtures.json';

/** One filled record of each kind (fixtures.json), the data of the golden tests. */
export const FIXTURES = Object.fromEntries(
  BIB_KINDS.map((kind) => [kind, parseBibRecord(data[kind]) ?? emptyBibRecord()]),
) as Record<BibKind, BibRecord>;
