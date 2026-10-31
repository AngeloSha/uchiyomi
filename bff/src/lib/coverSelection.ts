import { createHash } from 'node:crypto';
import { firstPageBookOf } from './seriesArt';
/** Stored cover selection and checked identity; shared by draft snapshots and cover-derived title fallbacks. */
export const coverSelectionSql = (s: string) => `jsonb_build_object(
  'library',${s}.library_id,'title',${s}.title,'source',${s}.source_id,
  'override',(SELECT jsonb_build_object('cover',oc.cover,'title',oc.title,'at',oc.updated_at) FROM series_overrides oc WHERE oc.series_id=${s}.id),
  'cover',(SELECT ac.cover FROM series_art ac WHERE ac.series_id=${s}.id),
  'page',${firstPageBookOf(s)},
  'links',(SELECT jsonb_agg(jsonb_build_array(tc.provider,tc.external_id) ORDER BY tc.provider) FROM series_trackers tc
    WHERE tc.series_id=${s}.id AND (tc.checked_at IS NOT NULL OR tc.linked_by IS NOT NULL)))::text`;
export const coverSelectionKey = (selection: unknown) => createHash('sha256').update(typeof selection === 'string' ? selection : JSON.stringify(selection)).digest('hex');
export const coverSelectionHashSql = (s: string) => `encode(sha256(convert_to(${coverSelectionSql(s)},'UTF8')),'hex')`;
