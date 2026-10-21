import { OpenAlexProvider, SELECT, normalizeWork, workId, type WorksPage, type OpenAlexWork } from './openalex.ts';
import type { Paper } from '../shared/types.ts';
import { PublisherReferences, referenceDoi } from './publisher-references.ts';
import { PdfReferences, resolvePdfReferences } from './pdf-references.ts';
import { pdfUrl } from './pdf-download.ts';

export interface CandidatePool {
  origin: string;
  papers: Paper[];
  fetchedAt: string;
  source: 'live' | 'cache';
  coverage: string;
  referenceRecovery?: 'crossref-v1' | 'bibliography-v2';
}

export async function collectCandidates(provider: OpenAlexProvider, origin: OpenAlexWork, signal?: AbortSignal, publisher?: PublisherReferences, pdf?: PdfReferences): Promise<CandidatePool> {
  signal?.throwIfAborted();
  const metadata = [provider.metadata(origin)];
  const id = workId(origin.id)!;
  const records = new Map<string, OpenAlexWork>([[id, origin]]);
  let recovery = '', referenceRecovery: CandidatePool['referenceRecovery'];
  if (publisher && !origin.referenced_works?.length && referenceDoi(origin.doi)) {
    referenceRecovery = 'crossref-v1';
    const deadline = AbortSignal.any([...(signal ? [signal] : []), AbortSignal.timeout(6000)]);
    try {
      const bibliography = await publisher.lookup(origin, deadline);
      if (!bibliography) throw new Error('Publisher bibliography unavailable');
      metadata.push({ source: 'cache', fetchedAt: bibliography.fetchedAt });
      const refs = new Set(bibliography.references);
      const mapped = refs.size ? await provider.request<WorksPage>('/works', {
        filter: `doi:${[...refs].map(doi => `https://doi.org/${doi}`).join('|')}`, per_page: '100', select: SELECT,
      }, deadline) : undefined;
      deadline.throwIfAborted();
      if (mapped) metadata.push(provider.metadata(mapped));
      const byDoi = new Map<string, OpenAlexWork[]>();
      for (const work of mapped?.results ?? []) {
        const doi = referenceDoi(work.doi);
        if (doi && refs.has(doi) && workId(work.id) !== id) byDoi.set(doi, [...(byDoi.get(doi) ?? []), work]);
      }
      const verified = [...byDoi.values()].filter(works => new Set(works.map(work => workId(work.id))).size === 1).map(works => works[0]);
      origin = { ...origin, referenced_works: verified.map(work => work.id) };
      records.set(id, origin);
      for (const work of verified) records.set(workId(work.id)!, work);
      recovery = `Crossref publisher bibliography: ${verified.length}/${refs.size} structured DOI references resolved to unique exact OpenAlex records. Unstructured and unresolved references were not guessed.`;
    } catch {
      signal?.throwIfAborted();
      recovery = 'Publisher reference recovery unavailable; the indexed bibliography remains incomplete.';
    }
  }
  if (pdf && !origin.referenced_works?.length && referenceDoi(origin.doi) &&
      pdfUrl(origin.best_oa_location?.pdf_url ?? origin.primary_location?.pdf_url)) {
    referenceRecovery = 'bibliography-v2';
    const deadline = AbortSignal.any([...(signal ? [signal] : []), AbortSignal.timeout(12000)]);
    try {
      const bibliography = await pdf.lookup(origin, deadline);
      if (!bibliography) throw new Error('PDF bibliography unavailable');
      const resolved = await resolvePdfReferences(provider, bibliography.references, id, deadline);
      signal?.throwIfAborted();
      metadata.push({ source: bibliography.source, fetchedAt: bibliography.fetchedAt }, ...resolved.metadata);
      origin = { ...origin, referenced_works: resolved.works.map(work => work.id) };
      records.set(id, origin);
      for (const work of resolved.works) records.set(workId(work.id)!, work);
      recovery += ` PDF bibliography: ${resolved.doiMatches} exact DOI and ${resolved.titleMatches} unique title/year/author matches from ${bibliography.references.length} eligible entries. DOI/title or year conflicts and ambiguous identities were excluded; at most 6 DOI-less titles checked. Source: ${bibliography.url} (SHA-256 ${bibliography.sha256}).`;
      if (resolved.incomplete) recovery += ' PDF title checks incomplete; available verified references retained.';
    } catch {
      signal?.throwIfAborted();
      recovery += ' PDF reference recovery unavailable; the bibliography remains incomplete.';
    }
  }
  const add = (works: OpenAlexWork[]) => {
    for (const work of works) {
      const key = workId(work.id);
      if (key && key !== id && records.size < 300) records.set(key, work);
    }
  };
  const refs = (origin.referenced_works ?? []).map(workId).filter((x): x is string => !!x);
  const related = (origin.related_works ?? []).map(workId).filter((x): x is string => !!x);
  const batchIds = [...refs.slice(0, 90), ...related.slice(0, 25)].filter(key => !records.has(key));
  const acquisitions = await Promise.allSettled([
    provider.batch(batchIds, signal),
    provider.request<WorksPage>('/works', { filter: `cites:${id}`, sort: 'cited_by_count:desc', per_page: '100', select: SELECT }, signal),
    refs.length ? provider.request<WorksPage>('/works', {
      filter: `cites:${refs.slice(0, 8).join('|')}`, sort: 'cited_by_count:desc', per_page: '50', select: SELECT,
    }, signal) : Promise.resolve(undefined),
  ]);
  signal?.throwIfAborted();
  for (const result of acquisitions) if (result.status === 'rejected') throw result.reason;
  const batch = (acquisitions[0] as PromiseFulfilledResult<OpenAlexWork[]>).value;
  const citing = (acquisitions[1] as PromiseFulfilledResult<WorksPage>).value;
  const shared = (acquisitions[2] as PromiseFulfilledResult<WorksPage | undefined>).value;
  if (batchIds.length) metadata.push(provider.metadata(batch));
  add(batch);
  metadata.push(provider.metadata(citing));
  add(citing.results);
  let sharedCount = 0;
  if (shared) {
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
    ...(referenceRecovery ? { referenceRecovery } : {}),
    origin: id, papers: [...records.values()].map(normalizeWork),
    fetchedAt: metadata.map(meta => meta.fetchedAt).sort()[0],
    source: metadata.some(meta => meta.source === 'live') ? 'live' : 'cache',
    coverage: `${recovery ? `${recovery} ` : ''}${records.size} fetched candidates: origin references (first 90/${refs.length}), related works (first 25/${related.length}), top ${citing.results.length}/${citing.meta.count} citing works by citation count, ${sharedCount} works citing any of the first 8 origin references, and fetched common references. Related works only nominate candidates, never create edges. Citation-ranked sampling is not exhaustive; co-citation is measured within this sample and favors influential papers. Missing references/abstracts and source indexing errors may reduce coverage.`,
  };
}
