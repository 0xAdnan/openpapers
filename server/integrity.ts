import type { Paper } from '../shared/types.ts';
import audit from '../data/integrity-audit.json';

export function auditedConflict(paper: Paper): string | undefined {
  const record = audit.records.find(record => record.id === paper.id);
  if (!record || paper.title !== record.liveTitle || paper.doi !== record.liveDoi || paper.year !== record.liveYear) return;
  return `Data integrity warning: record ${paper.id} has an independently observed publication-identity conflict. ${record.finding} Verify against ${record.authoritativeSource} before citing. Source metadata has not been rewritten.`;
}

export const SEEDS = [
  { doi: '10.48550/arXiv.1706.03762', field: 'Machine Learning', title: /attention is all you need/i, year: 2017 },
  { doi: '10.1126/science.1225829', field: 'Biology', title: /programmable dual.rna/i, year: 2012 },
  { doi: '10.1103/PhysRevLett.116.061102', field: 'Physics', title: /observation of gravitational waves/i, year: 2016 },
];

export function seedConflict(paper: Paper, seed: typeof SEEDS[number]): string | undefined {
  const expectedDoi = seed.doi.toLowerCase();
  const returnedDoi = paper.doi?.replace(/^https?:\/\/(?:dx\.)?doi\.org\//i, '').toLowerCase();
  if (returnedDoi === expectedDoi && paper.year === seed.year && seed.title.test(paper.title)) return;
  return `Data integrity warning: seed DOI ${expectedDoi} (expected year ${seed.year}, title matching ${seed.title.source}) resolved to record ${paper.id}, "${paper.title}", DOI ${returnedDoi ?? 'missing'}, year ${paper.year ?? 'missing'}. Returned source metadata is retained; this is not a verified match to the seed publication. Citation relationships are source-reported, not independently verified scholarly facts.`;
}
