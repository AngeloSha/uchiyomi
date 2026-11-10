/** Additive, rollback-safe storage for reviewed imports. Scope snapshots are created only by contentScope. */
export const IMPORT_ENHANCEMENT_DDL = `
ALTER TABLE import_batches ADD COLUMN IF NOT EXISTS content_scope jsonb;
ALTER TABLE import_batches ADD COLUMN IF NOT EXISTS remaining_entries jsonb NOT NULL DEFAULT '[]';
ALTER TABLE import_batches ADD COLUMN IF NOT EXISTS next_batch_id uuid REFERENCES import_batches(id) ON DELETE SET NULL;
ALTER TABLE import_candidates ADD COLUMN IF NOT EXISTS tracker_links jsonb NOT NULL DEFAULT '[]';
ALTER TABLE import_candidates ADD COLUMN IF NOT EXISTS auto_matched_via text;
ALTER TABLE import_candidates ADD COLUMN IF NOT EXISTS ambiguous boolean NOT NULL DEFAULT false;
ALTER TABLE import_candidates ADD COLUMN IF NOT EXISTS auto_ambiguous boolean NOT NULL DEFAULT false;
ALTER TABLE import_candidates ADD COLUMN IF NOT EXISTS content_scope jsonb;
CREATE TABLE IF NOT EXISTS import_scoped_skips (
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  scope_key text NOT NULL,
  key text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, scope_key, key)
);
`;
