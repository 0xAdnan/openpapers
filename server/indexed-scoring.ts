import type { GraphEdge, GraphPaper, Paper } from '../shared/types.ts';

export type EdgeEvidence = Omit<GraphEdge, 'source' | 'target'>;

export interface GraphIndex {
  readonly size: number;
  papers(): Iterable<Paper>;
  paper(id: string): Paper | undefined;
  evidence(a: string, b: string): EdgeEvidence;
  // Only positive-evidence candidate members, excluding the anchor.
  scores(anchor: string): Map<string, EdgeEvidence>;
  // Fetched members referenced by at least two distinct selected papers.
  prior(selected: string[]): GraphPaper[];
}

export class ReferenceIndex implements GraphIndex {
  private readonly records = new Map<string, Paper>();
  private readonly outgoing = new Map<string, Set<string>>();
  // External targets matter for coupling; every member citer contributes, displayed or not.
  private readonly incoming = new Map<string, string[]>();

  constructor(papers: Iterable<Paper>) {
    for (const paper of papers) {
      this.records.set(paper.id, paper);
      if (this.records.size > 50_000) throw new RangeError('Graph index exceeds the limit of 50,000 unique candidate papers');
    }
    let referenceCount = 0;
    for (const paper of this.records.values()) {
      referenceCount += paper.references.length;
      if (referenceCount > 2_000_000) throw new RangeError('Graph index exceeds the limit of 2,000,000 reference entries; reduce the candidate pool');
    }
    for (const paper of this.records.values()) {
      const references = new Set(paper.references);
      references.delete(paper.id);
      this.outgoing.set(paper.id, references);
      for (const reference of references) {
        const posting = this.incoming.get(reference);
        if (posting) posting.push(paper.id);
        else this.incoming.set(reference, [paper.id]);
      }
    }
  }

  get size(): number { return this.records.size; }
  papers(): Iterable<Paper> { return this.records.values(); }
  paper(id: string): Paper | undefined { return this.records.get(id); }

  private references(id: string): Set<string> {
    const references = this.outgoing.get(id);
    if (!references) throw new Error(`Graph paper ${id} is missing from the index`);
    return references;
  }

  private weight(a: string, b: string, sharedReferences: number, coCitations: number): number {
    const ra = this.references(a).size, rb = this.references(b).size;
    const ca = this.incoming.get(a)?.length ?? 0, cb = this.incoming.get(b)?.length ?? 0;
    return ((ra && rb ? sharedReferences / Math.sqrt(ra * rb) : 0)
      + (ca && cb ? coCitations / Math.sqrt(ca * cb) : 0)) / 2;
  }

  evidence(a: string, b: string): EdgeEvidence {
    const ra = this.references(a), rb = this.references(b);
    const [small, large] = ra.size <= rb.size ? [ra, rb] : [rb, ra];
    let sharedReferences = 0, coCitations = 0;
    for (const id of small) if (large.has(id)) sharedReferences++;
    const ca = this.incoming.get(a) ?? [], cb = this.incoming.get(b) ?? [];
    const [citers, target] = ca.length <= cb.length ? [ca, b] : [cb, a];
    for (const citer of citers) if (this.outgoing.get(citer)!.has(target)) coCitations++;
    return { weight: this.weight(a, b, sharedReferences, coCitations), sharedReferences, coCitations };
  }

  scores(anchor: string): Map<string, EdgeEvidence> {
    const scores = new Map<string, EdgeEvidence>();
    const add = (id: string, field: 'sharedReferences' | 'coCitations') => {
      if (id === anchor) return;
      let evidence = scores.get(id);
      if (!evidence) { evidence = { weight: 0, sharedReferences: 0, coCitations: 0 }; scores.set(id, evidence); }
      evidence[field]++;
    };
    for (const reference of this.references(anchor)) {
      for (const citer of this.incoming.get(reference)!) add(citer, 'sharedReferences');
    }
    for (const citer of this.incoming.get(anchor) ?? []) {
      for (const reference of this.outgoing.get(citer)!) {
        if (this.records.has(reference)) add(reference, 'coCitations');
      }
    }
    for (const [id, evidence] of scores) {
      evidence.weight = this.weight(anchor, id, evidence.sharedReferences, evidence.coCitations);
    }
    return scores;
  }

  prior(selected: string[]): GraphPaper[] {
    const counts = new Map<string, number>();
    for (const id of new Set(selected)) {
      for (const reference of this.references(id)) {
        if (this.records.has(reference)) counts.set(reference, (counts.get(reference) ?? 0) + 1);
      }
    }
    return [...counts].filter(([, count]) => count >= 2).map(([id, graphConnections]) => ({
      ...this.records.get(id)!, graphConnections, similarity: 0, sharedReferences: 0, coCitations: 0, isOrigin: false,
    }));
  }
}
