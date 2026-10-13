# Public Connected Papers Investigation

Inspected 13 October 2026 with the user-added REA repository, using a fresh isolated Chrome profile. No login, paid access, private endpoint replay, account actions, or proprietary source reuse. Server internals are not publicly recoverable from browser evidence.

## Tooling Actually Used

`rea/` was installed and built using its pinned Node/npm toolchain. Actual operations: `list-browser-targets`, `inspect-web-page`, `analyze-web-bundle`, `capture-web-screenshot`, `export-web-scripts`, `analyze-javascript-application`, and `observe-web-session`. Browser actions exercised public search and graph navigation, selected-paper details, help, list, prior works, derivative works, filters, and menu visibility.

The REA checkout's tracked worktree remained clean. Public JavaScript remains in a temporary research directory, not in this application's codebase.

## Verified Public Behavior

- Search accepts keywords/title/DOI/identifiers and exposes autocomplete, scholarly metadata and paginated results. Search states Semantic Scholar attribution.
- Graph desktop uses a paper-list / SVG graph / detail-panel workspace. The captured Attention example has 41 nodes and 300 line elements.
- Node help states size represents citations and color publication year. The graph is explicitly a similarity map, not a citation tree.
- Selecting a list paper changes details. Non-origin details expose Open graph and Add origin; mutating multi-origin actions were not exercised on the reference.
- List columns include titles, authors, year, citations, reference counts and similarity.
- Prior works counts graph citations; derivative works counts graph references. Year sorting was exercised.
- Filter controls expose keyword, year, PDF, open access and code availability. Applying reference filters and downloading exports were not exercised.
- More exposes versions, fullscreen, download and share. These workflows were not executed.
- Captured public documentation describes roughly 50,000 candidates, co-citation/bibliographic coupling, force-directed layout and shortest-path highlighting.
- Public source documentation names Semantic Scholar Paper Corpus and ODC-BY. This is the site's statement, not an independent license audit.

## Client Architecture Observations

Vue 3.5.13 and Vue Router 4.5.0 banners, Vue-scoped DOM attributes, Roboto, SVG graph rendering, and a 2,761,244-byte captured JS artifact. A Vite-style asset layout is an inference, not proof of its exact build setup. Exact graph score normalization, edge pruning, layout constants, server language, database, and deployment architecture remain unknown.

Observed routes: `/`, `/about`, `/search?q=...`, `/main/{id}/{title}/{graph|list|prior|derivative}`.

Browser-generated request metadata identified autocomplete/search, graph retrieval, versions and scholarly-link resolution under the site's production REST origin. No reference API contract or backend implementation was adopted by Open Papers. Normal navigation emitted an automatic history request and analytics; no explicit history mutation was requested or replayed.

## Reference Lock

The user requested a concrete existing-product workflow, so direct implementation was grounded in captured Connected Papers screens, its public help, and Refero's bundled typography/craft references. Live Refero MCP tools were unavailable.

| Decision | Evidence / Constraint | Rule Preserved |
| --- | --- | --- |
| White research canvas, Roboto, blue actions | Homepage/graph captures | Neutral work-tool typography; blue for actions and navigation |
| Teal graph nodes, magenta origins | Graph/help captures | Year color and origin identification, not decorative chrome |
| Desktop three-pane workspace | Graph selection capture | Scan paper list, inspect graph, read details together |
| Pill search and title-first result cards | Homepage/search captures | Search is the main entry point |
| Mobile panel navigation | User's all-device requirement plus overflow evidence | Keep every panel reachable without page overflow |
| Paper examples near entry | User's working application requirement | Genuine bundled graphs, not testimonial/marketing decoration |
| Visible integrity/coverage notice | Independently audited provider discrepancies | Never substitute appearance for data confidence |
| Keyboard nodes/native dialogs | Refero craft accessibility rules | Visible focus, containment, opener restoration, 44px graph controls |

Independent branding and copy were used. This is not a pixel clone, a reconstruction of private internals, or a claim of exact ranking parity.

## Evidence Ledger

Full local evidence root: `/tmp/opencode/connectedpapers-research-20261013/`.

| Finding | File | REA Evidence ID |
| --- | --- | --- |
| Homepage | `homepage-desktop.rea-inspect.json` | `ev_4f8db38ff1cb9b8b0be89e20111232ffe136229916d3a94af765b90237b58e23` |
| Graph | `graph-desktop.rea-inspect.json` | `ev_95a4940ccda9cb34622da38b1cc8ba0d696433fdf7595e84d29b8766ac6f46f0` |
| Algorithm documentation | `about.rea-inspect.json` | `ev_d2e7dc8050e0b9c05a018252677bb43cd6b57506e6bbbde3e83d81ba860eadb4` |
| List | `graph-list.rea-inspect.json` | `ev_9a2d50fabdb3d7bd7cfcc30713d6d3627a465ca8e9384f04a3d59c0de5d62920` |
| Prior | `graph-prior.rea-inspect.json` | `ev_cba200a4dade1ffa88a2a05980282f02ce0d23fc592c82f0b163bb97a78099e0` |
| Derivative | `graph-derivative.rea-inspect.json` | `ev_dd19c3fbc01633a56a33fdf85e9018fbdba46fd52f80c7c777d094d11bea810e` |
| Bundle | `homepage.rea-bundle.json` | `ev_64d315872bb1b8c40413acd15e43f5821fe7c0d940509dc5a4e9f759cd952b84` |

`evidence-index.json` contains 26 REA records, SHA-256 hashes, scope and limitations. `FINDINGS.md` retains the detailed observation ledger. Static semantic reconstruction reached a bounded node ceiling and is partial. Static inspection is not server execution evidence. Temporary artifacts must be preserved separately if this project is moved.
