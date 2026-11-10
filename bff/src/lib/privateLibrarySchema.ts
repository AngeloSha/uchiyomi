/** Additive migration: existing content and account defaults remain shared. */
export const PRIVATE_LIBRARY_DDL = `
ALTER TABLE libraries ADD COLUMN IF NOT EXISTS owner_user_id uuid REFERENCES users(id) ON DELETE RESTRICT;
ALTER TABLE libraries ADD COLUMN IF NOT EXISTS managed_private boolean NOT NULL DEFAULT false;
CREATE UNIQUE INDEX IF NOT EXISTS libraries_private_owner_idx ON libraries(owner_user_id) WHERE managed_private;
ALTER TABLE lib_series ADD COLUMN IF NOT EXISTS owner_user_id uuid REFERENCES users(id) ON DELETE RESTRICT;
ALTER TABLE lib_series ADD COLUMN IF NOT EXISTS is_private boolean NOT NULL DEFAULT false;
ALTER TABLE lib_series ADD COLUMN IF NOT EXISTS private_published_at timestamptz;
CREATE INDEX IF NOT EXISTS lib_series_private_owner_idx ON lib_series(owner_user_id) WHERE is_private;
ALTER TABLE reading_events ADD COLUMN IF NOT EXISTS is_private boolean NOT NULL DEFAULT false;
ALTER TABLE read_progress ADD COLUMN IF NOT EXISTS is_private boolean NOT NULL DEFAULT false;
CREATE INDEX IF NOT EXISTS read_progress_private_user_idx ON read_progress(user_id) WHERE is_private;
-- Opaque provenance survives Forget/account removal so old audit references cannot become public.
CREATE TABLE IF NOT EXISTS private_resource_owners (
 resource_id text PRIMARY KEY,
 owner_user_id uuid NOT NULL,
 kind text NOT NULL CHECK(kind IN ('series','book'))
);
CREATE INDEX IF NOT EXISTS private_resource_owner_idx ON private_resource_owners(owner_user_id);
ALTER TABLE audit_log ADD COLUMN IF NOT EXISTS private_owner_ids uuid[] NOT NULL DEFAULT '{}';
ALTER TABLE chapter_comments ADD COLUMN IF NOT EXISTS is_private boolean NOT NULL DEFAULT false;
ALTER TABLE chapter_reactions ADD COLUMN IF NOT EXISTS is_private boolean NOT NULL DEFAULT false;
CREATE INDEX IF NOT EXISTS chapter_comments_private_user_idx ON chapter_comments(user_id) WHERE is_private;
CREATE INDEX IF NOT EXISTS chapter_reactions_private_user_idx ON chapter_reactions(user_id) WHERE is_private;
CREATE OR REPLACE FUNCTION remember_private_resource_owner() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE owner_id uuid;
BEGIN
 IF TG_TABLE_NAME='lib_series' THEN
  IF NEW.is_private THEN
   INSERT INTO private_resource_owners VALUES(NEW.id,NEW.owner_user_id,'series') ON CONFLICT DO NOTHING;
   INSERT INTO private_resource_owners SELECT id,NEW.owner_user_id,'book' FROM lib_books WHERE series_id=NEW.id ON CONFLICT DO NOTHING;
  END IF;
 ELSE
  SELECT owner_user_id INTO owner_id FROM lib_series WHERE id=NEW.series_id AND is_private;
  IF owner_id IS NOT NULL THEN INSERT INTO private_resource_owners VALUES(NEW.id,owner_id,'book') ON CONFLICT DO NOTHING; END IF;
 END IF;
 RETURN NEW;
END $$;
DO $$ BEGIN
 IF NOT EXISTS(SELECT 1 FROM pg_trigger WHERE tgname='remember_private_series_owner') THEN
  CREATE TRIGGER remember_private_series_owner AFTER INSERT OR UPDATE OF is_private,owner_user_id ON lib_series FOR EACH ROW EXECUTE FUNCTION remember_private_resource_owner();
 END IF;
 IF NOT EXISTS(SELECT 1 FROM pg_trigger WHERE tgname='remember_private_book_owner') THEN
  CREATE TRIGGER remember_private_book_owner AFTER INSERT OR UPDATE OF series_id ON lib_books FOR EACH ROW EXECUTE FUNCTION remember_private_resource_owner();
 END IF;
END $$;
INSERT INTO private_resource_owners SELECT id,owner_user_id,'series' FROM lib_series WHERE is_private ON CONFLICT DO NOTHING;
INSERT INTO private_resource_owners SELECT b.id,s.owner_user_id,'book' FROM lib_books b JOIN lib_series s ON s.id=b.series_id WHERE s.is_private ON CONFLICT DO NOTHING;
CREATE INDEX IF NOT EXISTS reading_events_private_user_idx ON reading_events(user_id) WHERE is_private;
DO $$ BEGIN
 IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='libraries_private_owner_check') THEN
  ALTER TABLE libraries ADD CONSTRAINT libraries_private_owner_check CHECK (managed_private = (owner_user_id IS NOT NULL));
 END IF;
 IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='lib_series_private_owner_check') THEN
  ALTER TABLE lib_series ADD CONSTRAINT lib_series_private_owner_check CHECK (NOT is_private OR owner_user_id IS NOT NULL);
 END IF;
END $$;
CREATE TABLE IF NOT EXISTS tracker_entry_privacy (
 user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
 provider text NOT NULL,
 external_id text NOT NULL,
 required_private boolean NOT NULL DEFAULT true,
 sync_state text NOT NULL DEFAULT 'pending' CHECK(sync_state IN ('pending','applied','error')),
 last_error text,
 updated_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY(user_id,provider,external_id)
);
`;
