import { readFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import pg from 'pg';
import { graphPostgresPoolConfig } from '../server/postgres-store.ts';

/** Explicit operator action only. The request path never creates or alters tables. */
export async function migrateGraphJobs(databaseUrl: string): Promise<void> {
  const sql = await readFile(new URL('../supabase/migrations/202610140001_graph_jobs.sql', import.meta.url), 'utf8');
  const semanticSql = await readFile(new URL('../supabase/migrations/20261019093612_semantic_api_budget.sql', import.meta.url), 'utf8');
  const pool = new pg.Pool(graphPostgresPoolConfig(databaseUrl, { max: 1, ca: process.env.GRAPH_DATABASE_CA }));
  pool.on('error', () => {});
  try {
    const client = await pool.connect();
    try { await client.query(sql); await client.query(semanticSql); }
    catch (error) { await client.query('ROLLBACK').catch(() => {}); throw error; }
    finally { client.release(); }
  } finally { await pool.end(); }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) {
    console.error('DATABASE_URL is required; no migration was run.');
    process.exitCode = 1;
  } else {
    try {
      await migrateGraphJobs(databaseUrl);
      console.log('Graph jobs and Semantic Scholar budget migrations applied.');
    } catch {
      // Database errors can contain connection details; never print them here.
      console.error('Graph jobs migration failed; verify database access, verified TLS and postgres ownership.');
      process.exitCode = 1;
    }
  }
}
