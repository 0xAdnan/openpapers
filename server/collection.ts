import { OpenAlexProvider, SELECT, normalizeWork, workId, type WorksPage, type OpenAlexWork } from './openalex.ts';
import type { Paper } from '../shared/types.ts';

export interface CandidatePool {
  origin: string;
  papers: Paper[];
  fetchedAt: string;
  source: 'live' | 'cache';
  coverage: string;
}

export async function collectCandidates(provider: OpenAlexProvider, origin: OpenAlexWork, signal?: AbortSignal): Promise<CandidatePool> {
  signal?.throwIfAborted();
  const metadata = [provider.metadata(origin)];
  const id = workId(origin.id)!;
  const records = new Map<string, OpenAlexWork>([[id, origin]]);
  const add = (works: OpenAlexWork[]) => {
    for (const work of works) {
      const key = workId(work.id);
      if (key && records.size < 300) records.set(key, work);
    }
  };
  const refs = (origin.referenced_works ?? []).map(workId).filter((x): x is string => !!x);
  const related = (origin.related_works ?? []).map(workId).filter((x): x is string => !!x);
  const batch = await provider.batch([...refs.slice(0, 90), ...related.slice(0, 25)], signal);
  if (refs.length || related.length) metadata.push(provider.metadata(batch));
  add(batch);
  const citing = await provider.request<WorksPage>('/works', {
    filter: `cites:${id}`, sort: 'cited_by_count:desc', per_page: '100', select: SELECT,
  }, signal);
  metadata.push(provider.metadata(citing));
  add(citing.results);
  let sharedCount = 0;
  if (refs.length) {
    const shared = await provider.request<WorksPage>('/works', {
      filter: `cites:${refs.slice(0, 8).join('|')}`, sort: 'cited_by_count:desc', per_page: '50', select: SELECT,
    }, signal);
    metadata.push(provider.metadata(shared));
    sharedCount = shared.results.length;
    add(shared.results);
  }
  // Fetch frequently cited references for the prior-works view, not invented placeholders.
  const common = new Map<string, number>();
  for (const record of records.values()) {
    for (const reference of new Set(record.referenced_works ?? [])) {
      const key = workId(reference);
      if (key && !records.has(key)) common.set(key, (common.get(key) ?? 0) + 1);
    }
  }
  const missing = [...common].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, Math.min(100, 300 - records.size)).map(([key]) => key);
  const commonReferences = await provider.batch(missing, signal);
  if (missing.length) metadata.push(provider.metadata(commonReferences));
  add(commonReferences);
  signal?.throwIfAborted();
  return {
    origin: id, papers: [...records.values()].map(normalizeWork),
    fetchedAt: metadata.map(meta => meta.fetchedAt).sort()[0],
    source: metadata.some(meta => meta.source === 'live') ? 'live' : 'cache',
    coverage: `${records.size} fetched candidates: origin references (first 90/${refs.length}), related works (first 25/${related.length}), top ${citing.results.length}/${citing.meta.count} citing works by citation count, ${sharedCount} works citing any of the first 8 origin references, and fetched common references. Related works only nominate candidates, never create edges. Citation-ranked sampling is not exhaustive; co-citation is measured within this sample and favors influential papers. Missing references/abstracts and source indexing errors may reduce coverage.`,
  };
}
