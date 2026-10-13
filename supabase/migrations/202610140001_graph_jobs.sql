BEGIN;
SET LOCAL statement_timeout = '20s';
SET LOCAL lock_timeout = '20s';
SELECT pg_advisory_xact_lock(764521340001);

CREATE SCHEMA IF NOT EXISTS openpapers AUTHORIZATION postgres;
REVOKE ALL ON SCHEMA openpapers FROM PUBLIC;

CREATE TABLE IF NOT EXISTS openpapers.schema_migrations (
  version text PRIMARY KEY,
  applied_at timestamptz NOT NULL DEFAULT clock_timestamp()
);

CREATE TABLE IF NOT EXISTS openpapers.graph_jobs (
  id uuid PRIMARY KEY,
  cache_key text NOT NULL UNIQUE CHECK (cache_key ~ '^[0-9a-f]{64}$'),
  version text NOT NULL,
  origins text[] NOT NULL CHECK (cardinality(origins) BETWEEN 1 AND 3),
  state text NOT NULL CHECK (state IN ('queued', 'running', 'paused', 'completed', 'failed')),
  phase text NOT NULL CHECK (phase IN ('acquire', 'score', 'publish')),
  candidate_budget integer NOT NULL CHECK (candidate_budget BETWEEN 40 AND 50000),
  acquired_count integer NOT NULL DEFAULT 0 CHECK (acquired_count BETWEEN 0 AND candidate_budget),
  reference_budget integer NOT NULL CHECK (reference_budget BETWEEN 1000 AND 2000000),
  reference_count integer NOT NULL DEFAULT 0 CHECK (reference_count BETWEEN 0 AND reference_budget),
  metadata_bytes integer NOT NULL DEFAULT 0 CHECK (metadata_bytes >= 0),
  request_budget integer NOT NULL CHECK (request_budget BETWEEN 1 AND 1500),
  requests_used integer NOT NULL DEFAULT 0 CHECK (requests_used BETWEEN 0 AND request_budget),
  request_reserved boolean NOT NULL DEFAULT false,
  checkpoint jsonb NOT NULL CHECK (jsonb_typeof(checkpoint) = 'object' AND octet_length(checkpoint::text) <= 2097152),
  result jsonb CHECK (jsonb_typeof(result) = 'object' AND octet_length(result::text) <= 4194304),
  stop_reason text CHECK (length(stop_reason) <= 200),
  error text CHECK (length(error) <= 2000),
  lease_token uuid,
  lease_expires_at timestamptz,
  next_run_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  CHECK ((state = 'running') = (lease_token IS NOT NULL AND lease_expires_at IS NOT NULL)),
  CHECK ((lease_token IS NULL) = (lease_expires_at IS NULL)),
  CHECK (NOT request_reserved OR state = 'running'),
  CHECK (state <> 'paused' OR next_run_at IS NOT NULL),
  CHECK ((state = 'completed') = (result IS NOT NULL))
);
-- Also upgrades an already-created development schema when this migration is rerun.
ALTER TABLE openpapers.graph_jobs ADD COLUMN IF NOT EXISTS caller_key text
  CHECK (caller_key ~ '^[0-9a-f]{64}$');
CREATE INDEX IF NOT EXISTS graph_jobs_caller_active ON openpapers.graph_jobs (caller_key)
  WHERE state IN ('queued', 'running', 'paused');
CREATE INDEX IF NOT EXISTS graph_jobs_due ON openpapers.graph_jobs (next_run_at, created_at)
  WHERE state IN ('queued', 'paused');
CREATE INDEX IF NOT EXISTS graph_jobs_expired_leases ON openpapers.graph_jobs (lease_expires_at)
  WHERE state = 'running';
CREATE INDEX IF NOT EXISTS graph_jobs_retention ON openpapers.graph_jobs (updated_at DESC)
  WHERE state IN ('completed', 'failed');

CREATE TABLE IF NOT EXISTS openpapers.job_papers (
  job_id uuid NOT NULL REFERENCES openpapers.graph_jobs(id) ON DELETE CASCADE,
  id text NOT NULL CHECK (id ~ '^W[1-9][0-9]{0,14}$'),
  metadata jsonb NOT NULL CHECK (jsonb_typeof(metadata) = 'object' AND NOT metadata ? 'references'),
  metadata_bytes integer NOT NULL CHECK (metadata_bytes BETWEEN 1 AND 262144),
  fetched_at timestamptz NOT NULL,
  PRIMARY KEY (job_id, id)
);

-- Targets need not be candidates. Edges belong to this job's acquired revision only.
CREATE TABLE IF NOT EXISTS openpapers.job_references (
  job_id uuid NOT NULL,
  source text NOT NULL,
  target text NOT NULL CHECK (target ~ '^W[1-9][0-9]{0,14}$'),
  PRIMARY KEY (job_id, source, target),
  FOREIGN KEY (job_id, source) REFERENCES openpapers.job_papers(job_id, id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS job_references_incoming ON openpapers.job_references (job_id, target, source);

CREATE TABLE IF NOT EXISTS openpapers.provider_budget (
  provider text PRIMARY KEY CHECK (provider = 'openalex'),
  budget_day date NOT NULL,
  daily_requests integer NOT NULL DEFAULT 0 CHECK (daily_requests >= 0),
  daily_budget integer NOT NULL CHECK (daily_budget BETWEEN 1 AND 1500),
  next_request_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  cooldown_until timestamptz
);

-- Admission survives job deletion and process restarts; cache hits do not consume it.
CREATE TABLE IF NOT EXISTS openpapers.graph_admission (
  caller_key text NOT NULL CHECK (caller_key ~ '^[0-9a-f]{64}$'),
  budget_day date NOT NULL,
  submissions integer NOT NULL CHECK (submissions BETWEEN 1 AND 2),
  PRIMARY KEY (caller_key, budget_day)
);

ALTER TABLE openpapers.schema_migrations OWNER TO postgres;
ALTER TABLE openpapers.graph_jobs OWNER TO postgres;
ALTER TABLE openpapers.job_papers OWNER TO postgres;
ALTER TABLE openpapers.job_references OWNER TO postgres;
ALTER TABLE openpapers.provider_budget OWNER TO postgres;
ALTER TABLE openpapers.graph_admission OWNER TO postgres;
ALTER TABLE openpapers.schema_migrations ENABLE ROW LEVEL SECURITY;
ALTER TABLE openpapers.graph_jobs ENABLE ROW LEVEL SECURITY;
ALTER TABLE openpapers.job_papers ENABLE ROW LEVEL SECURITY;
ALTER TABLE openpapers.job_references ENABLE ROW LEVEL SECURITY;
ALTER TABLE openpapers.provider_budget ENABLE ROW LEVEL SECURITY;
ALTER TABLE openpapers.graph_admission ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON ALL TABLES IN SCHEMA openpapers FROM PUBLIC;
ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA openpapers REVOKE ALL ON TABLES FROM PUBLIC;
-- No browser/service JWT role receives SQL access, including on Supabase.
DO $permissions$
DECLARE role_name text;
BEGIN
  FOREACH role_name IN ARRAY ARRAY['anon', 'authenticated', 'service_role'] LOOP
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = role_name) THEN
      EXECUTE format('REVOKE ALL ON SCHEMA openpapers FROM %I', role_name);
      EXECUTE format('REVOKE ALL ON ALL TABLES IN SCHEMA openpapers FROM %I', role_name);
      EXECUTE format('ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA openpapers REVOKE ALL ON TABLES FROM %I', role_name);
    END IF;
  END LOOP;
END
$permissions$;

INSERT INTO openpapers.schema_migrations(version) VALUES ('202610140001_graph_jobs') ON CONFLICT DO NOTHING;
COMMIT;
