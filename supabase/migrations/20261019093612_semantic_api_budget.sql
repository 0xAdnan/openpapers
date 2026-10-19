BEGIN;
SET LOCAL statement_timeout = '5s';
SET LOCAL lock_timeout = '5s';
SELECT pg_advisory_xact_lock(764521340001);

CREATE SCHEMA IF NOT EXISTS openpapers AUTHORIZATION postgres;
CREATE TABLE IF NOT EXISTS openpapers.semantic_api_budget (
  key_hash text PRIMARY KEY CHECK (key_hash ~ '^[0-9a-f]{64}$'),
  next_request_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  cooldown_until timestamptz,
  leased_slot_token uuid,
  lease_until timestamptz,
  CHECK ((leased_slot_token IS NULL) = (lease_until IS NULL))
);
ALTER TABLE openpapers.semantic_api_budget OWNER TO postgres;
ALTER TABLE openpapers.semantic_api_budget ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON SCHEMA openpapers FROM PUBLIC;
REVOKE ALL ON TABLE openpapers.semantic_api_budget FROM PUBLIC;
DO $permissions$
DECLARE role_name text;
BEGIN
  FOREACH role_name IN ARRAY ARRAY['anon', 'authenticated', 'service_role'] LOOP
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = role_name) THEN
      EXECUTE format('REVOKE ALL ON SCHEMA openpapers FROM %I', role_name);
      EXECUTE format('REVOKE ALL ON TABLE openpapers.semantic_api_budget FROM %I', role_name);
    END IF;
  END LOOP;
END
$permissions$;
COMMIT;
