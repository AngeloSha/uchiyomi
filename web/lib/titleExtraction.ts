import { keys } from './i18n';
import { sameCoverSelection, type CoverTitleRect } from './coverTitleRegions';
import type { TitleMaskStroke } from './titleMaskRaster';

export interface TitleExtractionCapabilities {
  available: boolean; reason: string | null; automaticAvailable: boolean; automaticApplyAvailable: boolean;
  maxExclusions: number; timeoutSeconds: number;
  maskCorrection?: boolean;
}
export interface TitleExtractionMask {
  revision: number; strokes: TitleMaskStroke[];
  canvas: { width: number; height: number; sourceUrl: string; baselineUrl: string };
  previewRegion?: CoverTitleRect | null;
}
export interface TitleExtractionJob {
  id: string; seriesId: string; automatic: boolean;
  status: 'queued' | 'running' | 'ready' | 'rejected' | 'error' | 'expired' | 'applied';
  createdAt: string; expiresAt: string; previewUrl: string | null; coverPreviewUrl: string | null;
  region: CoverTitleRect | null; exclusions: CoverTitleRect[]; reasons: string[]; error: string | null;
  selectionMode?: 'manual' | 'automatic' | 'legacy';
  resultRegion?: CoverTitleRect | null;
  candidateRegion?: CoverTitleRect | null;
  mask?: TitleExtractionMask | null;
  quality: Record<string, unknown> | null;
}
export const EXTRACTION_CAPABILITIES_KEY = ['title-extraction-capabilities'] as const;
export const EXTRACTION_CAPABILITIES_URL = '/api/admin/title-extraction/capabilities';
export const extractionRoot = (id: string) => `/api/admin/series/${encodeURIComponent(id)}/title-extraction`;
/** A decoded preview is usable only for this job's exact saved correction revision. Never attach auth to remote URLs. */
export function extractionPreviewPath(seriesId: string, job: TitleExtractionJob | null): string | null {
  if (!job?.previewUrl || job.seriesId !== seriesId) return null;
  const path = `${extractionRoot(seriesId)}/${encodeURIComponent(job.id)}/preview`;
  if (!job.mask) return path;
  return Number.isSafeInteger(job.mask.revision) && job.mask.revision >= 0 ? `${path}?revision=${job.mask.revision}` : null;
}
export const extractionPreviewDecoded = (seriesId: string, job: TitleExtractionJob | null, decodedPath: string | null): boolean =>
  !!decodedPath && decodedPath === extractionPreviewPath(seriesId, job);
export const extractionActive = (job?: TitleExtractionJob | null): boolean => job?.status === 'queued' || job?.status === 'running';
export const extractionPoll = (job: TitleExtractionJob | null | undefined, failed = false, paused = false): number | false =>
  extractionActive(job) && !failed && !paused ? 1500 : false;
/** Detected/tight result boxes are evidence, not a new manual selection. Legacy jobs have no recoverable request. */
export function extractionJobSelection(job: TitleExtractionJob): { region: CoverTitleRect | null; exclusions: CoverTitleRect[] } {
  return { region: job.selectionMode === 'automatic' || job.selectionMode === 'legacy' ? null : job.region, exclusions: job.exclusions };
}
/** An old cutout is not a preview of an edited rectangle, even though its job is still available on the server. */
export function extractionSelectionChanged(job: TitleExtractionJob | null, selection: { region: CoverTitleRect | null; exclusions: CoverTitleRect[] }): boolean {
  return !!job && !sameCoverSelection(selection, extractionJobSelection(job));
}
export const extractionCanApply = (job: TitleExtractionJob | null, changed: boolean, stale: boolean, previewLoaded: boolean, busy: boolean): boolean =>
  job?.status === 'ready' && !changed && !stale && previewLoaded && !busy && Date.parse(job.expiresAt) > Date.now();

const WORDS = keys(
  'Cover title previews are not available on this server yet.',
  'The cover could not be read. Choose another cover and try again.',
  'Choose an area inside the cover and try again.',
  'This preview took too long. Try again, or choose a smaller title area.',
  'A title preview could not be created. Try again or adjust the title area.',
  'The cover or artwork changed. Create a new preview before applying.',
  'This preview has expired. Create a new one.',
  'The title could not be separated from the cover. Adjust the title area and try again.',
);
/** Stable server codes become product sentences; raw worker errors and model scores never reach the reader. */
export function extractionProblem(code?: string | null): string {
  if (code === 'worker_unavailable') return WORDS[0];
  if (code === 'cover_unavailable') return WORDS[1];
  if (code === 'invalid_selection' || code === 'bad_request') return WORDS[2];
  if (code === 'extract_timeout') return WORDS[3];
  if (code === 'stale_candidate' || code === 'stale_cover' || code === 'conflict') return WORDS[5];
  if (code === 'expired' || code === 'not_found') return WORDS[6];
  if (code === 'empty_mask' || code === 'empty_cutout' || code === 'no_text' || code === 'rejected') return WORDS[7];
  return WORDS[4];
}
