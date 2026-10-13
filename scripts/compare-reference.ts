import { createHash } from 'node:crypto';
import { readFile, stat } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { buildGraph } from '../server/graph.ts';
import type { Paper } from '../shared/types.ts';

// Analyze saved public DOM evidence only; never replay the reference site's API.
const capturePath = process.argv[2];
if (!capturePath) throw new Error('Usage: npx tsx scripts/compare-reference.ts /absolute/path/to/graph.focused.json [production.js]');
const snapshotPath = fileURLToPath(new URL('../data/snapshot.json', import.meta.url));
const captureBytes = await readFile(capturePath), snapshotBytes = await readFile(snapshotPath);
const capture = JSON.parse(captureBytes.toString()) as { svg: { circles: { class: string | null; text: string }[] }[] };
const snapshot = JSON.parse(snapshotBytes.toString()) as { groups: { origin: string; papers: Paper[]; fetchedAt: string; coverage: string }[] };
const group = snapshot.groups.find(group => group.origin === 'W2626778328')!;
const graph = buildGraph(group.papers, [group.origin], { source: 'snapshot', fetchedAt: group.fetchedAt, candidateCount: group.papers.length, coverage: group.coverage, algorithm: '' });
const normalize = (title: string) => title.normalize('NFKD').replace(/\p{M}/gu, '').toLowerCase().replace(/[^\p{L}\p{N}]/gu, '');
const capturedTitles = capture.svg.flatMap(svg => svg.circles.filter(circle => circle.class === 'node-circle').map(circle => circle.text));
if (capturedTitles.length !== 41 || capturedTitles.some(title => !title)) throw new Error('Expected complete 41-node reference capture');
const reference = new Map(capturedTitles.map(title => [normalize(title), title]));
const local = new Map(graph.nodes.map(paper => [normalize(paper.title), paper.title]));
const intersection = [...reference.keys()].filter(title => local.has(title));
const union = new Set([...reference.keys(), ...local.keys()]);
const result = {
  measuredAt: new Date().toISOString(),
  method: 'Unique normalized-title set agreement, not calibrated research relevance; local snapshot and saved public DOM only.',
  capture: { path: capturePath, sha256: createHash('sha256').update(captureBytes).digest('hex'), nodes: capturedTitles.length, uniqueTitles: reference.size },
  snapshot: { path: snapshotPath, sha256: createHash('sha256').update(snapshotBytes).digest('hex'), candidates: group.papers.length, nodes: graph.nodes.length, uniqueTitles: local.size },
  overlap: { uniqueTitles: intersection.length, referenceTitleRecall: intersection.length / reference.size, jaccard: intersection.length / union.size,
    titles: intersection.map(title => ({ reference: reference.get(title), local: local.get(title), localIds: graph.nodes.filter(paper => normalize(paper.title) === title).map(paper => paper.id) })) },
  ...(process.argv[3] ? { javascriptArtifactBytes: (await stat(process.argv[3])).size } : {}),
};
console.info(JSON.stringify(result, null, 2));
