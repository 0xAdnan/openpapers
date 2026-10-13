<p align="center">
  <img src="docs/logo.svg" alt="Open Papers logo" width="112" />
</p>

<h1 align="center">Open Papers</h1>

<p align="center">
  Open-source literature discovery with visual graphs of related research.
  <br />
  <a href="https://openpapers.si">Live demo</a> ·
  <a href="#run">Run locally</a> ·
  <a href="#configuration">Configuration</a>
</p>

---

Open Papers is an independent, MIT-licensed research tool: a React frontend and Express backend that search open scholarly metadata and build interactive graphs of related papers. No login, analytics, or paid limits.

If you find it useful, [star the repository](https://github.com/0xAdnan/openpapers) — it helps others discover the project.

> Data comes from upstream sources and is not independently verified. Check the source publication before citing.

## Features

- Search by title, keyword, or DOI, with fuzzy-tolerant autocomplete and pagination.
- Force-directed graphs colored by publication year and sized by citations, with pan, zoom, and selection paths.
- Prior and derivative works, sortable paper tables, and abstract/detail panels.
- Keyword, year, open-access, and PDF filters saved in the URL.
- Up to three origin papers per graph; re-center on any paper.
- Local saved library with BibTeX, CSV, and JSON exports.
- Responsive layout, keyboard navigation, and reduced-motion support.
- Works offline with three bundled example graphs.

## Run

Requires Node.js 22.19+.

```sh
npm ci
npm run dev        # http://localhost:5173 (API on :3001)
```

Production build:

```sh
npm run build
npm start          # http://127.0.0.1:3001
```

Offline mode (bundled examples only):

```sh
OFFLINE=1 npm run dev
```

Docker:

```sh
docker build -t open-papers .
docker run --rm -p 3001:3001 -e OFFLINE=1 open-papers
```

## Configuration

Set these as server environment variables. See [`.env.example`](.env.example).

| Variable | Default | Purpose |
| --- | --- | --- |
| `PAPERS_API_KEY` | unset | Optional key for a larger metadata API quota |
| `S2_API_KEY` | unset | Enables Semantic Scholar search |
| `OFFLINE` | `0` | `1` disables all provider requests |
| `PORT` | `3001` | Backend port |
| `HOST` | `127.0.0.1` | Use `0.0.0.0` behind a container or proxy |

Never expose API keys through `VITE_*` variables.

## Development

### Make Commands

```sh
make dev                 # frontend + backend, loading .env when present
make check               # backend tests, production build, then browser tests
make deploy              # frontend + API deployment; Vercel builds remotely
make deploy-prebuilt     # local Vercel build and prebuilt upload
make deploy-checked      # full verification before production deployment
make worker              # durable graph acquisition worker
make migrate             # apply database migrations explicitly
make help                # all available targets
```

The frontend and API deploy together in one Vercel project. `make deploy-frontend`
and `make deploy-backend` are aliases for that same deployment. Database migrations
are separate and never run automatically during deployment. `make push` pushes
existing commits; it does not create a commit or deploy automatically.

Run `make link` once on a new checkout and authenticate with Vercel. Override the
target with `VERCEL_SCOPE=... VERCEL_PROJECT=...`. The prebuilt workflow downloads
environment configuration under the ignored `.vercel/` directory; never publish it.

```sh
npm test               # backend tests
npm run test:e2e       # browser tests (Playwright)
npm run data:refresh   # rebuild the bundled paper snapshot
```

| Path | Purpose |
| --- | --- |
| `src/` | React app and graph renderer |
| `server/` | API, providers, cache, and scoring |
| `shared/` | Shared types, schemas, and fuzzy matching |
| `data/` | Bundled paper snapshot and provenance |
| `scripts/` | Data refresh, build, and migration scripts |
| `supabase/` | Supabase migrations and cron schedule |
| `tests/` | End-to-end and integration tests |
| `docs/` | Documentation and assets |
| `rea/` | Local-only user-added toolkit, excluded from git |

## License

Source code is released under the [MIT License](LICENSE).
