-- Run once through a privileged database connection after setting these Vault secrets:
-- openpapers_worker_url = https://openpapers-psi.vercel.app/api/internal/graph-worker
-- openpapers_worker_token = the same private token configured in Vercel's GRAPH_WORKER_TOKEN.
-- No browser key or database password belongs in this file.
CREATE EXTENSION IF NOT EXISTS pg_cron;
CREATE EXTENSION IF NOT EXISTS pg_net;

SELECT cron.schedule('openpapers-graph-worker', '* * * * *', $$
  SELECT net.http_post(
    url := (SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name = 'openpapers_worker_url' LIMIT 1),
    headers := jsonb_build_object('Content-Type', 'application/json', 'Authorization',
      'Bearer ' || (SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name = 'openpapers_worker_token' LIMIT 1)),
    body := '{}'::jsonb,
    timeout_milliseconds := 55000
  ) WHERE EXISTS (SELECT 1 FROM openpapers.graph_jobs WHERE state IN ('queued', 'paused', 'running')
    AND (next_run_at IS NULL OR next_run_at <= now()));
$$);
