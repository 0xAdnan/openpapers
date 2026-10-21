<p align="center">
  <img src="docs/logo.svg" alt="Open Papers logo" width="112" />
</p>

<h1 align="center">Open Papers</h1>

<p align="center">
  Discover research papers, explore their connections, and find their evaluation datasets.
  <br />
  <a href="https://openpapers.si">Open the app</a> ·
  <a href="https://openpapers.si/benchmarks">Explore benchmarks</a> ·
  <a href="https://github.com/0xAdnan/openpapers/issues">Report an issue</a>
</p>

---

Open Papers is an independent, open-source literature discovery tool. Search for a paper, build a graph of related research, or explore the benchmarks and datasets described in its evaluation. No account is required.

## What you can do

- **Find papers:** search by title, keyword, or DOI with fuzzy-tolerant suggestions and pagination.
- **Explore connections:** interactive graphs show related research, citation links, prior work, and derivative papers. Nodes are colored by year and sized by citation count.
- **Compare research:** start from up to three papers, re-center on another paper, and filter by keyword, year, open access, or PDF availability.
- **Discover benchmarks in both directions:** find papers mentioning a benchmark, or find source-backed benchmarks and custom evaluation suites in a selected paper.
- **Keep your reading list:** save papers locally and export BibTeX, CSV, or JSON.
- **Use it on different devices:** responsive layouts, keyboard navigation, and reduced-motion support.

## Latest improvements · October 21, 2026

### Benchmark discovery beyond a predefined list

**By benchmark**, enter any benchmark or dataset name—even a simple request such as “the benchmark is defects 4j.” Results are newest-first by default, with publication, year, access, PDF, and keyword filters. Conference-only results include workshop proceedings; published-only results exclude preprint records without excluding published papers that link to an arXiv PDF.

**By paper**, select a publication to discover named benchmarks and custom repository or project suites from its metadata, accessible full text, and verified author artifacts. There is no fixed benchmark-name catalog or paper-specific detection rule.

By-paper candidates show an evidence excerpt and a source link. Availability links come from the checked sources or verified suite artifacts; missing links are shown explicitly rather than guessed.

For example, **SPECULATE** now exposes its 19-repository evaluation suite, the Java and Django subsets, and the Respector dataset instead of returning an empty catalog match.

### Recovering missing graph connections

When indexed references are missing, graphs can recover structured references from publisher metadata and, when needed, an accessible paper PDF. Recovered references require unique identifier or title/year/author matches; conflicting or ambiguous entries are excluded.

Sparse graphs can also fall back to a verified record of the same publication in Semantic Scholar when it improves connection coverage. The graph identifies its actual source, and provider IDs are not mixed.

### Less waiting, clearer coverage

Independent graph lookups run concurrently, duplicate requests share work, and cached results avoid repeated retrieval. Optional fallback has a short time budget and an outage cooldown so it does not repeatedly hold up an otherwise usable graph.

Connection and benchmark views explain what was checked, which sources were unavailable, and where results may be incomplete. Cold requests can still take several seconds.

## What the results mean

- **A mention is not proof of use.** Benchmark search finds indexed mentions, including citations. Check the paper's evaluation before treating it as a benchmark user.
- **By-paper results are source-backed candidates, not exhaustive inventories.** Text extraction can miss unusual names or misinterpret ambiguous prose. Custom suites and their subsets can overlap.
- **Empty does not mean none.** Paywalls, scanned PDFs, unusual formatting, unlinked artifacts, and indexing gaps can hide benchmarks or connections.
- **Graphs are sampled neighborhoods, not the entire literature.** Citation-ranked sampling can favor influential papers, and missing metadata affects coverage. Durable expansion can have less reference coverage than a recovered quick graph.
- **No benchmark scores, rankings, or SOTA claims are inferred.** Always check the original publication before citing.

PDF and artifact retrieval is bounded and read-only. Downloads reject private network addresses and redirects; PDF parsing is isolated, with size, page, and time limits. Repository code and artifact commands are never executed. Offline mode uses bundled examples and previously cached data without contacting providers.

## Sources and project

Paper metadata comes primarily from **OpenAlex**, with **Semantic Scholar** for supported search and graph fallback. **Crossref**, **DataCite**, accessible PDFs, and verified author artifacts support reference recovery and benchmark discovery.

The app uses a React frontend and Express API deployed together on Vercel. Automated checks cover backend behavior, disposable PostgreSQL integration, production packaging, and browser workflows.

Found a missing result or unexpected connection? [Open an issue](https://github.com/0xAdnan/openpapers/issues) with the paper link and what you expected to see.

If Open Papers is useful to you, [star the repository](https://github.com/0xAdnan/openpapers).

## License

Source code is released under the [MIT License](LICENSE). Upstream data and API terms remain separate from the application license.
