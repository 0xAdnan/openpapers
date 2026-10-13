import { createHash, randomUUID } from 'node:crypto';
import { mkdir, rename, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { PersistentCache } from '../server/cache.ts';
import { collectCandidates, type CandidatePool } from '../server/collection.ts';
import { OpenAlexProvider, normalizeWork } from '../server/openalex.ts';
import { SEEDS, seedConflict } from '../server/integrity.ts';
import type { Example } from '../shared/types.ts';

const directory = fileURLToPath(new URL('../data/', import.meta.url));
const provider = new OpenAlexProvider({
  cache: new PersistentCache(fileURLToPath(new URL('../.cache/refresh/', import.meta.url))),
  apiKey: process.env.OPENALEX_API_KEY,
  offline: process.env.OFFLINE === '1',
  maxRequests: 29,
  timeoutMs: 20000,
});
const seeds = SEEDS;
const examples: Example[] = [];
const groups: CandidatePool[] = [];
async function rejectSeed(seed: typeof SEEDS[number], warning: string, returnedRecords: unknown[]): Promise<never> {
  await mkdir(directory, { recursive: true });
  await writeFile(`${directory}refresh-anomalies.json`, JSON.stringify({
    checkedAt: new Date().toISOString(), snapshotReplaced: false,
    seed: { doi: seed.doi, field: seed.field, expectedYear: seed.year, expectedTitlePattern: seed.title.source },
    warning, returnedRecords, acquisitions: provider.acquisitions,
  }, null, 2));
  throw new Error(`${warning}; snapshot and manifest were not replaced. See data/refresh-anomalies.json`);
}
for (const seed of seeds) {
  const page = await provider.search(seed.doi, 1);
  const origin = page.results.find(work => seed.title.test(work.display_name ?? ''));
  const conflict = origin ? seedConflict(normalizeWork(origin), seed) : `OpenAlex did not resolve expected seed DOI ${seed.doi}`;
  if (conflict) await rejectSeed(seed, conflict, page.results);
  if (!origin) throw new Error('Missing validated seed');
  const group = await collectCandidates(provider, origin);
  if (group.papers.length < 100) throw new Error(`Insufficient candidates for ${seed.field}; snapshot was not replaced`);
  const paper = group.papers.find(p => p.id === group.origin)!;
  // A later batch can return a different revision of the same provider ID.
  const finalConflict = seedConflict(paper, seed);
  if (finalConflict) await rejectSeed(seed, finalConflict, [paper]);
  examples.push({ id: paper.id, title: paper.title, field: seed.field, author: paper.authors[0] ?? '', year: paper.year! });
  groups.push(group);
  console.info(`${seed.field}: ${paper.id}, ${group.papers.length} provider-sourced OpenAlex candidates`);
}
const fetchedAt = groups.map(g => g.fetchedAt).sort()[0];
const identifiers = Object.fromEntries(seeds.map((seed, i) => [seed.doi.toLowerCase(), groups[i].origin]));
const snapshot = { version: 1, provider: 'https://api.openalex.org', license: 'CC0', fetchedAt, examples, identifiers, groups };
const body = JSON.stringify(snapshot);
const manifest = {
  version: 1, generatedAt: new Date().toISOString(), snapshotSha256: createHash('sha256').update(body).digest('hex'),
  requestsMade: provider.acquisitions.filter(a => !a.fromCache).length, requestLimit: 29,
  seedDois: seeds.map(seed => seed.doi), acquisitions: provider.acquisitions,
  caveat: 'OpenAlex is mutable: the same query can return different data later. Snapshot retains exact normalized fetched metadata and reference identifiers. hashKind identifies original-response versus reserialized-json hashes; snapshot hash covers the normalized bundle. Cached acquisitions retain their original cache time, not this refresh time.',
};
// Generated data only; publish after every seed has passed validation.
await mkdir(directory, { recursive: true });
const temporary = `${directory}snapshot-${randomUUID()}.tmp`;
await writeFile(temporary, body);
await rename(temporary, `${directory}snapshot.json`);
await writeFile(`${directory}manifest.json`, JSON.stringify(manifest, null, 2));
console.info(`Wrote data/snapshot.json (${Buffer.byteLength(body)} bytes); ${manifest.requestsMade} network requests, hard limit 29.`);
