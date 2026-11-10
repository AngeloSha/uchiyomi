// Additive, account-owned choices. External saves do not pretend to be downloaded library series.
export const DISCOVERY_HUB_DDL = `
CREATE TABLE IF NOT EXISTS discover_feedback (
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  work_key text NOT NULL CHECK (length(work_key) BETWEEN 3 AND 602),
  saved boolean NOT NULL DEFAULT false,
  hidden boolean NOT NULL DEFAULT false,
  snapshot jsonb,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, work_key)
);
`;
