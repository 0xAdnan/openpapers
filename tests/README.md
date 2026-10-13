# Production Browser Verification

```sh
npm run build
npm run test:e2e
```

The suite serves the production application in guaranteed offline mode at
`http://127.0.0.1:43127`, using `/usr/bin/google-chrome`. Set `CHROME_PATH` for
a different browser executable. It does not modify or stop unrelated services.

## Coverage

- Three real example graphs, SVG rendering, pointer and keyboard selection, URL reloads.
- Prior/derivative/list tables, actual response-data sorting, paper details.
- Combined keyword/year/PDF/open-access filters, clearing and URL restoration.
- Local library persistence, removal, malformed saved data, two-tab concurrent saves.
- Downloaded and parsed BibTeX, CSV and full-evidence JSON files.
- DOI/title/keyword search, autocomplete keyboard selection and pagination.
- Multiple origins, re-origining, three-origin limit and actionable errors.
- Graph zoom/fit/help, modal containment and restored opener focus.
- Desktop 1440x900, phone 390x844, tablet 834x1112 and document overflow checks.
- Runtime errors, CSP console errors, unexpected HTTP/network failures.
- Server-configured search sources, provider switching/URL propagation and S2 offline failures.
- Same-source combined graph enforcement and source-correct S2 BibTeX/CSV exports from synthetic saved records.

All normal workflow tests use actual application responses, not API or UI mocks.
Semantic Scholar live metadata is not mocked into the browser. Its offline failure
is exercised through the real backend; export/library tests use explicitly synthetic
saved S2 fixtures, not evidence of scholarly correctness.
Malformed-data testing seeds intentionally invalid local storage to verify recovery.
Backend provider stubs are separate and test error/lifecycle contracts; they do not
establish live provider ranking correctness.

Requests are paced to respect the production rate limiter rather than disabling
it for tests. Expected invalid-ID 400/404 responses are explicitly scoped; other
console/HTTP errors fail verification.

## Historical Findings

The first browser run reproduced blocked embedded fonts and lost modal opener
focus. Fonts now use same-origin files and dialogs restore focus explicitly.
Both regressions passed subsequent full runs. The original test port conflicted
with an existing Docker service; the root configuration now uses port 43127.

Artifacts are in `test-results/`: screenshots, actual downloaded exports,
`e2e-report.json`, and traces for failed cases. The folder is regenerated on runs.

Representative screenshots:

- `app-homepage-offers-three--5aa52-opening-a-40-node-SVG-graph/desktop-home.png`
- `app-paper-selection-synchr-1b6d6-ils-evidence-URL-and-reload/desktop-selected-graph.png`
- `app-responsive-390x844-eve-32b36-e-without-document-overflow/graph.png`
- `app-responsive-834x1112-ev-03f22-e-without-document-overflow/details.png`

Physical-device, assistive-technology, and cross-browser testing remain unperformed.
