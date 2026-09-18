// Shapes for the reviewable import (backup / MangaDex list / paste → match review → add). Mirrors
// import_batches / import_candidates in bff/src/lib/migrate.ts field for field — these come straight off
// `SELECT *`, so the server sends its column names as-is (same convention as e.g. `u.display_name` in the
// admin members list) rather than translating to camelCase.
import { t as tr } from './i18n';

export type ImportOrigin = 'backup' | 'mangadex' | 'paste';
export type ImportBatchState = 'resolving' | 'review' | 'importing' | 'done' | 'cancelled';
export type ImportDecision = 'unresolved' | 'auto' | 'manual' | 'skip';
export type MatchConfidence = 'same_source' | 'exact' | 'contains' | 'fuzzy';

export interface ImportBatch {
  id: string;
  user_id: string;
  origin: ImportOrigin;
  state: ImportBatchState;
  total: number;
  resolved: number;
  added: number;
  already: number;
  failed: number;
  created_at: string;
  updated_at: string;
  /** Computed by the GET route, not a DB column: `resolving` with nobody actually resolving it. */
  stale?: boolean;
}

export interface ImportCandidate {
  id: string;
  batch_id: string;
  ord: number;
  backup_title: string;
  backup_source_id_unsigned: string | null;
  backup_source_id_signed: string | null;
  backup_url: string | null;
  in_library: boolean;
  decision: ImportDecision;
  confidence: MatchConfidence | null;
  match_source: string | null;
  match_source_id: string | null;
  match_title: string | null;
  match_cover: string | null;
  auto_source: string | null;
  auto_source_id: string | null;
  auto_title: string | null;
  auto_cover: string | null;
  auto_confidence: MatchConfidence | null;
  status: string | null;
}

/** A row worth a second look: no match at all, or one uncertain enough that a person should confirm it. */
export function needsAttention(c: ImportCandidate): boolean {
  if (c.decision === 'skip') return false;
  if (c.decision === 'unresolved') return true; // once the batch is out of 'resolving', this means "no match found"
  return c.decision === 'auto' && c.confidence === 'fuzzy';
}

/** Short label for the confidence chip. `keys()` isn't needed here — every call site passes a literal. */
export function confidenceLabel(c: MatchConfidence | null): string {
  switch (c) {
    case 'same_source': return tr('same source as before');
    case 'exact': return tr('exact match');
    case 'contains': return tr('close match');
    case 'fuzzy': return tr('possible match');
    default: return tr('unmatched');
  }
}

/** Tailwind text colour for the confidence chip, matching the amber/emerald vocabulary used elsewhere
 *  (health status, chapter cadence) rather than inventing a third palette for this one screen. */
export function confidenceColor(c: MatchConfidence | null): string {
  switch (c) {
    case 'same_source':
    case 'exact': return 'text-emerald-400';
    case 'contains': return 'text-fog-400';
    case 'fuzzy': return 'text-amber-400';
    default: return 'text-amber-400';
  }
}
