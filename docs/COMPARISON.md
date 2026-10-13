# Connected Papers Comparison

**Verdict: close in the core interaction model, stronger in the tested narrow-screen layout and openness, not close enough in recommendation quality to claim an equivalent or superior research engine.**

This is an evidence-based comparison, not a subjective percentage of completion. Captured public Connected Papers screens and an independently built Open Papers app were inspected on 13 October 2026. No private backend, accounts, paid tier, physical phone, or exhaustive relevance benchmark was available.

## Workflow And Interface

| Area | Connected Papers Observed | Open Papers Verified | Assessment |
| --- | --- | --- | --- |
| Search | Semantic Scholar autocomplete and results | OpenAlex title/keyword/DOI/ID search, autocomplete, pagination | Same broad workflow, different retrieval provider |
| Desktop workspace | List, SVG graph, detail panes | Independent three-pane implementation | Close structure, deliberately not pixel identical |
| Graph interaction | Selection/help, documented similarity paths | Selection, paths, drag/pan/zoom, year legend, bounded node radii | Core exploration implemented; layouts not equivalent |
| Related papers | Prior, derivative, sortable list | All three, actual sampled graph connection counts | Functional counterpart, not equivalent lists |
| Filters | Year, keyword, PDF, OA, code controls observed | Year, keyword, PDF, OA filters exercised | Code availability filter missing |
| Multiple origins | Add origin control observed, not exercised | Up to three origins, graph and library workflows exercised | Our behavior verified; reference parity unverified |
| Exports | Download control observed, not exercised | Actual BibTeX/CSV/JSON downloads parsed | Our exports work; relative superiority unmeasured |
| Saved library | Save controls observed, not exercised | Browser-local persistence and concurrent-tab saves tested | No account or cloud sync; not equivalent to reference accounts |
| Versions/fullscreen | Menu controls observed | Not implemented as product features | Remaining parity gaps |
| Phone layout | 390px viewport, graph page width 878px, cramped left list | 390px page width 390px, graph/papers/details tabs | Clear improvement in inspected layout, not every physical device |
| Open implementation | Private algorithm/backend unavailable | MIT app, OpenAlex metadata CC0, separate S2 API/data terms, formula, provenance and JSON | Inspectable/self-hostable by design |

The new graph is often dense: 694 Attention edges and 780 CRISPR edges, compared with 300 line elements in the captured reference example. Preserving every positive-evidence edge avoids inventing relationships but does not yet reproduce the reference's clustering/edge-pruning behavior.

## Recommendation Agreement

This historical ranking measurement used the bundled **OpenAlex** graph. Semantic Scholar has since been added as a selectable official API provider; its live ranking agreement has not been measured because anonymous access was throttled and no key is configured. Existing agreement figures must not be presented as Semantic Scholar results.

Same nominal starting paper: Attention Is All You Need. Identity discrepancies below make this especially unsuitable as a calibrated quality benchmark.

| Measure | Result |
| --- | --- |
| Captured reference graph | 41 nodes / 41 unique normalized titles |
| Open Papers graph | 40 nodes / 39 unique normalized titles |
| Unique-title intersection | **11** |
| Recall of captured titles | **26.83%** (11/41) |
| Jaccard title-set agreement | **15.94%** (11/69) |
| Reference recall excluding origin | **25.00%** (10/40) |
| Reference titles present anywhere in local pool | 24/41 |
| Reference titles absent from local pool | 17/41 |

Normalization: Unicode NFKD, remove combining marks, lowercase, remove non-letter/non-number characters. No fuzzy matching or invented aliases. Duplicate ViT preprint/publication records consume two Open Papers slots, matching only one unique reference title.

Shared titles include BERT, ViT, ResNet, GPT-3, GLUE, relative-position self-attention, convolutional sequence-to-sequence, DETR, ImageNet and Google's neural machine translation, plus the origin. Plausible local additions include ELMo, T5, SentencePiece, Transformer-XL and Sparse Transformers; absence from the reference graph does not establish irrelevance.

The metrics are **agreement with one captured graph**, not research precision, scholarly recall, user relevance, or proof the reference is correct. Changing score coefficients to maximize one reference capture would be overfitting, not a demonstrated improvement.

The local origin pool contains 244 candidates; the reference's public documentation describes approximately 50,000 analyzed candidates, approximately 205 times larger. That public number is not a measured per-example candidate count. Retrieval is the first major gap: scoring cannot recover the 17 reference titles absent from the pool.

## Data Integrity

Independent live OpenAlex requests reproduced conflicting metadata. ArXiv and publisher HTML checks found:

- The 2017 Attention seed DOI resolved to a provider record with year 2025 and a different canonical DOI.
- A returned HISTORIAE title has a landing page/authors matching RoBERTa.
- A returned tutoring title has a DOI/publisher identity matching MizAR 60 for Mizar 50.
- A returned 2026 AutoResearch title links to a different 2022 material-design publication.

The same fields occur in saved raw provider responses. This establishes a provider/source inconsistency for those fields, not why it happened or whether all reported citations are false. No verified replacement work ID was found within the bounded investigation.

`data/integrity-audit.json` retains projected authoritative observations and URLs. The app preserves returned records, displays conflicts, and refuses to publish new seed-conflicting snapshots. Known audited non-seed conflicts are also disclosed while the record still matches the audit. Graph arithmetic is tested; that does not independently validate upstream scholarly identities or every citation relationship.

**Do not use the affected graph as an authoritative bibliography without checking publications.** Correct entity resolution and larger validated neighborhoods are prerequisites for a stronger research-quality claim.

## Performance And Size

The reviewed Docker production build served valid API/SPA routes under its default command and non-root UID, with same-origin fonts and no external browser requests during offline operation. It was cleaned up without altering unrelated Docker resources.

Single localhost API samples in that container:

| Graph | Fresh Snapshot Response | Warm Cache Response |
| --- | --- | --- |
| Attention | 51.27 ms | 17.92 ms |
| CRISPR | 32.86 ms | 11.83 ms |
| Gravitational waves | 49.01 ms | 18.98 ms |

These are single offline localhost measurements, not averages, live-neighborhood build time, internet latency, or comparisons against Connected Papers server speed.

The captured reference JS artifact is 2,761,244 uncompressed bytes. The final Open Papers build is 423,904 bytes, about **84.65% smaller** after runtime schema validation and integrity/CSP hardening. The Docker timing run used the slightly earlier 423,693-byte build. Regenerate exact bytes with the script below after changes. This is JS-artifact size only, not total transfer size, functional equivalence or measured overall speed. Fonts, CSS, JSON and compression differ.

## Verification

- 34 backend tests cover formulas, data boundaries, cache expiration, real-operation cancellation, deduplicated consumers, provider queues, live re-origining and integrity notices.
- 17 real-browser E2E tests cover normal workflows, actual exports, concurrent saved-library writes, malformed storage and desktop/phone/tablet layouts.
- Production build/typecheck and actual Docker default startup verified.
- Page-level horizontal overflow absent in inspected 1440px/390px captures and the broader E2E layouts. Tables may scroll inside their own contained region.
- Browser/assistive-technology testing is limited to local Chrome and keyboard checks. Screen reader and physical-device behavior remain unverified.
- Final browser suite explicitly checks `securitypolicyviolation` events. Zod validation runs in JIT-less mode under the strict script policy; the earlier caught capability probe no longer produces violations.

## Highest-Value Next Work

1. Resolve and validate publication identities across preprints/publisher versions before scoring.
2. Expand candidate and citing populations with pagination, second-order neighborhoods, date/citation stratification and durable quota management.
3. Hydrate commonly referenced unresolved IDs for better prior-work coverage.
4. Evaluate support-aware co-citation normalization and edge pruning on multiple human-labeled seeds, not one captured reference.
5. Add optional authenticated cross-device libraries, graph versions, and code-availability metadata if full product parity is required.

## Reproduce And Inspect

```sh
npx tsx scripts/compare-reference.ts /tmp/opencode/connectedpapers-research-20261013/graph.focused.json
```

Add the absolute path of a current `dist/assets/index-*.js` file as a second argument to report artifact bytes. The script reads saved evidence and local data only, never calls Connected Papers.

Full comparison inputs and intermediate measurements: `/tmp/opencode/connectedpapers-research-20261013/comparison-metrics.json`. Its early source/bundle hashes describe that earlier build, not later lifecycle hardening; the snapshot and ranking formula have not changed. Reviewed deployment/screenshots: `/tmp/opencode/open-papers-final-qa/`. Test artifacts: `test-results/`.

Reference desktop/mobile captures and REA evidence IDs are indexed in [`RESEARCH.md`](RESEARCH.md). Temporary evidence is local, not bundled proprietary material or an automatically published repository.
