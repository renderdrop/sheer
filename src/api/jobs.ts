import { Channel } from '@tauri-apps/api/core';

import { call } from './call';
import { parseDocumentInfo, type DocumentInfo } from './documents';
import { toAppError, type AppError } from './errors';

/*
 * The page-job commands of docs/ARCHITECTURE.md section 5, "Pages" (commands/pages.rs): sources, extract, split, merge, compress,
 * cancel. Package R4 wrote this file as a thin typed layer against the documented signatures; package R3 owns the backend.
 */

export type SourceId = number;
export type JobId = number;
export type PageId = number;

/** A file the Rust open dialog chose and admitted, held in memory by the backend. Never a path. */
export type SourceResult =
  { type: 'ready'; sourceId: SourceId; displayName: string; pageCount: number } | { type: 'failed'; error: AppError };

export type SplitPlan =
  | { type: 'everyN'; n: number; pattern?: string }
  | { type: 'before'; pages: PageId[]; pattern?: string }
  /** One file per range of text like "1-3, 5, 8-"; Rust parses and validates it (the dialog checks it live with features/jobs/ranges). */
  | { type: 'ranges'; text: string; pattern?: string };
export type MergeInput = { type: 'document'; docId: number } | { type: 'source'; sourceId: SourceId };
export type CompressPreset = 'lossless' | 'print' | 'ebook' | 'screen';

export type JobPhase = 'read' | 'images' | 'write' | 'validate';
export type JobWarning = 'signaturesRemoved' | 'formsDropped' | 'widgetsDropped';

export type JobEvent =
  | { type: 'progress'; phase: JobPhase; done: number; total: number }
  | {
      type: 'done';
      outputs: number;
      bytesBefore: number;
      bytesAfter: number;
      warnings: JobWarning[];
      opened: DocumentInfo | null;
    }
  | { type: 'cancelled' }
  | { type: 'failed'; error: AppError };

const PHASES: readonly string[] = ['read', 'images', 'write', 'validate'];
const WARNINGS: readonly string[] = ['signaturesRemoved', 'formsDropped', 'widgetsDropped'];
const count = (value: unknown): value is number =>
  typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= Number.MAX_SAFE_INTEGER;

/** A job event from a channel message; `null` if it is not one. */
export function parseJobEvent(message: unknown): JobEvent | null {
  if (typeof message !== 'object' || message === null) return null;
  const m = message as Record<string, unknown>;
  if (m.type === 'cancelled') return { type: 'cancelled' };
  if (m.type === 'failed') return { type: 'failed', error: toAppError(m) };
  if (m.type === 'progress') {
    if (typeof m.phase !== 'string' || !PHASES.includes(m.phase) || !count(m.done) || !count(m.total)) return null;
    return { type: 'progress', phase: m.phase as JobPhase, done: m.done, total: m.total };
  }
  if (m.type === 'done') {
    if (!count(m.outputs) || !count(m.bytesBefore) || !count(m.bytesAfter)) return null;
    const warnings = Array.isArray(m.warnings)
      ? (m.warnings as unknown[]).filter((w): w is JobWarning => typeof w === 'string' && WARNINGS.includes(w))
      : [];
    const opened = m.opened === null || m.opened === undefined ? null : parseDocumentInfo(m.opened);
    return { type: 'done', outputs: m.outputs, bytesBefore: m.bytesBefore, bytesAfter: m.bytesAfter, warnings, opened };
  }
  return null;
}

function newChannel(onEvent: (event: JobEvent) => void): Channel<unknown> {
  return new Channel<unknown>((message) => {
    const event = parseJobEvent(message);
    if (event !== null) onEvent(event);
  });
}

function parseJobId(value: unknown): JobId | null {
  if (value === null || value === undefined) return null;
  if (!count(value)) throw toAppError(null);
  return value;
}

/** Shows Rust's Save As and writes the pages into a new file. `null`: the dialog was cancelled. */
export async function extractPages(
  docId: number,
  pages: PageId[],
  onEvent: (e: JobEvent) => void,
): Promise<JobId | null> {
  return parseJobId(await call<unknown>('extract_pages', { docId, pages, onEvent: newChannel(onEvent) }));
}

/** Shows Rust's folder dialog and writes the parts there. `null`: the dialog was cancelled. */
export async function splitDocument(
  docId: number,
  plan: SplitPlan,
  onEvent: (e: JobEvent) => void,
): Promise<JobId | null> {
  return parseJobId(await call<unknown>('split_document', { docId, plan, onEvent: newChannel(onEvent) }));
}

/** Merges 2 to 64 inputs into a new document, which arrives as `done.opened`. */
export async function mergeDocuments(inputs: MergeInput[], onEvent: (e: JobEvent) => void): Promise<JobId | null> {
  return parseJobId(await call<unknown>('merge_documents', { inputs, onEvent: newChannel(onEvent) }));
}

export async function compressDocument(
  docId: number,
  preset: CompressPreset,
  onEvent: (e: JobEvent) => void,
  saveAs = false,
): Promise<JobId | null> {
  return parseJobId(await call<unknown>('compress_document', { docId, preset, saveAs, onEvent: newChannel(onEvent) }));
}

export async function cancelJob(jobId: JobId): Promise<void> {
  await call<void>('cancel_job', { jobId });
}

/** The Rust open dialog for PDFs; the files stay in the backend. `[]`: cancelled. */
export async function pickPdfSources(multiple: boolean): Promise<SourceResult[]> {
  const answer = await call<unknown>('pick_pdf_sources', { multiple });
  if (!Array.isArray(answer) || answer.length > 32) throw toAppError(null);
  return (answer as unknown[]).map((item): SourceResult => {
    const m = (typeof item === 'object' && item !== null ? item : {}) as Record<string, unknown>;
    if (m.type === 'ready' && count(m.sourceId) && typeof m.displayName === 'string' && count(m.pageCount)) {
      return { type: 'ready', sourceId: m.sourceId, displayName: m.displayName, pageCount: m.pageCount };
    }
    if (m.type === 'failed') return { type: 'failed', error: toAppError(m) };
    throw toAppError(null);
  });
}

export async function releaseSource(sourceId: SourceId): Promise<void> {
  await call<void>('release_source', { sourceId });
}

/** The ids of the pages of a document in their current order (`get_pages`, ARCHITECTURE section 5). */
export async function listPageIds(docId: number): Promise<PageId[]> {
  const answer = await call<unknown>('get_pages', { docId });
  if (!Array.isArray(answer) || answer.length > 50_000) throw toAppError(null);
  return (answer as unknown[]).map((slot) => {
    const id = (slot as { id?: unknown } | null)?.id;
    if (!count(id)) throw toAppError(null);
    return id;
  });
}

/** What compressing a document would give: its size now and the estimate per preset, in bytes. */
export interface CompressEstimate {
  current: number;
  presets: Record<CompressPreset, number>;
}

/**
 * NOT in ARCHITECTURE yet: `estimate_compression(doc_id)`, the page sampling of DESIGN 3.31. Until R3 adds it the call rejects and
 * the dialog shows presets without an estimate.
 */
export async function estimateCompression(docId: number): Promise<CompressEstimate> {
  const answer = (await call<unknown>('estimate_compression', { docId })) as Partial<CompressEstimate> | null;
  const p = answer?.presets;
  if (!count(answer?.current) || p === undefined || !count(p.screen) || !count(p.ebook) || !count(p.print)) {
    throw toAppError(null);
  }
  return {
    current: answer.current,
    presets: { lossless: p.lossless ?? answer.current, screen: p.screen, ebook: p.ebook, print: p.print },
  };
}
