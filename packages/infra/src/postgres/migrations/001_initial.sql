-- 001_initial.sql
-- Storage for the domain model. The schema mirrors the aggregates, but the invariants that
-- matter to the product are written down here too, so a raw INSERT cannot sneak past them.
-- Migration bookkeeping is deliberately not here: it belongs to the runner, not to the schema.

CREATE TABLE actors (
  id text PRIMARY KEY,
  type text NOT NULL CHECK (type IN ('human', 'agent')),
  name text NOT NULL,
  scopes text[] NOT NULL DEFAULT '{}'
);

-- Bearer tokens live here. Rate limiting and idempotency belong to the adapter, not to the
-- domain, so they get their own tables rather than polluting the aggregate.
CREATE TABLE api_tokens (
  token text PRIMARY KEY,
  actor_id text NOT NULL REFERENCES actors(id) ON DELETE CASCADE
);

CREATE TABLE boards (
  id text PRIMARY KEY,
  name text NOT NULL,
  slug text NOT NULL UNIQUE CHECK (slug ~ '^[A-Z][A-Z0-9]*$'),
  workflow_id text NOT NULL
);

CREATE TABLE board_members (
  board_id text NOT NULL REFERENCES boards(id) ON DELETE CASCADE,
  actor_id text NOT NULL REFERENCES actors(id) ON DELETE CASCADE,
  role text NOT NULL CHECK (role IN ('viewer', 'member', 'admin', 'agent')),
  PRIMARY KEY (board_id, actor_id)
);

CREATE TABLE workflows (
  id text PRIMARY KEY,
  board_id text NOT NULL REFERENCES boards(id) ON DELETE CASCADE,
  name text NOT NULL
);

CREATE TABLE workflow_states (
  id text PRIMARY KEY,
  workflow_id text NOT NULL REFERENCES workflows(id) ON DELETE CASCADE,
  name text NOT NULL,
  category text NOT NULL CHECK (category IN ('todo', 'in_progress', 'done')),
  is_human_gate boolean NOT NULL DEFAULT false,
  wip_limit integer CHECK (wip_limit IS NULL OR wip_limit > 0),
  "order" integer NOT NULL
);

CREATE TABLE workflow_transitions (
  id text PRIMARY KEY,
  workflow_id text NOT NULL REFERENCES workflows(id) ON DELETE CASCADE,
  from_state text NOT NULL REFERENCES workflow_states(id) ON DELETE CASCADE,
  to_state text NOT NULL REFERENCES workflow_states(id) ON DELETE CASCADE,
  name text NOT NULL,
  allowed_roles text[] NOT NULL DEFAULT '{}',
  required_fields text[] NOT NULL DEFAULT '{}',
  CHECK (from_state <> to_state)
);

-- Board-scoped, monotonic, never reused. Deliberately a table, not a Postgres SEQUENCE:
-- a sequence advances even when the transaction that took the number rolls back, which
-- would leave a key attached to a task that does not exist.
CREATE TABLE task_key_sequences (
  board_slug text PRIMARY KEY,
  next_value bigint NOT NULL DEFAULT 0 CHECK (next_value >= 0)
);

CREATE TABLE tasks (
  id text PRIMARY KEY,
  board_id text NOT NULL REFERENCES boards(id) ON DELETE CASCADE,
  key text NOT NULL UNIQUE,
  title text NOT NULL CHECK (title <> ''),
  description text NOT NULL DEFAULT '',
  status_id text NOT NULL REFERENCES workflow_states(id) ON DELETE CASCADE,
  priority text NOT NULL CHECK (priority IN ('lowest', 'low', 'medium', 'high', 'highest')),
  assignee_id text REFERENCES actors(id) ON DELETE SET NULL,
  reporter_id text NOT NULL REFERENCES actors(id) ON DELETE CASCADE,
  labels text[] NOT NULL DEFAULT '{}',
  acceptance_criteria text[] NOT NULL DEFAULT '{}',
  version integer NOT NULL DEFAULT 1 CHECK (version >= 1),
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL
);

CREATE INDEX tasks_board_status_idx ON tasks (board_id, status_id);
CREATE INDEX tasks_board_created_idx ON tasks (board_id, created_at, id);
CREATE INDEX tasks_assignee_idx ON tasks (board_id, assignee_id);

CREATE TABLE task_blockers (
  task_id text NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  blocked_by_task_id text NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  PRIMARY KEY (task_id, blocked_by_task_id),
  CHECK (task_id <> blocked_by_task_id)
);

CREATE TABLE comments (
  id text PRIMARY KEY,
  task_id text NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  author_id text NOT NULL REFERENCES actors(id) ON DELETE CASCADE,
  kind text NOT NULL CHECK (kind IN ('note', 'result', 'question', 'handoff', 'escalation')),
  body text NOT NULL CHECK (body <> ''),
  run_id text,
  created_at timestamptz NOT NULL
);

-- A work claim. Distinct from assignment, so it is its own table: a task can be assigned to
-- one actor while the lease is held by another.
CREATE TABLE leases (
  task_id text PRIMARY KEY REFERENCES tasks(id) ON DELETE CASCADE,
  agent_id text NOT NULL REFERENCES actors(id) ON DELETE CASCADE,
  acquired_at timestamptz NOT NULL,
  expires_at timestamptz NOT NULL,
  renew_count integer NOT NULL DEFAULT 0 CHECK (renew_count >= 0),
  CHECK (expires_at > acquired_at)
);

CREATE TABLE activity_events (
  id text PRIMARY KEY,
  board_id text NOT NULL REFERENCES boards(id) ON DELETE CASCADE,
  task_id text NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  actor_id text NOT NULL REFERENCES actors(id) ON DELETE CASCADE,
  run_id text,
  type text NOT NULL,
  at timestamptz NOT NULL,
  payload jsonb NOT NULL DEFAULT '{}'
);

CREATE INDEX activity_task_idx ON activity_events (task_id, at, id);
CREATE INDEX activity_board_idx ON activity_events (board_id, at, id);

-- Append-only is a domain rule, so it is enforced here rather than left to convention.
CREATE OR REPLACE FUNCTION forbid_activity_mutation() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'activity_events is append-only (attempted % on row %)', TG_OP, OLD.id;
END;
$$;

CREATE TRIGGER activity_events_append_only
  BEFORE UPDATE OR DELETE ON activity_events
  FOR EACH ROW EXECUTE FUNCTION forbid_activity_mutation();

-- The domain port hands the adapter an event without an id, so the id is generated here. It
-- cannot be the aggregate id: one task produces many events.
CREATE TABLE outbox_events (
  id text PRIMARY KEY DEFAULT gen_random_uuid()::text,
  aggregate_id text NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  board_id text NOT NULL REFERENCES boards(id) ON DELETE CASCADE,
  actor_id text NOT NULL REFERENCES actors(id) ON DELETE CASCADE,
  run_id text,
  type text NOT NULL,
  at timestamptz NOT NULL,
  payload jsonb NOT NULL DEFAULT '{}',
  dispatched_at timestamptz
);

-- Partial index keeps the dispatcher's drain cheap: it only ever looks at undispatched rows.
CREATE INDEX outbox_undispatched_idx ON outbox_events (at, id) WHERE dispatched_at IS NULL;
