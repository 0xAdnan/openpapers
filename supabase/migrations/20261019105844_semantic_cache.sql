BEGIN;
SET LOCAL statement_timeout = '5s';
SET LOCAL lock_timeout = '5s';
SELECT pg_advisory_xact_lock(764521340001);

CREATE SCHEMA IF NOT EXISTS openpapers AUTHORIZATION postgres;
CREATE TABLE IF NOT EXISTS openpapers.semantic_cache (
  key_hash text PRIMARY KEY CHECK (key_hash ~ '^[0-9a-f]{64}$'),
  cache_key text NOT NULL CHECK (char_length(cache_key) BETWEEN 4 AND 1000 AND starts_with(cache_key, 's2:')
    AND cache_key !~ '[[:cntrl:]]' AND key_hash = encode(sha256(convert_to(cache_key, 'UTF8')), 'hex')),
  stored_at timestamptz NOT NULL CHECK (isfinite(stored_at) AND stored_at > 'epoch'::timestamptz),
  expires_at timestamptz NOT NULL CHECK (isfinite(expires_at) AND expires_at > 'epoch'::timestamptz),
  payload jsonb NOT NULL CHECK (jsonb_typeof(payload) = 'object' AND payload ? 'version'
    AND payload->'version' = '1'::jsonb AND payload ? 'value'),
  byte_count integer NOT NULL CHECK (byte_count BETWEEN 1 AND 4194304 AND
    byte_count = octet_length(payload::text) + octet_length(cache_key) + 256)
);
ALTER TABLE openpapers.semantic_cache OWNER TO postgres;
ALTER TABLE openpapers.semantic_cache ENABLE ROW LEVEL SECURITY;

-- Every writer shares the budget lock; reads do not refresh stored_at.
CREATE OR REPLACE FUNCTION openpapers.bound_semantic_cache() RETURNS trigger
LANGUAGE plpgsql SECURITY INVOKER SET search_path = pg_catalog AS $function$
DECLARE retained_count bigint; retained_bytes bigint; oldest_key text;
BEGIN
  PERFORM pg_advisory_xact_lock(764521340004);
  IF EXISTS (SELECT 1 FROM openpapers.semantic_cache
    WHERE key_hash = NEW.key_hash AND stored_at >= NEW.stored_at) THEN RETURN NULL; END IF;
  DELETE FROM openpapers.semantic_cache WHERE key_hash <> NEW.key_hash
    AND expires_at <= clock_timestamp() - interval '24 hours';
  SELECT count(*), coalesce(sum(byte_count), 0) INTO retained_count, retained_bytes
    FROM openpapers.semantic_cache WHERE key_hash <> NEW.key_hash;
  WHILE retained_count >= 128 OR retained_bytes + NEW.byte_count > 33554432 LOOP
    SELECT key_hash INTO oldest_key FROM openpapers.semantic_cache
      WHERE key_hash <> NEW.key_hash ORDER BY stored_at, key_hash LIMIT 1;
    IF oldest_key IS NULL THEN RAISE EXCEPTION 'Semantic cache entry exceeds budget'; END IF;
    DELETE FROM openpapers.semantic_cache WHERE key_hash = oldest_key;
    SELECT count(*), coalesce(sum(byte_count), 0) INTO retained_count, retained_bytes
      FROM openpapers.semantic_cache WHERE key_hash <> NEW.key_hash;
  END LOOP;
  RETURN NEW;
END
$function$;
ALTER FUNCTION openpapers.bound_semantic_cache() OWNER TO postgres;
DO $trigger$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgrelid = 'openpapers.semantic_cache'::regclass
    AND tgname = 'bound_semantic_cache') THEN
    CREATE TRIGGER bound_semantic_cache BEFORE INSERT OR UPDATE ON openpapers.semantic_cache
      FOR EACH ROW EXECUTE FUNCTION openpapers.bound_semantic_cache();
  END IF;
END
$trigger$;

REVOKE ALL ON SCHEMA openpapers FROM PUBLIC;
REVOKE ALL ON TABLE openpapers.semantic_cache FROM PUBLIC;
REVOKE ALL ON FUNCTION openpapers.bound_semantic_cache() FROM PUBLIC;
DO $permissions$
DECLARE role_name text;
BEGIN
  FOREACH role_name IN ARRAY ARRAY['anon', 'authenticated', 'service_role'] LOOP
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = role_name) THEN
      EXECUTE format('REVOKE ALL ON SCHEMA openpapers FROM %I', role_name);
      EXECUTE format('REVOKE ALL ON TABLE openpapers.semantic_cache FROM %I', role_name);
      EXECUTE format('REVOKE ALL ON FUNCTION openpapers.bound_semantic_cache() FROM %I', role_name);
    END IF;
  END LOOP;
END
$permissions$;
COMMIT;
