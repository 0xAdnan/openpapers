# Open Papers

An independent, MIT-licensed literature-discovery application inspired by the public Connected Papers workflow. React frontend, Express backend, selectable OpenAlex or Semantic Scholar data, and transparent reference-based similarity graphs. No Connected Papers private API, proprietary source, login, analytics, or paid graph limits.

**Status: working research-tool foundation, not a verified ranking-equivalent replacement.** The comparison uncovered upstream identity/metadata conflicts. They are displayed prominently, preserved in an audit, and block publication of a replacement snapshot until resolved. Verify source publications before citing.

## Run

Requires Node.js 22.19+ and npm.

```sh
npm ci
npm run dev
```

Open `http://localhost:5173`. The API runs on `http://127.0.0.1:3001`.

Production:

```sh
npm run build
npm start
```

Open `http://127.0.0.1:3001`. Express serves the built frontend and API together. Route reloads work without another web server.

Guaranteed offline provider operation:

```sh
OFFLINE=1 npm run dev
```

The three bundled examples and their local search/re-origining work offline. Loading the frontend for the first time still requires the local server. This is not an installed PWA with service-worker offline navigation.

## Features

- Choose OpenAlex or Semantic Scholar; search titles, keywords, DOI, and provider paper IDs with autocomplete and pagination. Semantic Scholar also resolves arXiv identifiers.
- Reproducible examples for Transformers, CRISPR/Cas9, and gravitational waves.
- Force-directed SVG graphs, publication-year colors, citation-scaled sizes, origin markers, weighted edges, selection paths, dragging, pan, and zoom.
- Prior works, derivative works, sortable paper tables, abstract/details and external scholarly links.
- URL-persisted keyword, year, open-access, and PDF filters.
- Up to three origins in one graph; re-center on any locally known paper.
- Device-local saved library; BibTeX, formula-safe CSV, and full graph JSON exports.
- Responsive desktop workspace and mobile/tablet panels, keyboard navigation, native modal dialogs, self-hosted fonts, and reduced-motion support.
- Cached provider requests, bounded acquisition, rate limits, safe errors, security headers, and explicit provenance/coverage warnings.

## Configuration

Use environment variables in the shell or Node's supported environment-file mechanism. `.env.example` describes the keys; the app does not automatically load `.env`.

| Variable | Default | Purpose |
| --- | --- | --- |
| `OPENALEX_API_KEY` | unset | Optional server-only key for a larger OpenAlex budget |
| `S2_API_KEY` | unset | Optional server-only Semantic Scholar key; strongly recommended for live API reliability |
| `DEFAULT_PROVIDER` | `openalex` | Search default: `openalex` or `semantic-scholar` |
| `OFFLINE` | `0` | Set `1` to prohibit provider requests |
| `PORT` | `3001` | Backend port |
| `HOST` | `127.0.0.1` | Bind `0.0.0.0` when exposing through a container/reverse proxy |
| `CHROME_PATH` | `/usr/bin/google-chrome` | Browser executable for E2E tests |

Never put either key into a `VITE_*` variable or commit it. Search source is explicit in URLs and response attribution. Graphs infer their provider from canonical IDs: OpenAlex `W...` or Semantic Scholar `S2:<40 lowercase hex>`. Existing OpenAlex bookmarks and saved papers remain valid. Combined graphs must use one provider; publication identities are not silently merged across providers.

OpenAlex's free quota is IP-shared; remote failure can return matching cached/bundled OpenAlex data with warnings. Semantic Scholar failures can use only matching Semantic Scholar caches. With no S2 cache, the app returns an actionable error; it never relabels OpenAlex records as Semantic Scholar. Existing example cards remain explicitly OpenAlex.

## Semantic Scholar

Choose **Semantic Scholar** in the homepage/search source selector. To start it as the default:

```sh
DEFAULT_PROVIDER=semantic-scholar npm start
```

Request a key through the [official API page](https://www.semanticscholar.org/product/api), then provide `S2_API_KEY` through your server environment or secrets manager. Most endpoints allow anonymous access but share a throttled pool; the introductory keyed limit is one request/second. This implementation serializes requests at that pace and respects `429`/`Retry-After` without bypasses or automatic retry bursts.

The official Academic Graph API provides search, papers, references, citations, and batch metadata. Our adapter samples up to 80 origin references and 100 citing records, batch-hydrates outgoing references, and fetches common references within the 300-candidate cap. API ordering is unspecified. This is still our independent graph scorer, not Connected Papers' exact ranking. Relevance search exposes the first 1,000 matches (pages 1-50); totals are upstream approximate counts.

No S2 data snapshot is bundled. Anonymous live verification on this machine received HTTP 429, so keyed search/graph behavior has not been independently verified here. Backend contract tests use controlled upstream fixtures; browser tests verify real offline behavior and explicitly synthetic saved S2 records. Obtain a key to verify live results before claiming ranking parity.

The [Semantic Scholar API License Agreement](https://www.semanticscholar.org/product/api/license) and applicable underlying data/content licenses govern use. Semantic Scholar data is **not blanket CC0**. Source labels, provider links, JSON metadata, CSV source columns and S2 BibTeX notes retain attribution. Review applicable terms before bulk redistribution or commercial deployment.

## Method

For each candidate pair:

```text
coupling = sharedReferenceCount / sqrt(referenceCountA * referenceCountB)
coCitation = sharedSampleCiterCount / sqrt(sampleCiterCountA * sampleCiterCountB)
similarity = (coupling + coCitation) / 2
```

Zero denominators contribute zero. Only positive reference/co-citation evidence creates edges. Related-work metadata nominates candidates but never creates similarity edges. Missing data is not evidence of no relationship. See [`data/README.md`](data/README.md) and [`docs/COMPARISON.md`](docs/COMPARISON.md).

The current per-origin neighborhood is capped at 300 candidates; combined graphs are capped at 900. Connected Papers publicly describes approximately 50,000 analyzed candidates. Scores, corpus coverage, citation counts, and selected papers are not equivalent. OpenAlex citation-ranked samples can bias recommendations; Semantic Scholar's reference/citation ordering is unspecified.

## Data Refresh

```sh
npm run data:refresh
```

Acquisition records and hashes are in `data/manifest.json`. The script intentionally refuses to replace the bundled snapshot when expected seed DOI/year/title conflicts with the returned record. The current Attention seed triggers this guard; `data/integrity-audit.json` records independently checked conflicts. `data/refresh-anomalies.json` records the failed validation. A failed refresh leaves the previous snapshot intact.

Do not silently rewrite an upstream title/year to appear plausible or use a different work ID without verified identity resolution. The stored data is provider-sourced, not independently verified scholarship.

## Verify

```sh
npm test
npm run build
npm run test:e2e
```

E2E tests serve production offline on `127.0.0.1:43127`, use local Chrome, and download/parse actual exports. Normal workflows use real API responses; saved-data corruption and S2 export tests seed explicitly synthetic browser-storage fixtures. `test-results/e2e-report.json` and screenshots are generated by the suite. Tests respect the real 60 requests/minute/IP limit. Backend tests cover malformed inputs, timeouts, provider failures, source isolation, cache expiry, exact edge formulas and snapshot integrity warnings.

If local Chrome is absent, run `npx playwright install chromium` first; the tests then use Playwright's installed browser. GitHub Actions runs backend, build and browser checks without API keys.

## Project Layout

| Path | Purpose |
| --- | --- |
| `src/App.tsx`, `src/styles.css` | Screens, navigation, library, filters, exports |
| `src/components/GraphCanvas.tsx` | Independent interactive graph renderer |
| `server/` | API, provider adapter, cache, scoring, acquisition, integrity checks |
| `shared/types.ts` | Frontend/backend data contracts |
| `shared/schemas.ts` | Shared runtime validation of API and persisted data |
| `data/` | OpenAlex snapshot, provenance, and integrity audit |
| `scripts/refresh-data.ts` | Reproducible bounded acquisition |
| `tests/` | Real-browser E2E verification |
| `docs/` | Public-source research and comparison |
| `rea/` | Local-only user-added toolkit, excluded from the published app repository |

## Deployment And Privacy

Container build: `docker build -t open-papers .`, then `docker run --rm -p 3001:3001 -e OFFLINE=1 open-papers`. For live search, omit `OFFLINE=1` and supply server-only provider keys as needed. Set `DEFAULT_PROVIDER=semantic-scholar` to change the initial search source.

Use HTTPS at your reverse proxy. Rate limits and budgets are process-local; multi-instance deployments require shared enforcement. Forwarded IP headers are deliberately untrusted by default. Cache writes are bounded and atomic; mount `.cache` for persistence if desired. No authentication or cloud library sync is implemented. Clicking scholarly links sends the normal browser request to that external site. Live search terms are sent to the explicitly selected provider.

## License And Independence

Application source: [MIT](LICENSE). OpenAlex metadata: [CC0](https://creativecommons.org/publicdomain/zero/1.0/). Semantic Scholar: [API agreement](https://www.semanticscholar.org/product/api/license) and applicable underlying licenses, not CC0 by default. Roboto and dependencies retain their own licenses. Connected Papers names and local captures document comparison only; the application is not affiliated with or endorsed by Connected Papers. Source repository: https://github.com/0xAdnan/openpapers.
