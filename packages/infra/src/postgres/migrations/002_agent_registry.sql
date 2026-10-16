-- 002_agent_registry.sql
-- The registry has to say who put a principal on the board. Attribution is a domain rule, so the
-- credential row carries it: a token that cannot name who minted it is a token the audit trail can
-- only describe, not explain.
--
-- `registered_at` is the storage's own record of when the row was written, not the domain clock. The
-- port does not hand the adapter a timestamp, and a registry that invented one would be a second
-- clock — the domain already owns time for everything that has to be decided.

ALTER TABLE api_tokens ADD COLUMN created_by text REFERENCES actors(id) ON DELETE SET NULL;
ALTER TABLE api_tokens ADD COLUMN run_id text;
ALTER TABLE api_tokens ADD COLUMN registered_at timestamptz NOT NULL DEFAULT now();

-- The roster read orders by type and name, which is the order the panel shows.
CREATE INDEX api_tokens_actor_idx ON api_tokens (actor_id);
